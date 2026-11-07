// CUSTOM (symrho fork): the cue-event fixture, and how it was made.
//
// A rehearsal of the 31 Oct launch script, run through the real CueWatcher on
// a synthetic layout, so the files beside this one are exactly what
// GET /api/events sends for it:
//
//   script.txt   the script, as loaded on the prompter
//   events.json  the events the control page pushes, in order
//   events.sse   the same events as the server streams them
//
// The rehearsal: start over, start, read to halfway, pause, scroll back a
// little by hand (re-arming the cues passed), start again, read to the end,
// pause. So the fixture also shows a cue firing a second time.
//
// `cues_test.ts` checks events.json against this; `agentapi_test.go` checks
// events.sse against events.json. Regenerate both after a change with
//
//   deno run --allow-read=. --allow-write=fixtures fixtures/cue-events/simulate.ts

import {
  type CueGeometry,
  cuesInText,
  type CueStreamEvent,
  CueWatcher,
} from "../../src/frontend/scripts/custom/cues.ts";

/** Each script line is one 60px line on screen; the reading line is 40% down. */
const LINE_PX = 60;
const SCREEN_PX = 900;
const READING_LINE = SCREEN_PX * 0.4;

/** Lay the script out the way the TMP100 layout does, one line per line. */
export function layout(script: string): CueGeometry {
  const lines = script.split("\n");
  const cues = cuesInText(script);
  let next = 0;
  const marks = [];
  for (let i = 0; i < lines.length && next < cues.length; i++) {
    if (lines[i].trim() !== cues[next].text) continue;
    // #main's top padding puts line 0 on the reading line; the cue's bottom
    // edge is half a line below its centre.
    marks.push({ ...cues[next], y: READING_LINE + i * LINE_PX + LINE_PX / 2 });
    next++;
  }
  // Padding above and below, as tmp100Css has it, so the end can reach the line.
  const height = READING_LINE + lines.length * LINE_PX +
    (SCREEN_PX - READING_LINE);
  return { range: height - SCREEN_PX, readingLine: READING_LINE, cues: marks };
}

export function simulate(script: string): CueStreamEvent[] {
  const g = layout(script);
  const events: CueStreamEvent[] = [];
  let t = Date.parse("2026-11-10T07:41:00.000Z");
  const w = new CueWatcher({
    geometry: () => g,
    emit: (e) => events.push(e),
    now: () => new Date(t),
  });
  let r = 0;
  const tick = () => t += 100;
  const run = (to: number, step: number) => {
    while (step > 0 ? r < to : r > to) {
      r = Math.round((r + step) * 1000) / 1000;
      tick();
      w.motion(r);
    }
  };

  w.jump(0);
  w.playback("reset", 0);
  tick();
  w.playback("running", r);
  run(0.5, 0.005);
  tick();
  w.playback("paused", r);
  run(0.3, -0.02); // a hand scroll back, while paused
  tick();
  w.playback("running", r);
  run(1, 0.005);
  tick();
  w.playback("paused", r);
  return events;
}

export function toSse(events: CueStreamEvent[]): string {
  return events.map((e) =>
    `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
  )
    .join("");
}

if (import.meta.main) {
  const dir = new URL(".", import.meta.url);
  const script = Deno.readTextFileSync(new URL("script.txt", dir));
  const events = simulate(script);
  Deno.writeTextFileSync(
    new URL("events.json", dir),
    JSON.stringify(events, null, 2) + "\n",
  );
  Deno.writeTextFileSync(new URL("events.sse", dir), toSse(events));
}
