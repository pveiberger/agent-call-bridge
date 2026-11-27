package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	wa "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waCompanionReg"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	waLog "github.com/polymorfa/hypermeow/util/log"
	calls "github.com/purpshell/meowcaller"
	"github.com/purpshell/meowcaller/signaling"
	qr "github.com/skip2/go-qrcode"
	"google.golang.org/protobuf/proto"
)

var e164 = regexp.MustCompile(`^[1-9][0-9]{5,14}$`)

func phone(s string) string {
	return strings.TrimPrefix(strings.TrimSpace(s), "+")
}

type identities struct {
	mu    sync.RWMutex
	byJID map[types.JID]string
}

func (ids *identities) matches(sender, creator types.JID) bool {
	ids.mu.RLock()
	defer ids.mu.RUnlock()
	owner := ids.byJID[sender.ToNonAD()]
	return owner != "" && (creator.IsEmpty() || ids.byJID[creator.ToNonAD()] == owner)
}

func (ids *identities) refresh(ctx context.Context, client *wa.Client, owners []string) {
	next := make(map[types.JID]string)
	for _, owner := range owners {
		pn := types.NewJID(owner, types.DefaultUserServer)
		next[pn] = owner
		lookup, cancel := context.WithTimeout(ctx, 8*time.Second)
		lid, err := client.ResolveLID(lookup, pn)
		cancel()
		if err == nil && lid.Server == types.HiddenUserServer && !lid.IsEmpty() {
			next[lid.ToNonAD()] = owner
		}
	}
	if ctx.Err() != nil {
		return
	}
	ids.mu.Lock()
	ids.byJID = next
	ids.mu.Unlock()
}

func pair(ctx context.Context, client *wa.Client, expected string) error {
	if client.Store.ID != nil {
		if client.Store.GetJID().User != expected {
			return errors.New("Session belongs to another account")
		}
		fmt.Println("Das vorgesehene WhatsApp-Konto ist bereits gekoppelt.")
		return nil
	}
	terminal, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0)
	if err != nil {
		return errors.New("Pairing requires a private interactive terminal")
	}
	defer terminal.Close()
	eventsQR, err := client.GetQRChannel(ctx)
	if err != nil {
		return errors.New("Pairing is unavailable")
	}
	ready := make(chan struct{}, 1)
	client.AddEventHandler(func(e any) {
		if _, ok := e.(*events.Connected); ok {
			select {
			case ready <- struct{}{}:
			default:
			}
		}
	})
	if err := client.ConnectContext(ctx); err != nil {
		return errors.New("WhatsApp connection failed")
	}
	for event := range eventsQR {
		switch event.Event {
		case wa.QRChannelEventCode:
			code, err := qr.New(event.Code, qr.Low)
			if err != nil {
				return errors.New("QR encoding failed")
			}
			fmt.Fprint(terminal, "\033[2J\033[HÖffne WhatsApp auf dem zweiten Konto und wähle Verknüpfte Geräte.\n\033[30;47m", code.ToSmallString(true), "\033[0m")
		case "success":
			fmt.Fprint(terminal, "\033[2J\033[H")
		default:
			return errors.New("Pairing expired or was interrupted")
		}
	}
	select {
	case <-ready:
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(35 * time.Second):
		return errors.New("Pairing confirmation timed out")
	}
	if client.Store.GetJID().User != expected {
		return errors.New("Wrong receiving account. Unlink this device in WhatsApp and pair the dedicated account")
	}
	fmt.Println("Das vorgesehene WhatsApp-Konto wurde gekoppelt.")
	return nil
}

