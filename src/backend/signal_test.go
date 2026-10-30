package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"
)

// dialWS connects to a hub's /ws and returns the first message the server sent.
func dialWS(t *testing.T, h *hub, query string) map[string]any {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(h.serveWS))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/?"+query, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	var m map[string]any
	if err := c.ReadJSON(&m); err != nil {
		t.Fatalf("read: %v", err)
	}
	return m
}

// TURN credentials are only issued to a peer that has joined a room, as the
// first thing it is told. There used to be a public GET /ice that minted them
// for anyone, which was a free relay.
func TestWelcomeCarriesTheICEServers(t *testing.T) {
	h := newHub()
	h.ice = func() []iceServer {
		return []iceServer{{URLs: []string{"turn:t.example:3478"}, Username: "u", Credential: "c"}}
	}
	m := dialWS(t, h, "room=r&role=viewer")
	if m["kind"] != "welcome" {
		t.Fatalf("first message kind = %v, want welcome", m["kind"])
	}
	servers, _ := m["iceServers"].([]any)
	if len(servers) != 1 {
		t.Fatalf("iceServers = %v, want the one configured server", m["iceServers"])
	}
	if got := servers[0].(map[string]any)["credential"]; got != "c" {
		t.Errorf("credential = %v, want c", got)
	}
}

func TestICEIsNotServedOverHTTP(t *testing.T) {
	t.Setenv("TURN_URLS", "turn:t.example:3478")
	t.Setenv("TURN_SECRET", "s")
	rec := httptest.NewRecorder()
	newMux(newHub(), fstest.MapFS{}).ServeHTTP(rec, httptest.NewRequest("GET", "/ice", nil))
	if strings.Contains(rec.Body.String(), "credential") {
		t.Fatalf("GET /ice leaked credentials: %s", rec.Body.String())
	}
}
