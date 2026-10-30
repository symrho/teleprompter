// CUSTOM (symrho fork): the local agent API.
//
// The prompter's state lives in the control page, in the operator's browser —
// the server only introduces peers (see CLAUDE.md). So this API does not hold
// or mirror any state of its own. It relays each request to the open control
// page over one extra WebSocket, the *bridge*, and returns the page's answer.
// The page applies it through the same sliders and functions the operator's
// hands use, which is what keeps manual and programmatic control on one copy
// of the state.
//
// Everything is in this file, behind one wrap() in main.go, so an upstream
// merge never has to reconcile it with hub.go or signal.go.
//
// Access:
//   - With no token configured, the API answers only requests from this
//     machine (loopback, or one of this machine's own addresses), and only
//     with a Host header naming this machine — that last check is what stops
//     a web page using DNS rebinding to reach it through the browser.
//   - With a token (-api-token / TELEPROMPTER_API_TOKEN) every request must
//     carry it as a bearer token; -api-lan additionally admits other hosts.
//   - Any request with a cross-origin Origin header is refused, so a page in
//     the operator's own browser cannot drive the prompter.
//   - The bridge itself is accepted from this machine only, and never needs a
//     token, so no secret is ever handed to browser code.

package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Generous for a video script (the page refuses anything over 100k
	// characters), small enough that a mistake cannot fill memory.
	agentMaxBody = 512 << 10
	// How long a request waits for the control page to answer. The page
	// answers in a frame or two; this only bounds a page that has hung or been
	// suspended by the browser.
	agentReplyTimeout = 5 * time.Second
)

type agentConfig struct {
	// Bearer token. Empty means none is required — and then only this
	// machine may call.
	token string
	// Admit requests from other hosts (token required).
	allowLAN bool
}

// agentRoutes maps "METHOD path" to the operation the control page performs.
// A fixed table: there is no way to name an operation from the request, so
// nothing reaches the page that is not listed here.
var agentRoutes = map[string]string{
	"GET /api/status":              "status",
	"GET /api/script":              "get_script",
	"PUT /api/script":              "load_script",
	"PATCH /api/script":            "update_script",
	"GET /api/config":              "get_config",
	"PATCH /api/config":            "configure",
	"GET /api/presets":             "list_presets",
	"POST /api/control/start":      "start",
	"POST /api/control/pause":      "pause",
	"POST /api/control/resume":     "resume",
	"POST /api/control/start-over": "start_over",
	"POST /api/control/goto":       "goto",
}

type agentError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Fields  json.RawMessage `json:"fields,omitempty"`
}

// bridgeRequest is what the server sends the page.
type bridgeRequest struct {
	ID     string          `json:"id"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}

// bridgeReply is what the page answers with. Status is the HTTP status the
// page wants the caller to see (200 when omitted on success).
type bridgeReply struct {
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Status int             `json:"status,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *agentError     `json:"error,omitempty"`
}

type bridge struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan bridgeReply
	done    chan struct{}
}

type agentAPI struct {
	cfg agentConfig

	mu     sync.Mutex
	bridge *bridge
	seq    uint64

	// isLocal reports whether an IP belongs to this machine. A field so tests
	// can stand in for the machine's interfaces.
	isLocal func(net.IP) bool
	// hostOK reports whether a Host header names this machine.
	hostOK func(string) bool
}

func newAgentAPI(cfg agentConfig) *agentAPI {
	return &agentAPI{cfg: cfg, isLocal: isLocalIP, hostOK: isLocalHost}
}

// wrap serves /api/* from the agent API and everything else from next.
func (a *agentAPI) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bridge" {
			a.serveBridge(w, r)
			return
		}
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			a.serveAPI(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeAgentError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": agentError{Code: code, Message: msg},
	})
}

func remoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

// isLocalIP: loopback, or an address assigned to one of this machine's
// interfaces — which is what a page on this Mac reached by its LAN name
// connects from.
func isLocalIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// isLocalHost: the Host header names this machine — localhost, one of its IP
// addresses, or its own hostname (bare or .local, as macOS advertises it).
func isLocalHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isLocalIP(ip)
	}
	name, err := os.Hostname()
	if err != nil {
		return false
	}
	name = strings.ToLower(name)
	bare := strings.TrimSuffix(name, ".local")
	return host == name || host == bare || host == bare+".local"
}

