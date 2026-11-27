package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

type bridge struct {
	base, secret string
	http         *http.Client
}

func newBridge(base, secret string) (*bridge, error) {
	if base == "" {
		base = "http://bridge:8091"
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(secret) < 32 {
		return nil, errors.New("Set the internal BRIDGE_URL and BRIDGE_CHANNEL_SECRET")
	}
	return &bridge{strings.TrimRight(base, "/"), secret, &http.Client{Timeout: 145 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (b *bridge) open(ctx context.Context, method, path, callID, requestID, contentType string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, b.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+b.secret)
	req.Header.Set("X-Call-Id", callID)
	if method == http.MethodGet && strings.HasPrefix(path, "/channel/turn/") {
		req.Header.Set("Prefer", "wait=6")
	}
	if requestID != "" {
		req.Header.Set("X-Request-Id", requestID)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := b.http.Do(req)
	if err != nil {
		return nil, errors.New("Bridge is unavailable")
	}
	return res, nil
}

func (b *bridge) request(ctx context.Context, method, path, callID, requestID, contentType string, body []byte, limit int64) ([]byte, error) {
	res, err := b.open(ctx, method, path, callID, requestID, contentType, body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("Bridge declined the request")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("Invalid bridge response")
	}
	return data, nil
}

type callAction string

const (
	holdCall      callAction = "hold_call"
	endCall       callAction = "end_call"
	needsApproval callAction = "approval"
)

func (b *bridge) turn(ctx context.Context, callID string, wav []byte) (string, callAction, error) {
	sent, err := b.request(ctx, "POST", "/channel/utterance", callID, uuid.NewString(), "audio/wav", wav, 64<<10)
	if err != nil {
		return "", "", err
	}
	var receipt struct{ ID string }
	if json.Unmarshal(sent, &receipt) != nil || receipt.ID == "" || len(receipt.ID) > 1024 || receipt.ID == "." || receipt.ID == ".." {
		return "", "", errors.New("Invalid turn ID")
	}
	path := "/channel/turn/" + url.PathEscape(receipt.ID)
	delay := 250 * time.Millisecond
	for {
		data, err := b.request(ctx, "GET", path, callID, "", "", nil, 1<<20)
		if err != nil {
			return "", "", err
		}
		var answer struct {
			State, Text, SpeechText string
			CallAction              callAction
		}
		if json.Unmarshal(data, &answer) != nil {
			return "", "", errors.New("Invalid turn state")
		}
		switch answer.State {
		case "working":
			select {
			case <-time.After(delay):
				delay = min(delay*2, time.Second)
			case <-ctx.Done():
				return "", "", ctx.Err()
			}
		case "approval":
			return "", needsApproval, nil
		case "reply":
			if strings.TrimSpace(answer.SpeechText) != "" {
				return answer.SpeechText, answer.CallAction, nil
			}
			if strings.TrimSpace(answer.Text) != "" {
				return answer.Text, answer.CallAction, nil
			}
			fallthrough
		default:
			return "", "", errors.New("Assistant returned no reply")
		}
	}
}

func (b *bridge) speech(ctx context.Context, callID, text string) ([]byte, error) {
	input, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return nil, err
	}
	wav, err := b.request(ctx, "POST", "/channel/speech", callID, "", "application/json", input, 12<<20)
	if err != nil {
		return nil, err
	}
	return decodeWav(wav)
}

func wav16(pcm []byte) []byte {
	out := make([]byte, 44+len(pcm))
	copy(out, "RIFF")
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)-8))
	copy(out[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:], 16)
	binary.LittleEndian.PutUint16(out[20:], 1)
	binary.LittleEndian.PutUint16(out[22:], 1)
	binary.LittleEndian.PutUint32(out[24:], 16000)
	binary.LittleEndian.PutUint32(out[28:], 32000)
	binary.LittleEndian.PutUint16(out[32:], 2)
	binary.LittleEndian.PutUint16(out[34:], 16)
	copy(out[36:], "data")
	binary.LittleEndian.PutUint32(out[40:], uint32(len(pcm)))
	copy(out[44:], pcm)
	return out
}

func decodeWav(wav []byte) ([]byte, error) {
	invalid := errors.New("Unsupported speech WAV")
	if len(wav) < 44 || string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		return nil, invalid
	}
	var rate int
	var pcm []byte
	for off := 12; off+8 <= len(wav); {
		size := int(binary.LittleEndian.Uint32(wav[off+4:]))
		if size > len(wav)-off-8 {
			return nil, invalid
		}
		chunk := wav[off+8 : off+8+size]
		switch string(wav[off : off+4]) {
		case "fmt ":
			if len(chunk) < 16 || binary.LittleEndian.Uint16(chunk) != 1 || binary.LittleEndian.Uint16(chunk[2:]) != 1 || binary.LittleEndian.Uint16(chunk[14:]) != 16 {
				return nil, invalid
			}
			rate = int(binary.LittleEndian.Uint32(chunk[4:]))
		case "data":
			pcm = chunk
		}
		off += 8 + size + size%2
	}
	count := len(pcm) / 2
	if rate < 8000 || rate > 96000 || count == 0 || len(pcm)%2 != 0 {
		return nil, invalid
	}
	if rate == 16000 {
		return pcm, nil
	}
	out := make([]byte, 2*(count*16000/rate))
	for i := 0; i < len(out)/2; i++ {
		n := i * rate
		j := n / 16000
		frac := n % 16000
		a := int(int16(binary.LittleEndian.Uint16(pcm[2*j:])))
		b := int(int16(binary.LittleEndian.Uint16(pcm[2*min(j+1, count-1):])))
		binary.LittleEndian.PutUint16(out[2*i:], uint16(int16((a*(16000-frac)+b*frac)/16000)))
	}
	return out, nil
}
