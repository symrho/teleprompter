# Agent API

A small local HTTP API for preparing and driving the teleprompter from an AI
agent or a script. Manual control keeps working whether or not anything uses
the API, and both control the same state: a speed set by the API moves the
Scroll Speed slider, and a Space bar press shows up in `/api/status`.

- Base URL: `http://localhost:8080` (or `127.0.0.1`, or the Mac's own name).
- JSON in, JSON out. Send a body with `Content-Type: application/json`.
- The controller page must be open on the Mac, because it holds the
  prompter's state. Without it, `/api/status` answers `NO_CONTROLLER` and
  every other endpoint answers `503 controller_unavailable`.
- Version: `apiVersion` in `/api/status`. New fields and endpoints are added
  without a version change. Removing or renaming one changes the version.

There is also a thin MCP adapter over the same endpoints. See [MCP](#mcp).

## Authentication and access

| Server started with | Who may call | Token |
| --- | --- | --- |
| *(default)* | this Mac only (loopback or its own addresses) | none |
| `-api-token T` or `TELEPROMPTER_API_TOKEN=T` | this Mac only | `Authorization: Bearer T` |
| `-api-lan -api-token T` | any host on the network | `Authorization: Bearer T` |

These rules always apply:

- A request with an `Origin` header from another site is refused
  (`403 forbidden_origin`), so a web page can't drive your prompter.
- With no token, the `Host` header must name this machine
  (`403 forbidden_host`), which blocks DNS-rebinding attacks.
- The controller's bridge socket (`/api/bridge`) accepts this Mac only, and
  never needs a token, so no secret is ever given to browser code.
- There is no endpoint that runs code, shell commands or arbitrary HTML.
  Scripts are plain text and are escaped before they reach the page.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/health` | `{ok, controllerConnected}`. Answered by the server itself. |
| GET | `/api/status` | Readiness, playback, displays, timing. See the [status model](#status-model). |
| GET | `/api/script` | The loaded script: original, prepared, presentation, displayed text, timing. |
| PUT | `/api/script` | Load a script: paused, at the beginning, published to the displays. |
| PATCH | `/api/script` | Switch between original and prepared, or change the presentation, without resending the text. |
| GET | `/api/config` | Preset, speed, text size, target WPM and the TMP100 settings. |
| PATCH | `/api/config` | Change any of those. All fields are validated, and nothing is applied if one is invalid. |
| GET | `/api/presets` | The available presets with their defaults and limits. |
| POST | `/api/control/start` | Start scrolling from the current position. |
| POST | `/api/control/pause` | Pause, keeping the speed and position. |
| POST | `/api/control/resume` | The same as start. Named for agents that think in pause and resume. |
| POST | `/api/control/start-over` | Back to the beginning, paused. `{"run": true}` starts it again. |
| POST | `/api/control/goto` | `{"position": 0..1}` or `{"percent": 0..100}`. |

## Schemas

### `PUT /api/script`

```jsonc
{
  "text": "string, required, 1 to 100000 characters",  // A: the original
  "prepared": "string, optional",                       // B: an agent's speech version
  "active": "original | prepared",   // default: prepared if given, else original
  "document": "Launch video",        // default "Agent script"; same name = replaced
  "preset": "linkedin-tmp100 | default | big-clock",   // optional
  "targetWpm": 130,                  // 60 to 260; remembered
  "speedFromWpm": true,              // default true: set speed for targetWpm
  "presentation": {                  // C: layout only, never changes the words
    "thoughtGroups": true,           // break lines at phrase boundaries (default true)
    "maxGroupWords": 6,              // 2 to 20
    "cues": "dim"                    // [bracketed] text: show | dim | hide
  }
}
```

The text is plain text. Blank lines separate paragraphs. A single line break
is kept. With `thoughtGroups`, each paragraph is broken into short spoken
phrases, after sentence ends and clause punctuation, and at `maxGroupWords`.
The words themselves are never changed. Text in `[brackets]` is a cue: it gets
its own line and isn't counted in the timing.

Loading creates or replaces the document named `document`. Your other scripts
are left alone. The script is published to the displays even when Live
editing is off. The response is the new status.

### `PATCH /api/script`

```json
{ "prepared": "string | null", "active": "original | prepared", "presentation": { "thoughtGroups": false } }
```

This only works on a document that was loaded through `PUT /api/script`.
Otherwise it answers `409 no_agent_script`.

### `GET /api/script`

```json
{
  "document": "Launch video",
  "original": "…", "prepared": null, "active": "original",
  "presentation": { "thoughtGroups": true, "maxGroupWords": 6, "cues": "dim" },
  "loadedAt": "2026-10-31T07:40:00.000Z",
  "displayedText": "…what the displays show, one line per line…",
  "timing": { "words": 193, "targetWpm": 130, "estimatedSeconds": 89.1, "estimatedDuration": "1:29" }
}
```

`original`, `prepared` and the other record fields are `null` for a document
typed by hand. `displayedText` and `timing` always describe what is on screen.

### `PATCH /api/config`

Every field is optional.

| Field | Type | Range | Notes |
| --- | --- | --- | --- |
| `preset` | string | `linkedin-tmp100`, `default`, `big-clock` | `linkedin-tmp100` also sets Text Scale to 4.0 |
| `speed` | number | -500 to 500 | stage pixels per second, forward positive, the Scroll Speed slider |
| `speedFromWpm` | boolean | | set speed from `targetWpm` and the live layout. Can't be combined with `speed` |
| `textScale` | number | 0.1 to 10 | rem, the Text Scale slider |
| `targetWpm` | number | 60 to 260 | |
| `mirror` | boolean | | left-right mirror for the glass |
| `flipVertical` | boolean | | upside-down mirror |
| `lineWidthCh` | number | 8 to 60 | reading column width, in characters |
| `lineSpacing` | number | 0.9 to 3 | |
| `paragraphGap` | number | 0 to 4 | em |
| `readingLinePct` | number | 5 to 95 | reading line, % from the top |
| `readingMarker` | boolean | | the arrows at the reading line |
| `align` | string | `left`, `center` | |

The TMP100 fields change the stored preset settings, and the displays update
straight away if the preset is showing. The response is the new config:

```json
{
  "preset": "linkedin-tmp100", "layout": "LinkedIn / TMP100",
  "speed": 73.1, "textScale": 4, "targetWpm": 130,
  "tmp100": { "mirror": true, "flipVertical": false, "lineWidthCh": 16, "lineSpacing": 1.3,
              "paragraphGap": 0.9, "readingLinePct": 40, "readingMarker": true, "align": "left" }
}
```

## Status model

`GET /api/status`:

```json
{
  "apiVersion": 1,
  "state": "READY",
  "ready": true,
  "connected": true,
  "readiness": [
    { "check": "viewer",    "ok": true, "required": true,  "message": "1 display(s) connected" },
    { "check": "script",    "ok": true, "required": true,  "message": "193 words loaded" },
    { "check": "published", "ok": true, "required": true,  "message": "displays show the editor's script" },
    { "check": "speed",     "ok": true, "required": true,  "message": "scroll speed 73.1" },
    { "check": "at_start",  "ok": true, "required": true,  "message": "at the beginning" },
    { "check": "paused",    "ok": true, "required": true,  "message": "paused" },
    { "check": "preset",    "ok": true, "required": false, "message": "layout linkedin-tmp100" }
  ],
  "playback": { "running": false, "scrolling": false, "speed": 73.1, "position": 0 },
  "displays": { "connected": 1, "local": 0, "remote": 1, "signaling": true },
  "layout": { "preset": "linkedin-tmp100", "name": "LinkedIn / TMP100" },
  "textScale": 4,
  "script": {
    "document": "Launch video", "loadedByAgent": true,
    "words": 193, "targetWpm": 130, "estimatedSeconds": 89.1, "estimatedDuration": "1:29",
    "remainingSeconds": 89, "suggestedSpeed": 73.1
  },
  "liveEditing": true
}
```

| `state` | Meaning |
| --- | --- |
| `NO_CONTROLLER` | The controller page isn't open on this Mac. This is the only state answered without it. |
| `NO_VIEWER` | No display is connected. Open the viewer link on the iPad. |
| `NOT_READY` | A required check failed. `readiness` says which. |
| `READY` | Loaded, published, at the beginning, paused, with a forward speed set. Safe to start recording. |
| `RUNNING` | Scrolling. |
| `PAUSED` | Stopped part-way through, with a speed set. `resume` continues. |

`running` is the Space bar state. `scrolling` means it is running at a
non-zero speed. `position` is the shared scroll position, from 0 to 1. The
timing is an estimate, from the word count at the target WPM.
`suggestedSpeed` is the speed that would cover the script in that time,
measured from the live layout. It is `null` when it can't be measured.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "validation_failed", "message": "speed must be between -500 and 500; mirror must be true or false",
             "fields": [ { "field": "speed", "message": "must be between -500 and 500" },
                         { "field": "mirror", "message": "must be true or false" } ] } }
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_json` | The body isn't a JSON object. |
| 401 | `unauthorized` | A token is configured and is missing or wrong. |
| 403 | `forbidden`, `forbidden_host`, `forbidden_origin` | See [authentication](#authentication-and-access). |
| 404 | `not_found` | No such endpoint. |
| 405 | `method_not_allowed` | The path exists but doesn't take that method. `Allow` lists the methods it does take. |
| 409 | `speed_zero` | Start or resume with speed 0. |
| 409 | `no_viewer` | Start or resume with no display connected. |
| 409 | `cannot_measure` | `speedFromWpm` with nothing measurable. |
| 409 | `no_agent_script` | `PATCH /api/script` on a document typed by hand. |
| 413 | `too_large` | The body is over 512 KiB. |
| 415 | `unsupported_media_type` | The body isn't `application/json`. |
| 422 | `validation_failed` | A field is wrong. `fields` lists each one, and nothing was applied. |
| 503 | `controller_unavailable` | The controller page isn't open, or didn't answer within 5 s. |

## curl examples

```sh
API=localhost:8080/api
J='Content-Type: application/json'

# Is it there, and is it ready?
curl -s $API/status | jq '{state, ready, failing: [.readiness[] | select(.ok|not) | .message]}'

# Load a script file, apply the preset and target 130 WPM
jq -Rs '{text: ., preset: "linkedin-tmp100", targetWpm: 130, document: "Launch video"}' script.txt \
  | curl -s -X PUT $API/script -H "$J" -d @- | jq '{state, script}'

# Load an original and an agent-prepared version; show the prepared one
curl -s -X PUT $API/script -H "$J" -d '{"text":"Original prose.","prepared":"Prepared,\nfor speech.","document":"Draft"}'

# Read it back
curl -s $API/script | jq '{active, timing}'

# Tweak the preset for the glass
curl -s -X PATCH $API/config -H "$J" -d '{"readingLinePct": 35, "lineWidthCh": 14, "textScale": 4.5}'

# Re-time for a slower delivery
curl -s -X PATCH $API/config -H "$J" -d '{"targetWpm": 120, "speedFromWpm": true}' | jq .speed

# Transport
curl -s -X POST $API/control/start      | jq .state    # RUNNING
curl -s -X POST $API/control/pause      | jq .state    # PAUSED
curl -s -X POST $API/control/resume     | jq .state
curl -s -X POST $API/control/goto -H "$J" -d '{"percent": 50}'
curl -s -X POST $API/control/start-over | jq .state    # READY

# With a token
curl -s -H "Authorization: Bearer $TELEPROMPTER_API_TOKEN" $API/status
```

## A typical agent sequence

"Load this script, use my LinkedIn TMP100 preset, target about 130 words per
minute and put it at the beginning ready for recording."

1. `GET /api/status`. If the state is `NO_CONTROLLER` or `NO_VIEWER`, ask the
   person to open the controller or the iPad viewer.
2. `PUT /api/script` with `{text, preset: "linkedin-tmp100", targetWpm: 130}`.
3. Check that `state` is `READY`. If not, report the failing `readiness`
   messages.
4. Report the word count and estimated duration. The person starts recording,
   and usually the scrolling too.

## MCP

`tools/mcp/prompter-mcp.ts` is a stdio MCP server with no dependencies. Each
tool maps onto one endpoint above:

| Tool | Endpoint |
| --- | --- |
| `prompter_get_status` | `GET /api/status` |
| `prompter_load_script` | `PUT /api/script` |
| `prompter_get_script` | `GET /api/script` |
| `prompter_configure` | `PATCH /api/config` |
| `prompter_start` / `prompter_pause` / `prompter_resume` | `POST /api/control/…` |
| `prompter_goto_start` | `POST /api/control/start-over` |
| `prompter_goto` | `POST /api/control/goto` |

Add it to Claude Code:

```sh
claude mcp add prompter -- deno run \
  --allow-net=127.0.0.1:8080 \
  --allow-env=TELEPROMPTER_URL,TELEPROMPTER_API_TOKEN \
  "$PWD/tools/mcp/prompter-mcp.ts"
```

Or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "prompter": {
      "command": "deno",
      "args": ["run", "--allow-net=127.0.0.1:8080", "--allow-env=TELEPROMPTER_URL,TELEPROMPTER_API_TOKEN",
               "/absolute/path/to/teleprompter/tools/mcp/prompter-mcp.ts"]
    }
  }
}
```

`TELEPROMPTER_URL` defaults to `http://127.0.0.1:8080`. If you set it to
another host, widen `--allow-net` to match.
