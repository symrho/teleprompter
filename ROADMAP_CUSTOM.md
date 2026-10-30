# Fork roadmap

Future directions for this fork. Nothing here is implemented yet. Upstream's
own roadmap is [docs/roadmap.md](docs/roadmap.md).

The rule throughout: **the teleprompter stays a teleprompter.** AI, speech
recognition, cameras and recording software sit *outside* it and talk to it
through the agent API ([AGENT_API.md](AGENT_API.md)) or a sibling integration.

## 1. Voice-follow

Follow the speaker's delivery instead of scrolling at a fixed speed.

- **Shape:** a separate process, or a page on the Mac, listens to the
  microphone, recognises speech locally (for example whisper.cpp or Apple's
  on-device recogniser), aligns the words with the script's
  `displayedText`, and calls `POST /api/control/goto` with the matching
  position, or nudges `speed`.
- **What the prompter needs:** probably a word-to-position map, for example
  `GET /api/script/positions`, giving each word's 0 to 1 position measured on
  the preview. Smooth `goto` (eased rather than a jump) would be a viewer-side
  change, so it should be weighed against upstream compatibility first.
- **Risks:** latency, ad-libs and restarts. It must fall back to manual
  control instantly, so the Space bar always wins.

## 2. AI script preparation

An external agent turns an idea into a spoken script and prepares it for the
glass:

- write the hook, and rewrite prose for speech: shorter sentences, spoken
  rhythm;
- break text into thought groups, or leave that to `presentation.thoughtGroups`;
- insert pause and cue markers (`[Pause.]`, `[CUE 2 · CORPORATE]`);
- estimate the delivery time, and trim to a target duration using
  `/api/status` → `script.estimatedSeconds`;
- load it as `prepared`, keeping the original as `text`, so the person can
  switch back with `PATCH /api/script {"active": "original"}`.

None of this belongs in the prompter. The API already separates the original,
the prepared text and the presentation for this purpose.

## 3. Recording automation

```
AI agent
  -> prepare script                  (PUT /api/script)
  -> configure teleprompter          (PATCH /api/config)
  -> verify prompter READY           (GET /api/status)
  -> configure C920 / recording app  (separate integration)
  -> initiate recording              (separate integration, e.g. OBS WebSocket)
  -> start prompter                  (POST /api/control/start)
  -> stop recording                  (separate integration)
```

Camera and recording control stay **architecturally separate** from the
teleprompter: a separate small service or MCP server (for example over
obs-websocket for OBS, and `uvc-util` for the C920's exposure and focus). The
agent orchestrates the two through their own APIs. The prompter doesn't learn
about cameras.

## Smaller ideas

- A one-shot `POST /api/control/countdown` (3, 2, 1, then start) for solo
  recording.
- A web-push or `/api/events` stream (server-sent events) so an agent can
  watch the state instead of polling.
- Per-document TMP100 settings (today they are one set per browser).
- A wake lock on the iPad viewer when served over HTTPS (see
  [docs/deploying.md](docs/deploying.md#https)).
