# Quickstart: Mac + iPad mini + TMP100 + C920

This fork adds a `linkedin-tmp100` preset and a local agent API to the
teleprompter. The workflow is:

```
start prompter on the Mac
  -> open the controller on the Mac
  -> open (scan) the viewer URL on the iPad
  -> place the iPad in the TMP100
  -> select linkedin-tmp100
  -> load the script (by hand, or by an agent)
  -> position the C920 behind the glass
  -> start recording, then start the prompter
```

No Sidecar is involved. The Mac and the iPad talk over your local network:
the Mac serves the pages and introduces the two, and the script then travels
directly between them over WebRTC.

## 1. One-time setup on the Mac

```sh
brew install go deno          # Go 1.27+ and Deno 2.9+
git clone https://github.com/symrho/teleprompter.git
cd teleprompter
git checkout feature/linkedin-tmp100-agent-api   # until it is merged
deno task build                                  # frontend -> src/backend/dist
cd src/backend && go build -o ../../teleprompter . && cd ../..
```

`deno task build` must run before `go build`, because the Go binary embeds the
built frontend.

## 2. Start the prompter

```sh
./teleprompter
```

The log prints the address to use, for example:

```
listening on http://localhost:8080
open the control page at http://Serbans-MacBook-Air.local:8080/control so the viewer link works on the iPad
  or http://192.168.1.23:8080/control
```

The first time, macOS asks whether `teleprompter` may accept incoming network
connections. Allow it, or the iPad cannot reach the Mac.

## 3. Open the controller on the Mac

Open the **`.local` address from the log** in Chrome or Safari on the Mac, not
`localhost`. The viewer link and QR code are built from the address the
controller is opened on, and `localhost` means nothing to the iPad.

Always use the same address: the browser stores your scripts per address, so
`localhost` and the `.local` name each have their own documents.

The controller has the script editor on the left. On the right are the
preview, the Transport card (Scroll Speed and Text Scale), the new
**LinkedIn / TMP100** card, and the viewer link with its QR code.

## 4. Open the viewer on the iPad

- On the iPad, point the Camera at the QR code in the controller's Viewers
  card and open the link in Safari. Or type the viewer link shown under it.
- The badge in the controller's top bar turns **Live** and reads "1 remote".
- For a full-screen viewer, use Share > Add to Home Screen and open it from
  there.
- **Settings > Display & Brightness > Auto-Lock > Never.** Over a plain `http`
  connection the page cannot keep the screen awake by itself.
- Turn on a Focus mode so notifications don't appear on the glass, and turn
  the brightness up.
- Optional: Guided Access (triple-click) so a stray touch can't scroll it.

## 5. Place the iPad in the TMP100

Put the iPad in the cradle with its screen facing up into the glass. Then look
at the glass from where you will sit.

- The text should read normally in the reflection. The preset mirrors it left
  to right by default. If it reads backwards, switch **Mirror for glass** off.
- If the text is upside down in the glass, rotate the iPad 180 degrees, or
  switch **Flip upside down** on.

## 6. Select `linkedin-tmp100`

In the controller, press **Use preset** in the LinkedIn / TMP100 card. Or pick
**Layout: LinkedIn / TMP100** under the preview, or open the command palette
(Cmd+K) and type "tmp100".

The preset gives a black background, large white text in a narrow column,
mirroring, and two small reading-line markers at the screen edges. On the
card you can adjust:

| Control         | Default | What it does                                                    |
| --------------- | ------- | --------------------------------------------------------------- |
| Line width      | 16 ch   | Column width in characters. Narrower means less eye movement.   |
| Line spacing    | 1.3     | Line height.                                                     |
| Paragraph gap   | 0.9 em  | Space between paragraphs, so your intended breaks show.         |
| Reading line    | 40 %    | Where the current line sits, measured from the top of the screen. |
| Mirror / Flip   | on / off | For the glass.                                                 |
| Reading markers | on      | Small arrows at the reading line.                               |
| Centre text     | off     | Centre-align the column.                                        |

Text size is the existing **Text Scale** slider (the preset sets 4.0). Speed
is the existing **Scroll Speed** slider.

## 7. Load the script

**By hand:** paste it into the editor. What you type goes to the iPad as you
type, while Live editing (in the Sync card) is on.

**Programmatically** (see [AGENT_API.md](AGENT_API.md)):

```sh
jq -Rs '{text: ., preset: "linkedin-tmp100", targetWpm: 130, document: "Launch video"}' script.txt \
  | curl -s -X PUT localhost:8080/api/script -H 'Content-Type: application/json' -d @- | jq '{state, ready, script}'
```

