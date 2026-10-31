// CUSTOM (symrho fork): the agent API's access rules and the relay to the
// control page. The page end is played by a test WebSocket client that answers
// like agentBridge.ts does.

package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testAPI is an agent API whose idea of "this machine" is loopback only, so
// the tests do not depend on the runner's interfaces.
func testAPI(cfg agentConfig) *agentAPI {
	a := newAgentAPI(cfg)
	a.isLocal = func(ip net.IP) bool { return ip != nil && ip.IsLoopback() }
	a.hostOK = func(h string) bool {
		host, _, err := net.SplitHostPort(h)
		if err != nil {
			host = h
		}
		return host == "127.0.0.1" || host == "localhost"
	}
	return a
}

func serve(a *agentAPI) *httptest.Server {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "app")
	})
	return httptest.NewServer(a.wrap(fallback))
}

// fakePage connects a bridge and answers every request with `reply`, echoing
// what it was asked into `seen`.
type fakePage struct {
	conn *websocket.Conn
	mu   sync.Mutex
	seen []bridgeRequest
}

func connectPage(t *testing.T, srv *httptest.Server, reply func(bridgeRequest) bridgeReply) *fakePage {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/bridge"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("bridge dial: %v", err)
	}
	p := &fakePage{conn: conn}
	go func() {
		for {
			var req bridgeRequest
			if err := conn.ReadJSON(&req); err != nil {
				return
			}
			p.mu.Lock()
			p.seen = append(p.seen, req)
			p.mu.Unlock()
			if reply != nil {
				_ = conn.WriteJSON(reply(req))
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close() })
	// The server registers the bridge after the upgrade; wait for it.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(srv.URL + "/api/health")
		if err == nil {
			var h struct{ ControllerConnected bool }
			_ = json.NewDecoder(resp.Body).Decode(&h)
			resp.Body.Close()
			if h.ControllerConnected {
				return p
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("bridge never registered")
	return nil
}

func do(t *testing.T, method, url, body string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v // net/http ignores a Host header; it sends req.Host
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func errCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func TestAgentStatusWithNoControlPage(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	code, out := do(t, "GET", srv.URL+"/api/status", "", nil)
	if code != 200 || out["state"] != "NO_CONTROLLER" || out["ready"] != false {
		t.Fatalf("got %d %v", code, out)
	}
	// Everything else says plainly that the page is missing.
	code, out = do(t, "POST", srv.URL+"/api/control/start", "", nil)
	if code != 503 || errCode(out) != "controller_unavailable" {
		t.Fatalf("got %d %v", code, out)
	}
}

func TestAgentRelaysToThePageAndBack(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	page := connectPage(t, srv, func(r bridgeRequest) bridgeReply {
		if r.Op == "goto" {
			return bridgeReply{ID: r.ID, OK: false, Status: 422, Error: &agentError{
				Code: "validation_failed", Message: "position must be between 0 and 1",
				Fields: json.RawMessage(`[{"field":"position","message":"must be between 0 and 1"}]`),
			}}
		}
		return bridgeReply{ID: r.ID, OK: true, Result: json.RawMessage(`{"op":"` + r.Op + `"}`)}
	})

	cases := []struct{ method, path, op string }{
		{"GET", "/api/status", "status"},
		{"GET", "/api/script", "get_script"},
		{"PUT", "/api/script", "load_script"},
		{"PATCH", "/api/script", "update_script"},
		{"GET", "/api/config", "get_config"},
		{"PATCH", "/api/config", "configure"},
		{"GET", "/api/presets", "list_presets"},
		{"POST", "/api/control/start", "start"},
		{"POST", "/api/control/pause", "pause"},
		{"POST", "/api/control/resume", "resume"},
		{"POST", "/api/control/start-over", "start_over"},
	}
	for _, c := range cases {
		body := ""
		if c.method != "GET" {
			body = `{"text":"hi"}`
		}
		code, out := do(t, c.method, srv.URL+c.path, body, nil)
		if code != 200 || out["op"] != c.op {
			t.Errorf("%s %s: got %d %v, want op %s", c.method, c.path, code, out, c.op)
		}
	}

	// The page's own status and error shape pass straight through.
	code, out := do(t, "POST", srv.URL+"/api/control/goto", `{"position":5}`, nil)
	if code != 422 || errCode(out) != "validation_failed" {
		t.Fatalf("goto: got %d %v", code, out)
	}

	// Params reach the page intact.
	page.mu.Lock()
	defer page.mu.Unlock()
	last := page.seen[len(page.seen)-1]
	if string(last.Params) != `{"position":5}` {
		t.Fatalf("params relayed as %s", last.Params)
	}
}

func TestAgentRejectsBadRequestsBeforeThePage(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	connectPage(t, srv, func(r bridgeRequest) bridgeReply {
		return bridgeReply{ID: r.ID, OK: true}
	})

	code, out := do(t, "PUT", srv.URL+"/api/script", `{not json`, nil)
	if code != 400 || errCode(out) != "invalid_json" {
		t.Errorf("bad json: %d %v", code, out)
	}
	code, out = do(t, "PUT", srv.URL+"/api/script", `["a"]`, nil)
	if code != 400 || errCode(out) != "invalid_json" {
		t.Errorf("array body: %d %v", code, out)
	}
	code, out = do(t, "PUT", srv.URL+"/api/script", `{"text":"x"}`, map[string]string{"Content-Type": "text/plain"})
	if code != 415 || errCode(out) != "unsupported_media_type" {
		t.Errorf("text/plain: %d %v", code, out)
	}
	code, out = do(t, "DELETE", srv.URL+"/api/script", "", nil)
	if code != 405 || errCode(out) != "method_not_allowed" {
		t.Errorf("delete: %d %v", code, out)
	}
	code, out = do(t, "POST", srv.URL+"/api/control/exec", `{"cmd":"ls"}`, nil)
	if code != 404 || errCode(out) != "not_found" {
		t.Errorf("unknown endpoint: %d %v", code, out)
	}
	big := `{"text":"` + strings.Repeat("a", agentMaxBody) + `"}`
	code, out = do(t, "PUT", srv.URL+"/api/script", big, nil)
	if code != 413 || errCode(out) != "too_large" {
		t.Errorf("oversized: %d %v", code, out)
	}
}

func TestAgentRefusesCrossOriginAndForeignHosts(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	code, out := do(t, "GET", srv.URL+"/api/status", "", map[string]string{"Origin": "https://evil.example"})
	if code != 403 || errCode(out) != "forbidden_origin" {
		t.Errorf("cross-origin: %d %v", code, out)
	}
	// DNS rebinding: a request from this machine whose Host is someone
	// else's name.
	code, out = do(t, "GET", srv.URL+"/api/status", "", map[string]string{"Host": "evil.example"})
	if code != 403 || errCode(out) != "forbidden_host" {
		t.Errorf("foreign host: %d %v", code, out)
	}
}

func TestAgentRefusesOtherMachinesWithoutLANMode(t *testing.T) {
	a := testAPI(agentConfig{})
	a.isLocal = func(net.IP) bool { return false } // every caller is "remote"
	srv := serve(a)
	defer srv.Close()
	code, out := do(t, "GET", srv.URL+"/api/status", "", nil)
	if code != 403 || errCode(out) != "forbidden" {
		t.Errorf("remote: %d %v", code, out)
	}
	// The bridge is this-machine-only whatever the configuration.
	resp, err := http.Get(srv.URL + "/api/bridge")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("remote bridge: %d", resp.StatusCode)
	}
}

func TestAgentTokenAuth(t *testing.T) {
	a := testAPI(agentConfig{token: "s3cret", allowLAN: true})
	a.isLocal = func(net.IP) bool { return false }
	srv := serve(a)
	defer srv.Close()
	for _, h := range []map[string]string{
		nil,
		{"Authorization": "Bearer wrong"},
		{"Authorization": "s3cret"},
	} {
		code, out := do(t, "GET", srv.URL+"/api/status", "", h)
		if code != 401 || errCode(out) != "unauthorized" {
			t.Errorf("%v: %d %v", h, code, out)
		}
	}
	code, out := do(t, "GET", srv.URL+"/api/status", "", map[string]string{"Authorization": "Bearer s3cret"})
	if code != 200 || out["state"] != "NO_CONTROLLER" {
		t.Errorf("good token: %d %v", code, out)
	}
}

func TestAgentTokenWithoutLANStillLocalOnly(t *testing.T) {
	a := testAPI(agentConfig{token: "s3cret"})
	a.isLocal = func(net.IP) bool { return false }
	srv := serve(a)
	defer srv.Close()
	code, out := do(t, "GET", srv.URL+"/api/status", "", map[string]string{"Authorization": "Bearer s3cret"})
	if code != 403 || errCode(out) != "forbidden" {
		t.Errorf("got %d %v", code, out)
	}
}

func TestAgentTimesOutASilentPage(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	page := connectPage(t, srv, nil) // never answers
	_ = page
	start := time.Now()
	code, out := do(t, "GET", srv.URL+"/api/config", "", nil)
	if code != 503 || errCode(out) != "controller_unavailable" {
		t.Fatalf("got %d %v", code, out)
	}
	if time.Since(start) > agentReplyTimeout+2*time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
}

func TestAgentNewBridgeReplacesOld(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	first := connectPage(t, srv, func(r bridgeRequest) bridgeReply {
		return bridgeReply{ID: r.ID, OK: true, Result: json.RawMessage(`{"who":"first"}`)}
	})
	_ = first
	connectPage(t, srv, func(r bridgeRequest) bridgeReply {
		return bridgeReply{ID: r.ID, OK: true, Result: json.RawMessage(`{"who":"second"}`)}
	})
	_, out := do(t, "GET", srv.URL+"/api/config", "", nil)
	if out["who"] != "second" {
		t.Fatalf("answered by %v", out["who"])
	}
}

func TestAgentLeavesTheAppAlone(t *testing.T) {
	srv := serve(testAPI(agentConfig{}))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/control")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "app" {
		t.Fatalf("non-API path was intercepted: %q", b)
	}
}
