package main

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestSpeechEndsOnPauseWithVariablePackets(t *testing.T) {
	input := &microphone{input: make(chan []byte, 64)}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	result := make(chan []byte, 1)
	go func() { data, _ := input.listen(ctx, time.Minute); result <- data }()
	for !input.active.Load() {
		select {
		case <-ctx.Done():
			t.Fatal("Microphone did not become ready")
		case <-time.After(time.Millisecond):
		}
	}
	var samples []float32
	if file := os.Getenv("LINKED_TEST_AUDIO"); file != "" {
		wav, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		pcm, err := decodeWav(wav)
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < len(pcm); i += 2 {
			samples = append(samples, float32(int16(binary.LittleEndian.Uint16(pcm[i:])))/32768)
		}
	} else {
		for i := range 50 {
			samples = append(samples, voiceFrame(i)...)
		}
	}
	// Meowcaller's playout aligns frames to actual RTP timestamps.
	// Pieces can be shorter than a VAD frame and end on odd boundaries.
	for i := 0; i < len(samples); {
		size := min(297, len(samples)-i)
		input.put(samples[i : i+size])
		i += size
		time.Sleep(time.Millisecond)
	}
	// A DTX peer sends no packets at all after the last voiced frame.
	select {
	case wav := <-result:
		if len(wav) <= 44+16000 || string(wav[:4]) != "RIFF" {
			t.Fatal("Expected one complete spoken WAV")
		}
		if input.active.Load() {
			t.Fatal("Microphone remained active after utterance")
		}
	case <-ctx.Done():
		t.Fatal("Silence did not finish the utterance")
	}
}

func TestSilentCallEndsAtThirtySeconds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mic := &microphone{input: make(chan []byte, 16)}
		spoken := 0
		done := make(chan error, 1)
		go func() {
			done <- runTurns(t.Context(), mic, incomingGreeting, func(string) error { spoken++; return nil }, func(context.Context, []byte) (string, callAction, error) {
				t.Error("Silence sent a turn to the assistant")
				return "", "", nil
			})
		}()
		synctest.Wait()
		time.Sleep(29 * time.Second)
		mic.put(make([]float32, 960))
		synctest.Wait()
		if !mic.active.Load() {
			t.Fatal("Call ended early")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if err := <-done; err != nil || spoken != 1 || mic.active.Load() {
			t.Fatal("Silent call did not hang up after the greeting")
		}
	})
}

func voiceFrame(seq int) []float32 {
	frame := make([]float32, 320)
	for i := range frame {
		seconds := float64(seq*len(frame)+i) / 16000
		envelope := 0.04 + 0.96*math.Pow(math.Sin(2*math.Pi*3*seconds), 2)
		phase := 2 * math.Pi * (160*seconds + 0.35*math.Sin(2*math.Pi*4*seconds))
		// The harmonics and the moving vowel envelope represent a syllable.
		frame[i] = float32(0.22 * envelope * (math.Sin(phase) + 0.6*math.Sin(4*phase) + 0.65*math.Sin(8*phase) + 0.35*math.Sin(11*phase)))
	}
	return frame
}

func TestActiveConversationBeyondTwoHoursAndSpeechAtGraceDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mic := &microphone{input: make(chan []byte, 16)}
		start := time.Now()
		var submissions, prompts atomic.Int32
		done := make(chan error, 1)
		go func() {
			done <- runTurns(t.Context(), mic, incomingGreeting, func(text string) error {
				if text == presencePrompt {
					prompts.Add(1)
				}
				return nil
			}, func(_ context.Context, wav []byte) (string, callAction, error) {
				if len(wav) < 44+8000 || mic.active.Load() {
					t.Error("Expected speech WAV and muted input while processing")
				}
				submissions.Add(1)
				time.Sleep(90 * time.Second) // agent processing is outside the listening window
				if submissions.Load() == 1 {
					return "Ich bleibe dran.", holdCall, nil
				}
				return "Verstanden.", "", nil
			})
		}()
		synctest.Wait()
		for turn := 0; turn < 66; turn++ {
			if turn == 1 {
				time.Sleep(5 * time.Minute)
				synctest.Wait()
				time.Sleep(30*time.Second - 100*time.Millisecond)
			} else {
				time.Sleep(25 * time.Second)
			}
			for i := 0; i < 24; i++ {
				mic.put(voiceFrame(i))
				synctest.Wait()
				time.Sleep(20 * time.Millisecond)
			}
			time.Sleep(endSilence)
			synctest.Wait()
			if submissions.Load() != int32(turn+1) {
				t.Fatalf("Lost utterance at turn %d", turn+1)
			}
			time.Sleep(90 * time.Second)
			synctest.Wait()
		}
		if time.Since(start) < 2*time.Hour || prompts.Load() != 1 {
			t.Fatal("Long active conversation was interrupted")
		}
		time.Sleep(90 * time.Second)
		synctest.Wait()
		if prompts.Load() != 1 || <-done != nil {
			t.Fatal("A new full inactivity window should close the call")
		}
	})
}

func TestGoodbyeWaitsForPlaybackBeforeHangingUp(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mic := &microphone{input: make(chan []byte, 64)}
		done := make(chan error, 1)
		started := make(chan struct{})
		go func() {
			done <- runTurns(t.Context(), mic, incomingGreeting, func(text string) error {
				if text == "Bis dann!" {
					close(started)
					time.Sleep(3 * time.Second)
				}
				return nil
			}, func(context.Context, []byte) (string, callAction, error) {
				return "Bis dann!", endCall, nil
			})
		}()
		synctest.Wait()
		for i := range 30 {
			mic.put(voiceFrame(i))
			synctest.Wait()
			time.Sleep(20 * time.Millisecond)
		}
		<-started
		if mic.active.Load() {
			t.Fatal("Microphone reopened during farewell")
		}
		select {
		case <-done:
			t.Fatal("Call ended before playback")
		default:
		}
		time.Sleep(3 * time.Second)
		if err := <-done; err != nil || mic.active.Load() {
			t.Fatal("Farewell failed to finish call")
		}
	})
}

func TestSpeechSynthesisOverlapsPlaybackInOrder(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		first := "Der erste Satz ist lang genug."
		second := "Der zweite Satz folgt."
		var spoken []string
		start := time.Now()
		var secondRequested time.Duration
		err := speak(t.Context(), first+" "+second, func(_ context.Context, text string) ([]byte, error) {
			if text == second {
				secondRequested = time.Since(start)
			}
			time.Sleep(time.Second)
			return []byte(text), nil
		}, func(data []byte) error {
			spoken = append(spoken, string(data))
			time.Sleep(5 * time.Second)
			return nil
		})
		if err != nil || len(spoken) != 2 || spoken[0] != first || spoken[1] != second || secondRequested != time.Second {
			t.Fatalf("Speech pipeline out of order or not overlapped: %v, %v, %s", err, spoken, secondRequested)
		}
	})
}