func run(ctx context.Context, client *wa.Client, expected string) error {
	if client.Store.ID == nil || client.Store.GetJID().User != expected {
		return errors.New("Pair the dedicated receiving account first")
	}
	bridge, err := newBridge(os.Getenv("BRIDGE_URL"), os.Getenv("BRIDGE_CHANNEL_SECRET"))
	if err != nil {
		return err
	}
	var owners []string
	for _, raw := range strings.Split(os.Getenv("LINKED_ALLOWED_CALLERS"), ",") {
		p := phone(raw)
		if !e164.MatchString(p) || p == expected {
			return errors.New("Set LINKED_ALLOWED_CALLERS to the caller's international number")
		}
		owners = append(owners, p)
	}
	callbackOwner := ""
	if os.Getenv("NOD_CALLBACKS") == "true" {
		callbackOwner = phone(os.Getenv("LINKED_CALLBACK_OWNER"))
		if callbackOwner == "" && len(owners) == 1 {
			callbackOwner = owners[0]
		}
		if !slices.Contains(owners, callbackOwner) {
			return errors.New("Choose one allowlisted LINKED_CALLBACK_OWNER")
		}
	}
	ids := &identities{byJID: make(map[types.JID]string)}
	var active sync.Mutex
	var workers sync.WaitGroup
	connected, disconnected := make(chan struct{}, 1), make(chan struct{}, 1)
	lost := make(chan struct{}, 1)
	// Hypermeow dispatches handlers in order. Stop unauthorized offers before the
	// call engine's automatic pre-accept. The Signal-authenticated sender and
	// the call creator must resolve to the same configured account.
	client.AddEventHandlerWithSuccessStatus(func(raw any) bool {
		switch event := raw.(type) {
		case *events.Connected:
			select {
			case connected <- struct{}{}:
			default:
			}
		case *events.LoggedOut:
			select {
			case lost <- struct{}{}:
			default:
			}
		case *events.Disconnected:
			select {
			case disconnected <- struct{}{}:
			default:
			}
		case *events.CallOffer:
			if event.Data == nil || !ids.matches(event.From, event.CallCreator) {
				return false
			}
			_, group, err := signaling.ParseGroupInviteSnapshot(event.Data)
			return err == nil && !group && !signaling.OfferHasVideo(event.Data)
		}
		return true
	})
	media := calls.NewClient(client)
	lifetime, stop := context.WithCancel(ctx)
	var activeMu sync.Mutex
	var stopActive context.CancelFunc
	endActive := func() {
		activeMu.Lock()
		defer activeMu.Unlock()
		if stopActive != nil {
			stopActive()
		}
	}
	media.OnIncomingCall(func(call *calls.Call) {
		_, group := call.GroupState()
		if group || call.IsVideo() || !ids.matches(call.Peer(), types.EmptyJID) || !active.TryLock() {
			go func() { _ = call.Reject() }()
			return
		}
		cctx, cancel := context.WithCancel(lifetime)
		activeMu.Lock()
		stopActive = cancel
		activeMu.Unlock()
		call.OnEnd(func(string) { cancel() })
		call.OnGroupState(func(calls.GroupCallState) { cancel() })
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer active.Unlock()
			defer func() { activeMu.Lock(); stopActive = nil; activeMu.Unlock(); cancel(); _ = call.Hangup() }()
			if cctx.Err() != nil || call.Answer() != nil {
				return
			}
			// Attach sink and player immediately. The upstream OnReady event
			// itself needs a sink and incoming audio to start playout.
			if err := conversation(cctx, call, bridge, incomingGreeting); err != nil && cctx.Err() == nil {
				fmt.Fprintln(os.Stderr, "Sprachverbindung beendet. Bitte den Assistenten-Chat prüfen.")
			}
		}()
	})
	if err := client.ConnectContext(ctx); err != nil {
		stop()
		return errors.New("WhatsApp connection failed")
	}
	if callbackOwner != "" {
		workers.Add(1)
		go func() {
			defer workers.Done()
			ticks := time.NewTicker(15 * time.Second)
			defer ticks.Stop()
			for {
				select {
				case <-lifetime.Done():
					return
				case <-ticks.C:
					if !client.IsConnected() || !active.TryLock() {
						continue
					}
					func() {
						defer active.Unlock()
						cctx, cancel := context.WithCancel(lifetime)
						activeMu.Lock()
						stopActive = cancel
						activeMu.Unlock()
						defer func() { activeMu.Lock(); stopActive = nil; activeMu.Unlock(); cancel() }()
						lookup, finish := context.WithTimeout(cctx, 10*time.Second)
						data, err := bridge.request(lookup, "POST", "/channel/callback/whatsapp-linked", "", "", "", nil, 8192)
						finish()
						var job struct{ Question string }
						if err != nil || json.Unmarshal(data, &job) != nil || strings.TrimSpace(job.Question) == "" {
							return
						}
						_ = callback(cctx, media, callbackOwner, job.Question, bridge)
					}()
				}
			}
		}()
	}
	defer func() { stop(); client.Disconnect(); workers.Wait() }()
	for {
		select {
		case <-connected:
			ids.refresh(lifetime, client, owners)
		case <-disconnected:
			endActive()
		case <-lost:
			return errors.New("Device was unlinked")
		case <-ctx.Done():
			return nil
		}
	}
}

func callback(ctx context.Context, media *calls.Client, owner, question string, b *bridge) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	timeout := time.AfterFunc(45*time.Second, cancel)
	defer timeout.Stop()
	call, err := media.Call(ctx, owner)
	if err != nil {
		return err
	}
	defer call.Hangup()
	accepted := make(chan struct{}, 1)
	call.OnEnd(func(string) { cancel() })
	call.OnGroupState(func(calls.GroupCallState) { cancel() })
	call.OnPeerAccept(func() {
		select {
		case accepted <- struct{}{}:
		default:
		}
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-accepted:
		timeout.Stop()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return conversation(ctx, call, b, "Hi, hier ist Nod. "+question)
}

func main() {
	syscall.Umask(0077)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	mode := "run"
	if len(os.Args) == 2 {
		mode = os.Args[1]
	}
	expected := phone(os.Getenv("LINKED_ACCOUNT_NUMBER"))
	if len(os.Args) > 2 || (mode != "pair" && mode != "run") || !e164.MatchString(expected) {
		fmt.Fprintln(os.Stderr, "Set LINKED_ACCOUNT_NUMBER and choose pair or run.")
		os.Exit(2)
	}
	store.DeviceProps.Os = proto.String("Assistant Call Bridge")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
	db, err := sqlstore.New(ctx, "sqlite3", "file:/session/device.db?_foreign_keys=on&_busy_timeout=5000", waLog.Noop)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to open private device database.")
		os.Exit(1)
	}
	device, err := db.GetFirstDevice(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to load linked device.")
		os.Exit(1)
	}
	client := wa.NewClient(device, waLog.Noop)
	client.ManualHistorySyncDownload = true
	client.DisableHistorySyncStorage = true
	if mode == "pair" {
		err = pair(ctx, client, expected)
	} else {
		err = run(ctx, client, expected)
	}
	client.Disconnect()
	_ = db.Close()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
