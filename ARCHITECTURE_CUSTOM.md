# Architecture: what this fork adds

Upstream's own docs are still the reference for the base system:
[docs/architecture.md](docs/architecture.md) and [CLAUDE.md](CLAUDE.md). This
file covers what the fork changes and why. Every custom file and hook is
marked `CUSTOM (symrho fork)`.

## Upstream, in one paragraph

A **control page** (`/control`, `teleprompter.ts`) holds the script, in a
Wordgard rich-text editor, and every control. One or more **viewers**
(`/viewer`, `viewer.ts`) show it. The **Go server** serves both pages and
relays WebRTC signalling over `/ws`. It never sees the script. After
signalling, the controller and each viewer are WebRTC peers with three data
channels: `scroll` (unreliable, the position as a 0 to 1 ratio), `control`
(reliable: settings, content, theme, clock) and `file` (PDFs). The first
viewer to connect is the *driver*. It runs the scroll loop at the speed it is
given, and the controller relays its position to everyone else. All state
(documents, themes, preferences, slider values, the running flag) lives in the
control page and its localStorage.

## What the fork adds

```
 agent / curl / MCP adapter                 operator (keyboard, mouse, gamepad)
          | HTTP JSON                                  |
          v                                            v
 Go server: agentapi.go  --/api/bridge WS-->  control page (teleprompter.ts)
   (auth, routing, relay;                        |  custom/agent.ts: validate + apply
    holds no prompter state)                     |  via sliders, toggleAutoScroll,
                                                 |  themeControls.apply, sendScroll
                                                 v
                                     existing WebRTC data channels
                                                 v
                                    iPad viewer (viewer.ts, unchanged)
                                    wearing the linkedin-tmp100 theme
```

### 1. The `linkedin-tmp100` preset (`custom/tmp100.ts`, `custom/tmp100Controls.ts`)

The preset is a **generated user theme**: CSS built from a few parameters
(mirror, flip, column width in `ch`, line spacing, paragraph gap, reading-line
height, markers, alignment). It is stored through upstream's `ThemeStorage`
under the fixed slug `theme-user-linkedin-tmp100`. Because user themes already
travel to viewers as CSS in a `ThemeMessage`, and are replayed to late joiners
by `catchUpMessages`, the preset needs **no protocol change and no viewer
change**. This is the main design decision for upstream compatibility.

- The mirror is `transform: scale(-1, 1)` on `#main`, never on `#stage`,
  because `#stage`'s transform is how a display is fitted to its screen.
- `#main` is padded by the reading-line height above, and by the rest of the
  screen below. Position 0 puts the first line on the reading line, and the
  last line can reach it. The shared scroll ratio needs no adjustment.
- The clock strip becomes a zero-height sticky row that carries the reading
  markers. The clocks and the message are hidden.
- Sizes are in `cqh`/`ch`, never viewport units, for upstream's reason: every
  display lays out in the reference box.
- The parameters persist in localStorage (`teleprompter.custom.tmp100`).
  Changing them regenerates the CSS and re-applies the theme if it is showing.
- The TMP100 card is built in script and inserted after the Transport card,
  so `index.html` is untouched.

### 2. Script handling (`custom/script.ts`)

Plain text is canonical. Three things are kept apart:

- **A**: the original text.
- **B**: an optional agent-prepared text.
- **C**: presentation, meaning thought-group line breaks and how cues look.

`scriptToHtml` escapes everything and only ever adds `<p>`, `<br>` and a
coloured `<span>` for cues. The words are never altered, and a test checks
that thought groups join back into the original line. Records (A, B, C, target
WPM) are kept in localStorage (`teleprompter.custom.agent`) by document id,
since the editor has nowhere to put them. Word count and timing are computed
from the *published* HTML, which is what the displays show.

### 3. The agent API (`src/backend/agentapi.go`, `custom/agent.ts`, `custom/agentBridge.ts`)

