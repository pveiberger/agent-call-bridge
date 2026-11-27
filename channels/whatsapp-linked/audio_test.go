package main

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"testing"
	"time"
)

func TestSpeechEndsOnPauseWithVariablePackets(t *testing.T) {
	input := &microphone{input: make(chan []byte, 64)}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	result := make(chan []byte, 1)
	go func() { data, _ := input.listen(ctx); result <- data }()
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
		for i := 0; i < 16000; i++ {
			samples = append(samples, float32(math.Sin(2*math.Pi*220*float64(i)/16000)*(0.35+0.15*math.Sin(float64(i)/283))))
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
