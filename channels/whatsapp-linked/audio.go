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

func (m *microphone) listen(ctx context.Context) ([]byte, error) {
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
	heartbeat := time.NewTicker(60 * time.Millisecond)
	defer heartbeat.Stop()
	quiet := make([]byte, 2*calls.FrameSamples)
	last := time.Now()
	var preroll, recording, pending []byte
	var votes, silence int
	for {
		var frame []byte
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case frame = <-m.input:
			last = time.Now()
		case <-heartbeat.C:
			// MLow silence suppression can stop emitting frames during a pause.
			if time.Since(last) < 120*time.Millisecond {
				continue
			}
			frame = quiet
		}
		const chunk = 640 // 20 ms, mono PCM16 at 16 kHz
		pending = append(pending, frame...)
		for len(pending) >= chunk {
			part := pending[:chunk]
			pending = pending[chunk:]
			voiced, err := d.Process(16000, part)
			if err != nil {
				return nil, err
			}
			if recording == nil {
				preroll = append(preroll, part...)
				if len(preroll) > 12*chunk {
					preroll = preroll[chunk:]
				}
				if voiced {
					votes++
				} else {
					votes = max(0, votes-1)
				}
				if votes >= 3 {
					recording = append([]byte(nil), preroll...)
				}
				continue
			}
			recording = append(recording, part...)
			if voiced {
				silence = 0
			} else {
				silence++
			}
			if silence >= 43 || len(recording) >= 45*32000 {
				return wav16(recording), nil
			}
		}
	}
}

func parts(s string) []string {
	r := []rune(strings.TrimSpace(s))
	var out []string
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

func conversation(ctx context.Context, call *calls.Call, b *bridge) error {
	input := &microphone{input: make(chan []byte, 16)}
	call.Receive(calls.SinkFunc(input.put))
	player := calls.NewPlayer()
	call.Subscribe(player)
	id := uuid.NewString()
	say := func(text string) error {
		for _, part := range parts(text) {
			pcm, err := b.speech(ctx, id, part)
			if err != nil {
				return err
			}
			done := make(chan struct{})
			player.OnFinish(func() { close(done) })
			player.Play(calls.PCMStream(io.NopCloser(bytes.NewReader(pcm))))
			deadline := time.NewTimer(35*time.Second + time.Duration(len(pcm))*time.Second/32000)
			select {
			case <-done:
				deadline.Stop()
			case <-ctx.Done():
				deadline.Stop()
				return ctx.Err()
			case <-deadline.C:
				return errors.New("Audio playback timed out")
			}
		}
		select {
		case <-time.After(350 * time.Millisecond):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := say("Hallo, du kannst jetzt sprechen."); err != nil {
		return err
	}
	for {
		wav, err := input.listen(ctx)
		if err != nil {
			return err
		}
		turn, cancel := context.WithTimeout(ctx, 6*time.Minute)
		text, approval, err := b.turn(turn, id, wav)
		cancel()
		if err != nil || approval {
			if ctx.Err() == nil {
				_ = say("Bitte öffne den Chat deines Assistenten, um den nächsten Schritt zu prüfen.")
			}
			return err
		}
		if err := say(text); err != nil {
			return err
		}
	}
}
