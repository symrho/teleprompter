package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

var upgrader = websocket.Upgrader{
	// The frontend is served from the same origin, so the default
	// same-origin check is exactly what we want. Returning true here
	// would be required only for cross-origin clients.
	CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == "" ||
			r.Header.Get("Origin") == "http://"+r.Host ||
			r.Header.Get("Origin") == "https://"+r.Host
	},
}

// clientEnvelope is decoded as raw fields (rather than a fixed struct) so
// the server can add "from" and relay everything else — "kind",
// "description", "candidate" — completely untouched. It still never
// interprets the SDP/ICE payload itself, only routes on "to".

// Server -> client control envelopes. Kept as separate small structs
// (rather than one do-everything struct) so each only carries the fields
// it needs.
type msgKind struct {
	Kind string `json:"kind"`
}

type msgPeerEvent struct {
	Kind string `json:"kind"`
	From string `json:"from"`
}

type msgViewerList struct {
	Kind  string   `json:"kind"`
	Peers []string `json:"peers"`
}

type msgWelcome struct {
	Kind       string      `json:"kind"`
	ID         string      `json:"id"`
	ICEServers []iceServer `json:"iceServers"`
}

func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Fatalf("encode: %v", err) // programmer error: v must always be JSON-marshalable
	}
	return b
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}

	var rl role
	switch r.URL.Query().Get("role") {
	case "controller":
		rl = roleController
	case "viewer":
		rl = roleViewer
	default:
		http.Error(w, "role must be controller or viewer", http.StatusBadRequest)
		return
	}

	// The control key is what separates "can watch this room" from "can
	// drive it", so a controller has to bring one. Rejected before the
	// upgrade, where a plain HTTP status is still possible.
	key := r.URL.Query().Get("key")
	if rl == roleController && key == "" {
		http.Error(w, "controller requires a key", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	p, err := h.join(roomName, rl, key, conn)
	if errors.Is(err, errBusy) {
		// 1013 "try again later". No new message kind: a client that does not
		// know about it just sees the socket close and retries, as it does for
		// any dropped connection.
		log.Printf("room %s: refused a %s, server at its limits", roomName, rl)
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "server busy"),
			time.Now().Add(writeWait))
		conn.Close()
		return
	}
	if err != nil {
		log.Printf("room %s: control denied", roomName)
		_ = conn.WriteMessage(websocket.TextMessage, encode(msgKind{Kind: "denied"}))
		conn.Close()
		return
	}
	log.Printf("room %s: %s %s joined", roomName, rl, p.id)

	// Tell the peer its own id, so it can stamp/route further signaling and
	// (as the controller) address messages per viewer — and hand it the ICE
	// servers, TURN credentials included, which is why this is the only place
	// they are issued: to a peer the hub has accepted, not to whoever asks.
	//
	// Written straight to the socket rather than queued on p.send, because
	// join has already queued the viewer-list or peer-joined that makes the
	// client build its peer connections, and the servers must be known by
	// then. Safe as the one writer: writePump, which owns every later write,
	// has not started yet.
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := conn.WriteMessage(websocket.TextMessage, encode(msgWelcome{Kind: "welcome", ID: p.id, ICEServers: h.ice()})); err != nil {
		h.leave(p)
		conn.Close()
		return
	}

	go p.writePump()
	p.readPump(h)
}

// readPump reads messages from the websocket and relays them to their
// addressed peer. It runs on the connection's own goroutine and owns all
// reads.
func (p *peer) readPump(h *hub) {
	defer func() {
		// leave closes p.done, which stops writePump; p.send itself is
		// never closed, since senders write to it without the room lock.
		h.leave(p)
		p.conn.Close()
		log.Printf("room %s: %s %s left", p.room.name, p.role, p.id)
	}()

	p.conn.SetReadLimit(64 * 1024)
	_ = p.conn.SetReadDeadline(time.Now().Add(pongWait))
	p.conn.SetPongHandler(func(string) error {
		return p.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, msg, err := p.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("read: %v", err)
			}
			return
		}

		var env map[string]json.RawMessage
		var to string
		if err := json.Unmarshal(msg, &env); err != nil {
			log.Printf("room %s: ignoring malformed message", p.room.name)
			continue
		}
		if toRaw, ok := env["to"]; !ok || json.Unmarshal(toRaw, &to) != nil || to == "" {
			log.Printf("room %s: ignoring untargeted message", p.room.name)
			continue
		}

		// The client only knows who it's addressing, not who it is — stamp
		// the sender so the recipient can route this to the right
		// per-peer RTCPeerConnection. Every other field (kind, description,
		// candidate) is relayed completely untouched.
		env["from"], _ = json.Marshal(p.id)
		out, err := json.Marshal(env)
		if err != nil {
			log.Printf("room %s: re-encoding signal: %v", p.room.name, err)
			continue
		}
		p.room.sendTo(to, out)
	}
}

// writePump serializes all writes to the websocket (gorilla allows only
// one concurrent writer) and sends periodic pings to keep the connection
// alive.
func (p *peer) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-p.done:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			_ = p.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		case msg := <-p.send:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
