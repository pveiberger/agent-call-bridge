package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"testing"
	"testing/synctest"
	"time"
)

type testFan struct {
	seed   uint32
	sample int
	low    float64
}

func (fan *testFan) frame() []float32 {
	pcm := make([]float32, samplesPerFrame)
	for i := range pcm {
		fan.seed = fan.seed*1664525 + 1013904223
		white := float64(fan.seed)/(1<<31) - 1
		fan.low = 0.85*fan.low + 0.15*white
		pcm[i] = float32(0.032*math.Sin(2*math.Pi*145*float64(fan.sample)/16000) + 0.015*fan.low)
		fan.sample++
	}
	return pcm
}

func TestFanCannotExtendThePresenceDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mic := &microphone{input: make(chan []byte, 16)}
		start := time.Now()
		prompts := 0
		done := make(chan []byte, 1)
		go func() {
			wav, err := mic.nextUtterance(t.Context(), func(text string) error {
				prompts++
				if text != presencePrompt || time.Since(start) != time.Minute {
					t.Error("Fan disturbed the one-minute listening window")
				}
				time.Sleep(2 * time.Second)
				return nil
			})
			if err != nil {
				t.Error(err)
			}
			done <- wav
		}()
		fan := testFan{seed: 55}
		synctest.Wait()
		for range 92 * 50 {
			mic.put(fan.frame())
			synctest.Wait()
			time.Sleep(20 * time.Millisecond)
		}
		synctest.Wait()
		select {
		case wav := <-done:
			if wav != nil || prompts != 1 || mic.active.Load() {
				t.Fatal("Fan produced an utterance or left the microphone listening")
			}
		default:
			t.Fatal("Fan prevented hangup 30 seconds after the prompt")
		}
	})
}

func TestQuietReplyOverFanKeepsOriginalAudio(t *testing.T) {
	var voice []float32
	targetRMS := 164.0 // -46 dBFS
	if file := os.Getenv("LINKED_TEST_QUIET_REPLY"); file != "" {
		targetRMS = 82 // -52 dBFS for the recorded short reply
		wav, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		pcm, err := decodeWav(wav)
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < len(pcm); i += 2 {
			voice = append(voice, float32(int16(binary.LittleEndian.Uint16(pcm[i:])))/32768)
		}
	} else {
		voice = make([]float32, 10*samplesPerFrame)
		for i := range 13 {
			voice = append(voice, voiceFrame(i)...)
		}
		voice = append(voice, make([]float32, 13*samplesPerFrame)...)
	}
	var square, peak float64
	for _, sample := range voice {
		square += float64(sample) * float64(sample)
		peak = max(peak, math.Abs(float64(sample)))
	}
	scale := targetRMS / (32768 * math.Sqrt(square/float64(len(voice))))
	synctest.Test(t, func(t *testing.T) {
		mic := &microphone{input: make(chan []byte, 16)}
		done := make(chan []byte, 1)
		go func() {
			wav, err := mic.listen(t.Context(), 5*time.Second)
			if err != nil {
				t.Error(err)
			}
			done <- wav
		}()
		fan := testFan{seed: 55}
		var mixed []byte
		first, last := -1, 0
		synctest.Wait()
		for i := 0; i < 250; i++ {
			frame := fan.frame()
			for j := range frame {
				k := (i-70)*len(frame) + j
				if k >= 0 && k < len(voice) {
					frame[j] += float32(float64(voice[k]) * scale)
					if math.Abs(float64(voice[k])) > peak*0.035 {
						if first == -1 {
							first = len(mixed)
						}
						last = len(mixed) + 2
					}
				}
				pcm := int16(math.Round(float64(frame[j]) * 32767))
				mixed = binary.LittleEndian.AppendUint16(mixed, uint16(pcm))
			}
			mic.put(frame)
			synctest.Wait()
			time.Sleep(20 * time.Millisecond)
		}
		wav := <-done
		if len(wav) <= 44 || first < 0 || !bytes.Contains(wav[44:], mixed[first:last]) {
			t.Fatalf("Soft reply missing or clipped: captured %d bytes, speech spans %d bytes", len(wav), last-first)
		}
	})
}

func BenchmarkRoomNoise(b *testing.B) {
	var raw [speechFrameBytes]byte
	fan := testFan{seed: 55}
	for i, sample := range fan.frame() {
		binary.LittleEndian.PutUint16(raw[2*i:], uint16(int16(sample*32767)))
	}
	var r roomNoise
	b.ReportAllocs()
	for b.Loop() {
		r.analyse(raw[:], false)
	}
}