- `agentapi.go` wraps upstream's mux in one call in `main.go`:
  `agent.wrap(newMux(h, feFS))`. It owns `/api/*` and `/api/bridge`.
  `hub.go` and `signal.go` are untouched.
- Each API request becomes `{id, op, params}` on the bridge socket. The
  operation comes from a fixed route table, so a request can't name an
  arbitrary one. The control page answers `{id, ok, status, result|error}`.
  The server waits up to 5 s.
- `custom/agent.ts` is DOM-free. It validates the request (with per-field
  errors, applying nothing unless everything is valid) and acts through
  `AgentHost`. `AgentHost` is a set of closures built in `teleprompter.ts`
  (`#agentHost`) over **existing** paths:
  - speed and text size set the two transport sliders and dispatch `input`,
    exactly as a drag does, so `#pushSettings` remains the one funnel;
  - start and pause call `toggleAutoScroll`, the Space-bar action;
  - the layout goes through `themeControls.apply`;
  - goto does what `sendMyPosition` does (`#lastRatio`, `link.sendScroll`,
    preview);
  - loading a script writes a document through a new
    `DocControls.putDocument`, which opens it through the ordinary `load`
    path, then calls `pushContent`.

  So there is no duplicated state. The API reads the same sliders and flags it
  writes, and manual changes appear in `/api/status` straight away.
- Status, READY and timing are computed on request from that state.
  `suggestedSpeed` divides the preview stage's scroll range (in
  reference-display pixels, the unit speed is in) by the estimated duration.
- `custom/agentBridge.ts` reconnects with capped backoff. If the server or the
  bridge is down, manual operation is unaffected.

### 4. Two small behaviour changes to upstream code

- `#pushSettings` schedules its flush with `nextFrame`, not
  `requestAnimationFrame`. `nextFrame` falls back to `setTimeout` while the
  tab is hidden. Animation frames don't run in hidden tabs, so without this a
  speed or text size sent by an agent, with the controller behind the
  recording app, would wait until someone looked at the tab.
- Cmd+Option+T ("back to the beginning and pause") and "Use the LinkedIn /
  TMP100 preset" are appended to the command list in `teleprompter.ts`, not
  added to `COMMAND_SPECS`. That way upstream's generated
  `docs/shortcuts.md` and its test are unchanged.

### 5. MCP (`tools/mcp/prompter-mcp.ts`)

A stdio JSON-RPC server with no dependencies. Each tool is one HTTP call. The
HTTP API is the automation boundary, and the adapter adds no logic of its own.

## Security model

There is no code execution, no shell and no HTML input. The API accepts this
machine only unless `-api-lan` and a token are given. Cross-origin browser
requests and foreign `Host` headers are refused. Request bodies are capped and
must be JSON. The bridge is this-machine-only and needs no token, so no secret
is ever served to browser code. See [AGENT_API.md](AGENT_API.md).

## Files

| File | Status |
| --- | --- |
| `src/backend/agentapi.go`, `agentapi_test.go` | new |
| `src/frontend/scripts/custom/*` | new |
| `tools/mcp/*` | new |
| `QUICKSTART.md`, `AGENT_API.md`, `ARCHITECTURE_CUSTOM.md`, `UPSTREAM.md`, `ROADMAP_CUSTOM.md` | new |
| `src/backend/main.go` | two flags, one `wrap`, one log call |
| `src/frontend/scripts/teleprompter.ts` | imports, two fields, the TMP100 card and seeding, `#agentHost`, command and bridge wiring, `nextFrame` in `#pushSettings` |
| `src/frontend/scripts/docControls.ts` | `putDocument` |
| `src/frontend/scripts/editor.ts` | `editorJSONFromHtml` |
| `deno.jsonc` | the test task also runs `custom/` and `tools/mcp/` tests |
| `README.md` | a pointer to these docs |

## Not changed

Signalling, the hub, rooms and keys; the WebRTC sync and pacing; `viewer.ts`
and `viewerApp.ts`; `protocol.ts`; storage formats; existing shortcuts;
deployment (Docker, Kamal); and upstream's CLAUDE.md constraints.
