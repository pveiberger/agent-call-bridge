package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	calls "github.com/purpshell/meowcaller"
)

var errStreamUnsupported = errors.New("Streaming endpoint unavailable")

type voicePlayer interface {
	Play(calls.AudioSource)
	OnFinish(func())
	Stop()
}

// The MLow send loop pulls one frame every 60 ms. Never block its RTP clock on
// HTTP. A nil frame with no error tells meowcaller to send its own silence.
type streamSource struct {
	frames chan []float32
	played chan struct{}
}

func (s *streamSource) ReadFrame() ([]float32, error) {
	select {
	case frame, ok := <-s.frames:
		if !ok {
			return nil, io.EOF
		}
		select {
		case s.played <- struct{}{}:
		default:
		}
		return frame, nil
	default:
		return nil, nil
	}
}

// The producer owns and closes the HTTP responses.
func (*streamSource) Close() error { return nil }

func (b *bridge) openSpeech(ctx context.Context, id, text string) (io.ReadCloser, error) {
	data, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return nil, err
	}
	res, err := b.open(ctx, "POST", "/channel/speech/stream", id, "", "application/json", data)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, errStreamUnsupported
	}
	format, _, _ := strings.Cut(res.Header.Get("Content-Type"), ";")
	if res.StatusCode != http.StatusOK || format != "application/octet-stream" || res.Header.Get("X-Audio-Sample-Rate") != "24000" {
		res.Body.Close()
		return nil, errors.New("Invalid streaming speech response")
	}
	return res.Body, nil
}

func queueSpeech(ctx context.Context, body io.Reader, frames chan<- []float32) error {
	// 1,440 input samples at 24 kHz make one complete 960-sample WhatsApp
	// frame at 16 kHz. Preserve the 3:2 phase across network chunks and
	// distinguish a clean EOF from a truncated HTTP transfer.
	var raw [calls.FrameSamples * 3]byte
	received, used := 0, 0
	for {
		n, err := body.Read(raw[used:])
		if err != nil && err != io.EOF {
			return errors.New("Speech stream ended without complete audio")
		}
		received += n
		used += n
		if received > 16<<20 {
			return errors.New("Speech segment too large")
		}
		if used < len(raw) && err == nil {
			continue
		}
		if used%2 != 0 || received < 4 {
			return errors.New("Invalid PCM speech stream")
		}
		frame := make([]float32, calls.FrameSamples)
		output := 0
		for offset := 0; offset+4 <= used; offset += 6 {
			frame[output] = float32(int16(binary.LittleEndian.Uint16(raw[offset:]))) / 32768
			output++
			if offset+6 <= used {
				middle := int32(int16(binary.LittleEndian.Uint16(raw[offset+2:])))
				last := int32(int16(binary.LittleEndian.Uint16(raw[offset+4:])))
				frame[output] = float32((middle+last)/2) / 32768
				output++
			}
		}
		if output != 0 {
			select {
			case frames <- frame:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if err == io.EOF {
			return nil
		}
		used = 0
	}
}

func (b *bridge) streamReply(ctx context.Context, id, text string, player voicePlayer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	phrases := parts(text)
	if len(phrases) == 0 {
		return errors.New("Empty speech response")
	}
	first, err := b.openSpeech(ctx, id, phrases[0])
	if err != nil {
		return err // Only the very first 404 can request a buffered fallback.
	}
	source := &streamSource{frames: make(chan []float32, 8), played: make(chan struct{}, 1)}
	failed := make(chan error, 1)
	produced := make(chan struct{})
	go func() {
		defer close(produced)
		defer close(source.frames)
		body := first
		for i := range phrases {
			if i > 0 {
				next, openErr := b.openSpeech(ctx, id, phrases[i])
				if openErr != nil {
					failed <- errors.New("Next speech segment unavailable")
					return
				}
				body = next
			}
			err := queueSpeech(ctx, body, source.frames)
			body.Close()
			if err != nil {
				failed <- err
				return
			}
		}
	}()
	defer func() {
		cancel() // closes a blocked HTTP read or a full frame queue
		player.Stop()
		<-produced
	}()
	finished := make(chan struct{})
	player.OnFinish(func() { close(finished) })
	player.Play(source)
	stall := time.NewTimer(35 * time.Second)
	defer stall.Stop()
	for {
		select {
		case err := <-failed:
			return err
		case <-finished:
			select {
			case err := <-failed:
				return err
			default:
				return ctx.Err()
			}
		case <-ctx.Done():
			return ctx.Err()
		case <-source.played:
			stall.Reset(35 * time.Second)
		case <-stall.C:
			return errors.New("Audio playback stalled")
		}
	}
}
