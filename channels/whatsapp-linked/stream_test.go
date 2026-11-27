package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"testing/iotest"
	"time"

	calls "github.com/purpshell/meowcaller"
)

// Pull through the same nonblocking AudioSource interface as the MLow player.
type testPlayer struct {
	source chan calls.AudioSource
	finish func()
}

func (p *testPlayer) OnFinish(f func())        { p.finish = f }
func (p *testPlayer) Play(s calls.AudioSource) { p.source <- s }
func (*testPlayer) Stop()                      {}

func nextAudio(t *testing.T, source calls.AudioSource) ([]float32, error) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frame, err := source.ReadFrame()
		if frame != nil || err != nil {
			return frame, err
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Player did not receive audio or EOF")
	return nil, nil
}

func TestStreamStartsBeforeHTTPCompletesAndNeverBlocksSender(t *testing.T) {
	release := make(chan struct{})
	first := make([]byte, 3*calls.FrameSamples)
	for off := 0; off < len(first); off += 2 {
		binary.LittleEndian.PutUint16(first[off:], 9000)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct{ Text string }
		if r.URL.Path != "/channel/speech/stream" || r.Method != http.MethodPost ||
			r.Header.Get("Authorization") != "Bearer private-test" || r.Header.Get("X-Call-Id") != "test-call" ||
			json.NewDecoder(r.Body).Decode(&payload) != nil || payload.Text != "Antwort." {
			t.Error("Wrong stream request")
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Audio-Sample-Rate", "24000")
		w.Write(first[:3])
		w.(http.Flusher).Flush()
		w.Write(first[3:])
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Write([]byte{1, 0, 3, 0, 5, 0})
	}))
	defer srv.Close()
	b := &bridge{base: srv.URL, secret: "private-test", http: srv.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p := &testPlayer{source: make(chan calls.AudioSource, 1)}
	done := make(chan error, 1)
	go func() { done <- b.streamReply(ctx, "test-call", "Antwort.", p) }()
	source := <-p.source
	frame, err := nextAudio(t, source)
	if err != nil || len(frame) != calls.FrameSamples || frame[0] != float32(9000)/32768 {
		t.Fatal("First streamed sound missing")
	}
	if f, e := source.ReadFrame(); f != nil || e != nil {
		t.Fatal("Underflow should yield silence and let RTP continue")
	}
	close(release)
	frame, err = nextAudio(t, source)
	if err != nil || frame[0] != float32(1)/32768 || frame[1] != float32(4)/32768 || frame[2] != 0 {
		t.Fatal("Last resampled frame was corrupted")
	}
	if _, err = nextAudio(t, source); err != io.EOF {
		t.Fatal("Missing clean EOF")
	}
	p.finish()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestStreamConversionForOneByteReadsMatchesWAVAcrossFrames(t *testing.T) {
	raw := make([]byte, 2*(3*calls.FrameSamples+2))
	for i := 0; i < len(raw)/2; i++ {
		binary.LittleEndian.PutUint16(raw[2*i:], uint16(int16(i*83-25000)))
	}
	wav := wav16(raw)
	binary.LittleEndian.PutUint32(wav[24:], 24000)
	binary.LittleEndian.PutUint32(wav[28:], 48000)
	want, err := decodeWav(wav)
	if err != nil {
		t.Fatal(err)
	}
	frames := make(chan []float32, 8)
	if err := queueSpeech(t.Context(), iotest.OneByteReader(bytes.NewReader(raw)), frames); err != nil {
		t.Fatal(err)
	}
	close(frames)
	var got []float32
	for f := range frames {
		got = append(got, f...)
	}
	if len(got) != (len(want)/2+calls.FrameSamples-1)/calls.FrameSamples*calls.FrameSamples {
		t.Fatal("Unexpected output length")
	}
	for i, s := range got {
		var expected float32
		if 2*i < len(want) {
			expected = float32(int16(binary.LittleEndian.Uint16(want[2*i:]))) / 32768
		}
		if s != expected {
			t.Fatalf("Mismatch at sample %d: got %v, expected %v", i, s, expected)
		}
	}
	for _, bad := range [][]byte{nil, {1, 2, 3}, append(raw, 1)} {
		frames = make(chan []float32, 8)
		if err := queueSpeech(t.Context(), bytes.NewReader(bad), frames); err == nil {
			t.Error("Malformed PCM accepted")
		}
	}
}

func TestOnlyInitial404AllowsReplayAndCancelStopsHTTP(t *testing.T) {
	var requests atomic.Int32
	httpEnded := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch requests.Add(1) {
		case 1, 3:
			w.WriteHeader(404)
		case 2:
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Audio-Sample-Rate", "24000")
			w.Write(make([]byte, 3*calls.FrameSamples))
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Audio-Sample-Rate", "24000")
			w.Write(make([]byte, 3*calls.FrameSamples))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(httpEnded)
		}
	}))
	defer srv.Close()
	b := &bridge{base: srv.URL, secret: "private-test", http: srv.Client()}
	p := &testPlayer{source: make(chan calls.AudioSource, 1)}
	if err := b.streamReply(t.Context(), "id", "Hallo.", p); !errors.Is(err, errStreamUnsupported) {
		t.Fatal("Initial 404 should permit buffered fallback")
	}
	if len(p.source) != 0 {
		t.Fatal("Playback should not start on initial 404")
	}
	// If the backend disappears after a first phrase has begun, never replay it.
	err := b.streamReply(t.Context(), "id", "Dieser erste Satz ist lang genug. Noch mehr.", p)
	if err == nil || errors.Is(err, errStreamUnsupported) {
		t.Fatal("Later 404 should be a terminal stream error")
	}
	<-p.source
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.streamReply(ctx, "id", "Hallo.", p) }()
	source := <-p.source
	if _, err := nextAudio(t, source); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || errors.Is(err, errStreamUnsupported) {
			t.Fatal("Canceled call should terminate")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Cancellation did not release player")
	}
	select {
	case <-httpEnded:
	case <-time.After(2 * time.Second):
		t.Fatal("HTTP response remained open")
	}
}
