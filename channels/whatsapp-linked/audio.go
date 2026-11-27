package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/google/uuid"
	vad "github.com/maxhawkins/go-webrtcvad"
	calls "github.com/purpshell/meowcaller"
)

type microphone struct {
	active atomic.Bool
	input  chan []byte
}

func (m *microphone) put(frame []float32) {
	if !m.active.Load() || len(frame) == 0 || len(frame) > 2*calls.SampleRate {
		return
	}
	raw := make([]byte, 2*len(frame))
	for i, v := range frame {
		s := int16(math.Round(max(-1, min(1, float64(v))) * 32767))
		binary.LittleEndian.PutUint16(raw[i*2:], uint16(s))
	}
	select {
	case m.input <- raw:
	default:
	}
}

const (
	speechFrameBytes = 640 // 20 ms of mono PCM16 at 16 kHz
	endSilenceFrames = 36
	endSilence       = endSilenceFrames * 20 * time.Millisecond
	incomingGreeting = "Hi, hier ist Nod. Wie kann ich dir helfen?"
	presencePrompt   = "Bist du noch da?"
)

// A nil utterance means the caller stayed silent for the whole listening window.
func (m *microphone) listen(ctx context.Context, waitForVoice time.Duration) ([]byte, error) {
	d, err := vad.New()
	if err != nil {
		return nil, err
	}
	if err := d.SetMode(2); err != nil {
		return nil, err
	}
	for len(m.input) > 0 {
		<-m.input
	}
	m.active.Store(true)
	defer m.active.Store(false)

	idle := time.NewTimer(waitForVoice)
	defer idle.Stop()
	endpoint := time.NewTimer(endSilence)
	endpoint.Stop()
	defer endpoint.Stop()

	var preroll, recording, pending []byte
	var votes, silence int
	var lastPacket time.Time
	var onsetGrace, firstVoicedFrames bool
	var noise roomNoise
	for {
		var frame []byte
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-idle.C:
			// Allow a syllable starting at the deadline to finish confirming its onset.
			if !onsetGrace && (votes > 0 || firstVoicedFrames) && time.Since(lastPacket) < 100*time.Millisecond {
				onsetGrace = true
				idle.Reset(160 * time.Millisecond)
				continue
			}
			return nil, nil
		case <-endpoint.C:
			// MLow may stop sending packets entirely during a pause.
			return wav16(append(recording, pending...)), nil
		case frame = <-m.input:
		}
		if recording == nil && time.Since(lastPacket) > 300*time.Millisecond {
			votes = 0
			noise = roomNoise{}
			firstVoicedFrames = false
			preroll, pending = preroll[:0], pending[:0]
		}
		lastPacket = time.Now()
		pending = append(pending, frame...)
		for len(pending) >= speechFrameBytes {
			part := pending[:speechFrameBytes]
			pending = pending[speechFrameBytes:]
			vadInput, changes := noise.analyse(part, recording != nil)
			voiced, err := d.Process(calls.SampleRate, vadInput)
			if err != nil {
				return nil, err
			}
			firstVoicedFrames = voiced && noise.quiet == 0 && noise.age > 0 && noise.age < 8
			voiced = voiced && changes
			if recording == nil {
				preroll = append(preroll, part...)
				// Keep the original onset while quiet speech emerges over background noise.
				if len(preroll) > 36*speechFrameBytes {
					preroll = preroll[speechFrameBytes:]
				}
				if voiced {
					votes++
				} else {
					votes = max(0, votes-1)
				}
				if votes >= 3 {
					idle.Stop()
					recording = append([]byte(nil), preroll...)
					endpoint.Reset(endSilence)
				}
				continue
			}
			recording = append(recording, part...)
			if voiced {
				silence = 0
				endpoint.Reset(endSilence)
			} else {
				silence++
			}
			if silence >= endSilenceFrames {
				// Keep the end of the original audio. Quiet syllables can fall below VAD.
				return wav16(recording), nil
			}
			if len(recording) >= 45*32000 {
				return wav16(recording), nil
			}
		}
	}
}