// sameOrigin: no Origin header (curl, an agent, an MCP adapter), or one that
// matches the Host the request was sent to.
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	return o == "" || o == "http://"+r.Host || o == "https://"+r.Host
}

func (a *agentAPI) authorise(r *http.Request) (int, string, string) {
	if !sameOrigin(r) {
		return http.StatusForbidden, "forbidden_origin",
			"cross-origin requests are not accepted"
	}
	local := a.isLocal(remoteIP(r))
	if a.cfg.token != "" {
		auth := r.Header.Get("Authorization")
		given, found := strings.CutPrefix(auth, "Bearer ")
		if !found || subtle.ConstantTimeCompare([]byte(given), []byte(a.cfg.token)) != 1 {
			return http.StatusUnauthorized, "unauthorized",
				"missing or wrong bearer token"
		}
		if !local && !a.cfg.allowLAN {
			return http.StatusForbidden, "forbidden",
				"the API accepts requests from this machine only; start the server with -api-lan to allow others"
		}
		return 0, "", ""
	}
	if !local {
		return http.StatusForbidden, "forbidden",
			"the API accepts requests from this machine only; LAN access needs -api-lan and a token"
	}
	if !a.hostOK(r.Host) {
		return http.StatusForbidden, "forbidden_host",
			"the Host header must name this machine"
	}
	return 0, "", ""
}

func (a *agentAPI) serveAPI(w http.ResponseWriter, r *http.Request) {
	if status, code, msg := a.authorise(r); status != 0 {
		writeAgentError(w, status, code, msg)
		return
	}
	if r.URL.Path == "/api/health" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                  true,
			"controllerConnected": a.current() != nil,
		})
		return
	}
	op, ok := agentRoutes[r.Method+" "+r.URL.Path]
	if !ok {
		allowed := []string{}
		for k := range agentRoutes {
			if m, p, _ := strings.Cut(k, " "); p == r.URL.Path {
				allowed = append(allowed, m)
			}
		}
		if len(allowed) > 0 {
			w.Header().Set("Allow", strings.Join(allowed, ", "))
			writeAgentError(w, http.StatusMethodNotAllowed, "method_not_allowed",
				fmt.Sprintf("%s is not supported on %s", r.Method, r.URL.Path))
			return
		}
		writeAgentError(w, http.StatusNotFound, "not_found",
			"no such endpoint; see AGENT_API.md")
		return
	}

	params := json.RawMessage("{}")
	if r.Method != http.MethodGet {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, agentMaxBody))
		if err != nil {
			writeAgentError(w, http.StatusRequestEntityTooLarge, "too_large",
				fmt.Sprintf("request body is limited to %d bytes", agentMaxBody))
			return
		}
		if len(strings.TrimSpace(string(body))) > 0 {
			// Content-Type is required on a body, which also makes every write
			// a non-simple request in a browser: a form or a no-cors fetch from
			// another site cannot produce one.
			mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if mt != "application/json" {
				writeAgentError(w, http.StatusUnsupportedMediaType, "unsupported_media_type",
					"send the body as Content-Type: application/json")
				return
			}
			var probe map[string]json.RawMessage
			if err := json.Unmarshal(body, &probe); err != nil {
				writeAgentError(w, http.StatusBadRequest, "invalid_json",
					"the body must be a JSON object: "+err.Error())
				return
			}
			params = body
		}
	}

	b := a.current()
	if b == nil {
		if op == "status" {
			// Status is the one question worth answering with no page open:
			// "is the controller there?" is exactly what an agent is asking.
			writeJSON(w, http.StatusOK, map[string]any{
				"state":     "NO_CONTROLLER",
				"ready":     false,
				"connected": false,
				"readiness": []map[string]any{{
					"check": "controller", "ok": false,
					"message": "open the control page on this Mac",
				}},
			})
			return
		}
		writeAgentError(w, http.StatusServiceUnavailable, "controller_unavailable",
			"the control page is not open; open /control on this Mac")
		return
	}

	reply, err := a.call(b, op, params)
	if err != nil {
		writeAgentError(w, http.StatusServiceUnavailable, "controller_unavailable", err.Error())
		return
	}
	status := reply.Status
	if status == 0 {
		status = http.StatusOK
		if !reply.OK {
			status = http.StatusBadRequest
		}
	}
	if !reply.OK {
		e := reply.Error
		if e == nil {
			e = &agentError{Code: "error", Message: "the control page refused the request"}
		}
		writeJSON(w, status, map[string]any{"error": e})
		return
	}
	result := reply.Result
	if len(result) == 0 {
		result = json.RawMessage("{}")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(result)
}

