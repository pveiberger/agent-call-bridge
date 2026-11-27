package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/polymorfa/hypermeow/types"
)

func TestCallerIsBoundToAuthenticatedSender(t *testing.T) {
	pn := types.NewJID("10000000000", types.DefaultUserServer)
	lid := types.NewJID("10000000001", types.HiddenUserServer)
	other := types.NewJID("10000000002", types.DefaultUserServer)
	ids := identities{byJID: map[types.JID]string{pn: pn.User, lid: pn.User, other: other.User}}
	dev := lid
	dev.Device = 7
	if phone(" +10000000000 ") != pn.User || !ids.matches(dev, pn) || !ids.matches(pn, types.EmptyJID) {
		t.Fatal("The configured account and its linked device should identify the same person")
	}
	if ids.matches(dev, other) || ids.matches(types.EmptyJID, pn) || ids.matches(types.NewJID(pn.User, types.GroupServer), pn) {
		t.Fatal("An unknown sender or an inconsistent call creator was accepted")
	}
}

func TestLocalBridgeTurnAndAudio(t *testing.T) {
	const secret = "local-only-qa-32-character-secret-1234"
	const reply = "Die Antwort ist vier."
	callID := uuid.NewString()
	turnID := strings.Join([]string{uuid.NewString(), uuid.NewString(), uuid.NewString()}, ".")
	// Synthesize a short PCM16 32-kHz fixture so the response must be resampled.
	source := make([]byte, 3200)
	for i := 0; i < len(source); i += 2 {
		binary.LittleEndian.PutUint16(source[i:], uint16(5000+i%200))
	}
	output := wav16(source)
	binary.LittleEndian.PutUint32(output[24:], 32000)
	binary.LittleEndian.PutUint32(output[28:], 64000)
	input := wav16(bytes.Repeat([]byte{1, 1}, 640))
	state := "reply"
	var mu sync.Mutex
	var uploadCount, pollCount, speechCount int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+secret || r.Header.Get("X-Call-Id") != callID {
			t.Error("Missing or mismatched call credentials")
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /channel/utterance":
			uploadCount++
			if _, err := uuid.Parse(r.Header.Get("X-Request-Id")); err != nil {
				t.Error("Missing request UUID")
			}
			data, _ := io.ReadAll(r.Body)
			if !bytes.Equal(data, input) || r.Header.Get("Content-Type") != "audio/wav" {
				t.Error("The utterance WAV was not preserved")
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"id": turnID})
		case "GET /channel/turn/" + turnID:
			pollCount++
			w.Header().Set("Content-Type", "application/json")
			s := state
			if pollCount == 1 {
				s = "working"
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"state": s, "text": reply})
		case "POST /channel/speech":
			speechCount++
			var q struct{ Text string }
			if json.NewDecoder(r.Body).Decode(&q) != nil || q.Text != reply {
				t.Error("Unexpected TTS request text")
			}
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(output)
		default:
			t.Errorf("Unexpected route %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	b, err := newBridge(srv.URL, secret)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	text, approval, err := b.turn(ctx, callID, input)
	if err != nil || approval || text != reply {
		t.Fatalf("Normal turn: %q, approval=%v, err=%v", text, approval, err)
	}
	pcm, err := b.speech(ctx, callID, text)
	if err != nil || len(pcm) < 1596 || len(pcm) > 1604 || bytes.Equal(pcm, make([]byte, len(pcm))) || bytes.HasPrefix(pcm, []byte("RIFF")) {
		t.Fatalf("Expected 16kHz raw mono PCM: len=%d, err=%v", len(pcm), err)
	}
	mu.Lock()
	state = "approval"
	mu.Unlock()
	_, approval, err = b.turn(ctx, callID, input)
	mu.Lock()
	defer mu.Unlock()
	if err != nil || !approval || uploadCount != 2 || pollCount != 3 || speechCount != 1 {
		t.Fatalf("Approval state: approval=%v, err=%v, request counts %d/%d/%d", approval, err, uploadCount, pollCount, speechCount)
	}
}