func (m *microphone) nextUtterance(ctx context.Context, hold bool, say func(string) error) ([]byte, error) {
	if !hold {
		return m.listen(ctx, 30*time.Second)
	}
	wav, err := m.listen(ctx, 5*time.Minute)
	if err != nil || wav != nil {
		return wav, err
	}
	if err := say(presencePrompt); err != nil {
		return nil, err
	}
	return m.listen(ctx, 30*time.Second)
}

func parts(s string) []string {
	r := []rune(strings.TrimSpace(s))
	var out []string
	// Start a multi-sentence response with the first complete thought.
	for i := 1; i < min(200, len(r)); i++ {
		if strings.ContainsRune(".!?", r[i-1]) && unicode.IsSpace(r[i]) && i >= 25 {
			out = append(out, string(r[:i]))
			r = []rune(strings.TrimSpace(string(r[i:])))
			break
		}
	}
	for len(r) > 0 {
		end := min(450, len(r))
		if end < len(r) {
			space := 0
			for j := end; j > 0; j-- {
				if strings.ContainsRune(".!?\n", r[j-1]) && unicode.IsSpace(r[j]) {
					end = j
					space = 0
					break
				}
				if space == 0 && unicode.IsSpace(r[j-1]) {
					space = j
				}
			}
			if space > 0 {
				end = space
			}
		}
		if part := strings.TrimSpace(string(r[:end])); part != "" {
			out = append(out, part)
		}
		r = r[end:]
	}
	return out
}

// Synthesize at most one upcoming phrase while the current one plays.
func speak(ctx context.Context, text string, synthesize func(context.Context, string) ([]byte, error), play func([]byte) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type phrase struct {
		pcm []byte
		err error
	}
	audio := make(chan phrase)
	go func() {
		defer close(audio)
		for _, part := range parts(text) {
			pcm, err := synthesize(ctx, part)
			select {
			case audio <- phrase{pcm: pcm, err: err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for part := range audio {
		if part.err != nil {
			return part.err
		}
		if err := play(part.pcm); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func conversation(ctx context.Context, call *calls.Call, b *bridge, greeting string) error {
	input := &microphone{input: make(chan []byte, 16)}
	call.Receive(calls.SinkFunc(input.put))
	player := calls.NewPlayer()
	call.Subscribe(player)
	defer player.Stop()
	id := uuid.NewString()
	synthesize := func(ctx context.Context, text string) ([]byte, error) {
		return b.speech(ctx, id, text)
	}
	play := func(pcm []byte) error {
		done := make(chan struct{})
		player.OnFinish(func() { close(done) })
		player.Play(calls.PCMStream(io.NopCloser(bytes.NewReader(pcm))))
		deadline := time.NewTimer(35*time.Second + time.Duration(len(pcm))*time.Second/32000)
		defer deadline.Stop()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("Audio playback timed out")
		}
	}
	streaming := true
	say := func(text string) error {
		cached := text == presencePrompt || text == incomingGreeting
		if streaming && !cached {
			err := b.streamReply(ctx, id, text, player)
			if errors.Is(err, errStreamUnsupported) {
				streaming = false
			} else if err != nil {
				return err
			}
		}
		if cached || !streaming {
			if err := speak(ctx, text, synthesize, play); err != nil {
				return err
			}
		}
		// Keep the inbound sink muted while the last WhatsApp frames drain.
		select {
		case <-time.After(240 * time.Millisecond):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return runTurns(ctx, input, greeting, say, func(ctx context.Context, wav []byte) (string, callAction, error) {
		return b.turn(ctx, id, wav)
	})
}

func runTurns(ctx context.Context, input *microphone, greeting string, say func(string) error, submit func(context.Context, []byte) (string, callAction, error)) error {
	if err := say(greeting); err != nil {
		return err
	}
	hold := false
	for {
		wav, err := input.nextUtterance(ctx, hold, say)
		if err != nil || wav == nil {
			return err
		}
		turn, cancel := context.WithTimeout(ctx, 6*time.Minute)
		text, action, err := submit(turn, wav)
		cancel()
		if err != nil || action == needsApproval {
			if ctx.Err() == nil {
				_ = say("Bitte öffne den Chat deines Assistenten, um den nächsten Schritt zu prüfen.")
			}
			return err
		}
		if err := say(text); err != nil {
			return err
		}
		if action == endCall {
			return nil
		}
		hold = action == holdCall
	}
}