func (a *agentAPI) current() *bridge {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.bridge
}

var errBridgeGone = errors.New("the control page disconnected")

func (a *agentAPI) call(b *bridge, op string, params json.RawMessage) (bridgeReply, error) {
	a.mu.Lock()
	a.seq++
	id := strconv.FormatUint(a.seq, 10)
	a.mu.Unlock()

	ch := make(chan bridgeReply, 1)
	b.mu.Lock()
	b.pending[id] = ch
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()

	msg, _ := json.Marshal(bridgeRequest{ID: id, Op: op, Params: params})
	b.writeMu.Lock()
	_ = b.conn.SetWriteDeadline(time.Now().Add(agentReplyTimeout))
	err := b.conn.WriteMessage(websocket.TextMessage, msg)
	b.writeMu.Unlock()
	if err != nil {
		return bridgeReply{}, errBridgeGone
	}

	timer := time.NewTimer(agentReplyTimeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r, nil
	case <-b.done:
		return bridgeReply{}, errBridgeGone
	case <-timer.C:
		return bridgeReply{}, errors.New(
			"the control page did not answer in time; is its tab open?")
	}
}

var bridgeUpgrader = websocket.Upgrader{CheckOrigin: sameOrigin}

// serveBridge accepts the control page's bridge socket. The newest bridge
// replaces any earlier one, the same rule hub.go applies to controllers: a
// refreshed control page takes over rather than being refused.
func (a *agentAPI) serveBridge(w http.ResponseWriter, r *http.Request) {
	if !a.isLocal(remoteIP(r)) {
		writeAgentError(w, http.StatusForbidden, "forbidden",
			"the bridge accepts the control page on this machine only")
		return
	}
	conn, err := bridgeUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("agent bridge upgrade: %v", err)
		return
	}
	conn.SetReadLimit(agentMaxBody * 2)
	b := &bridge{conn: conn, pending: map[string]chan bridgeReply{}, done: make(chan struct{})}

	a.mu.Lock()
	old := a.bridge
	a.bridge = b
	a.mu.Unlock()
	if old != nil {
		_ = old.conn.Close()
	}
	log.Printf("agent bridge: control page connected")

	defer func() {
		close(b.done)
		a.mu.Lock()
		if a.bridge == b {
			a.bridge = nil
		}
		a.mu.Unlock()
		_ = conn.Close()
		log.Printf("agent bridge: control page disconnected")
	}()

	// Keepalive, so a page that vanished without a close is noticed.
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(pingPeriod)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				b.writeMu.Lock()
				err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
				b.writeMu.Unlock()
				if err != nil {
					return
				}
			case <-stop:
				return
			}
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var reply bridgeReply
		if json.Unmarshal(data, &reply) != nil || reply.ID == "" {
			continue
		}
		b.mu.Lock()
		ch := b.pending[reply.ID]
		b.mu.Unlock()
		if ch != nil {
			ch <- reply
		}
	}
}

// logLANAddresses prints the addresses an iPad on the same network can use,
// since the viewer link the control page shows is built from the address the
// control page itself was opened on.
func logLANAddresses(addr string) {
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return
	}
	if name, err := os.Hostname(); err == nil {
		bare := strings.TrimSuffix(name, ".local")
		log.Printf("open the control page at http://%s.local:%s/control so the viewer link works on the iPad", bare, port)
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() {
			log.Printf("  or http://%s:%s/control", n.IP, port)
		}
	}
}