Loading by API pauses the prompter, puts the script at the beginning, applies
the preset, and sets the scroll speed for 130 words a minute. The status then
reads `READY`. The LinkedIn / TMP100 card shows the same thing, for example
`READY · 193 words · 130 WPM · ~1:29`. Text in `[square brackets]` is treated
as a cue: it gets its own line, is shown small and pale blue, and is not
counted in the timing.

## 8. Position the C920

- Mount the C920 behind the glass, inside the hood, with the lens as close to
  the glass as the hood allows and centred left to right.
- Sit where you will record and look at the reflected text. Move **Reading
  line** until the markers are level with the lens behind the glass. That is
  where your eyes will rest, so it is what makes you look into the camera.
- If you can see your eyes moving from side to side in the camera preview,
  make **Line width** narrower, or move back a little.

## 9. Record

1. Start recording on the Mac (OBS, QuickTime or Photo Booth, using the C920).
2. Click the controller window, outside the editor, so keyboard shortcuts
   reach it.
3. Press **Space** to start scrolling. Press it again to pause.

| Key (Mac)              | Action                                         |
| ---------------------- | ---------------------------------------------- |
| Space                  | Start or pause scrolling (not while typing in the editor) |
| Cmd+Down / Cmd+Up      | Faster / slower (add Shift for big steps)      |
| Cmd+Option+0           | Speed to zero                                  |
| **Cmd+Option+T**       | Back to the beginning and pause (new in this fork) |
| Cmd+Option+= / -        | Larger / smaller text on the displays          |
| Cmd+K                  | Command palette                                |
| Cmd+/                  | All shortcuts                                  |

The shortcuts are browser key bindings, so they work only while the
controller window is the focused app. OBS hotkeys are global on macOS once OBS
has Accessibility permission, so OBS can record in the background while the
controller stays in front.

You can also scroll by hand: give the iPad drive in the Viewers card, then
drag on it. Or turn on preview scrolling in Settings and scroll the preview.

The prompter works fully by hand. The agent API is optional, and if nothing
is using it, nothing changes.

## Physical validation checklist

The automated tests cover the logic, the API and a desktop Chrome browser.
They cannot cover Safari on your iPad, the TMP100 glass or the C920. Run this
once on the real hardware.

- [ ] `./teleprompter` starts. The log shows a `.local` address, and the
      macOS firewall prompt was allowed.
- [ ] The controller opens on the Mac at the `.local` address, and the TMP100
      card shows "Agent API: ready".
- [ ] The QR code opens the viewer in iPad Safari, and the controller badge
      says **Live** and "1 remote".
- [ ] `curl -s localhost:8080/api/status` says `NO_VIEWER` before the iPad
      joins, and something else after.
- [ ] Use preset: the iPad turns black with white, mirrored text. In the
      glass it reads the right way round and the right way up.
- [ ] The reading-line markers line up with the C920 lens from your seat
      (adjust Reading line).
- [ ] The text is comfortably readable at your recording distance (adjust
      Text Scale).
- [ ] Space starts and pauses scrolling on the iPad. Cmd+Down and Cmd+Up
      change the speed while it runs.
- [ ] The API load from step 7 replaces the script on the iPad, at the
      beginning, and `/api/status` says `READY`.
- [ ] `curl -s -X POST localhost:8080/api/control/start` scrolls the iPad, and
      `.../pause` stops it.
- [ ] Cmd+Option+T (or `.../start-over`) returns the iPad to the first line.
- [ ] After 5 minutes idle the iPad screen is still on (Auto-Lock is Never).
- [ ] Record a 30-second test with the C920 and play it back. Your eyes
      should look at the lens, with little side-to-side movement visible.
- [ ] With the controller tab behind the recording app,
      `PATCH /api/config {"textScale": 4.5}` still changes the iPad.
- [ ] Stop the server: the controller and the iPad keep their last script.
      Start it again: they reconnect without a reload.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Badge stays "No viewers" | The iPad isn't on the same network (a guest network often isolates devices), the macOS firewall blocked the server, or the controller was opened on `localhost`. |
| API answers `controller_unavailable` | The controller page isn't open, or it's open on another machine. The API only talks to a controller page on this Mac. |
| API answers `forbidden_host` | Call it as `localhost` or `127.0.0.1`, or by the Mac's own name. |
| Text reads backwards in the glass | Switch Mirror for glass off. Some rigs reflect twice. |
| Speed suggestion is `null` | No script loaded, or the preview is collapsed. The suggestion is measured from the preview. |
| iPad went dark mid-take | Auto-Lock. See step 4. |
