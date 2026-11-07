// CUSTOM (symrho fork): cue grammar and crossing detection.

import { assert, assertEquals } from "@std/assert";
import {
  type CueGeometry,
  cuesInText,
  type CueStreamEvent,
  CueTracker,
  CueWatcher,
  parseCue,
} from "./cues.ts";
import { DEFAULT_PRESENTATION, scriptToHtml } from "./script.ts";
import { simulate } from "../../../../fixtures/cue-events/simulate.ts";

Deno.test("a cue is [CUE id · LABEL] on its own line", () => {
  assertEquals(parseCue("[CUE 1B · NAME]"), {
    id: "1B",
    label: "NAME",
    text: "[CUE 1B · NAME]",
  });
  assertEquals(parseCue("  [CUE 2 · CORPORATE]  ")?.id, "2");
  // The label is everything after the first dot.
  assertEquals(
    parseCue("[CUE E · END CARD · HOLD 3 S, THEN STOP]")?.label,
    "END CARD · HOLD 3 S, THEN STOP",
  );
});

Deno.test("anything else in brackets is a direction, not a cue", () => {
  for (
    const line of [
      "[PAUSE]",
      "[CUE]",
      "[CUE 2]",
      "[CUE 2 · ]",
      "[Cue 2 · LOWER]",
      "Say this [CUE 2 · MID] mid-line",
      "[CUE 2 · A] [CUE 3 · B]",
    ]
  ) {
    assertEquals(parseCue(line), null, line);
  }
});

Deno.test("cuesInText finds the fixture script's nine cues in order", () => {
  const script = Deno.readTextFileSync("fixtures/cue-events/script.txt");
  assertEquals(cuesInText(script).map((c) => c.id), [
    "1",
    "1B",
    "2",
    "3",
    "3B",
    "1",
    "4",
    "1",
    "E",
  ]);
});

// The DOM half (cueControls.ts) recognises a cue as a text node that is only a
// cue. That holds because the renderer gives every cue a line, and a dimmed
// one a span, of its own — so check the renderer, for every cue setting a cue
// can be seen in.
Deno.test("the rendered script keeps each cue as a text node of its own", () => {
  const script = Deno.readTextFileSync("fixtures/cue-events/script.txt");
  const want = cuesInText(script).map((c) => c.text);
  for (const cues of ["show", "dim"] as const) {
    for (const thoughtGroups of [true, false]) {
      const html = scriptToHtml(script, {
        ...DEFAULT_PRESENTATION,
        cues,
        thoughtGroups,
      });
      // Text nodes: whatever sits between two tags.
      const nodes = html.split(/<[^>]+>/).map((t) => t.trim());
      const found = nodes.filter((t) => parseCue(t));
      assertEquals(found, want, `${cues}, thoughtGroups ${thoughtGroups}`);
    }
  }
});

function geometry(...ys: number[]): CueGeometry {
  return {
    range: 1000,
    readingLine: 100,
    cues: ys.map((y, i) => ({ id: `c${i}`, label: "L", text: "[CUE]", y })),
  };
}

Deno.test("a cue fires once as it is scrolled past, however many samples", () => {
  const t = new CueTracker();
  const g = geometry(150); // crossed when ratio * 1000 + 100 reaches 150
  assertEquals(t.observe(0, g, true), []);
  assertEquals(t.observe(0.02, g), []);
  assertEquals(t.observe(0.05, g).map((f) => f.index), [0]);
  assertEquals(t.observe(0.06, g), []);
  assertEquals(t.observe(0.5, g), []);
});

Deno.test("scrolling back over a cue and forward again fires it again", () => {
  const t = new CueTracker();
  const g = geometry(150);
  t.observe(0, g, true);
  assertEquals(t.observe(0.1, g).length, 1);
  assertEquals(t.observe(0.01, g), []); // backwards never fires
  assertEquals(t.observe(0.1, g).length, 1);
});

Deno.test("a jump fires nothing, and a jump to 0 re-arms every cue", () => {
  const t = new CueTracker();
  const g = geometry(150, 300, 450);
  t.observe(0, g, true);
  assertEquals(t.observe(0.9, g, true), []); // goto past all three
  assertEquals(t.observe(0.95, g), []); // and onwards: none left ahead
  t.observe(0, g, true); // start over
  assertEquals(t.observe(0.4, g).map((f) => f.index), [0, 1, 2]);
});

Deno.test("a relayout under a still position fires nothing", () => {
  const t = new CueTracker();
  t.observe(0.1, geometry(500), true);
  // The script was edited above the cue: it moved from ahead of the reading
  // line (200) to behind it, without anyone scrolling.
  assertEquals(t.observe(0.1, geometry(150)), []);
  // And the next forward sample measures its stretch in the new layout.
  assertEquals(t.observe(0.2, geometry(150)), []);
  // Edited again: now it is ahead of the line (300) once more.
  assertEquals(t.observe(0.2, geometry(350)), []);
  assertEquals(t.observe(0.2001, geometry(350)), []);
  assertEquals(t.observe(0.3, geometry(350)).length, 1);
});

Deno.test("the first sample is a baseline, not a crossing", () => {
  const t = new CueTracker();
  // A page that has just loaded hears the pacer mid-script: nothing behind
  // the reading line has just been crossed.
  assertEquals(t.observe(0.5, geometry(150, 300)), []);
});

Deno.test("no preview to measure means no events", () => {
  const t = new CueTracker();
  t.observe(0, geometry(150), true);
  assertEquals(t.observe(0.1, null), []);
  assertEquals(t.observe(0.2, geometry(150, 250)).map((f) => f.index), [1]);
});

Deno.test("a cue on the first line fires once scrolling starts", () => {
  // Position 0 puts the first line on the reading line: its bottom edge is
  // below it, so it is still ahead.
  const t = new CueTracker();
  const g = geometry(100 + 15);
  t.observe(0, g, true);
  assertEquals(t.observe(0.02, g).length, 1);
});

Deno.test("the watcher emits the interface's event shapes", () => {
  const events: CueStreamEvent[] = [];
  const w = new CueWatcher({
    geometry: () => ({
      range: 1000,
      readingLine: 100,
      cues: [{ id: "1B", label: "NAME", text: "[CUE 1B · NAME]", y: 183 }],
    }),
    emit: (e) => events.push(e),
    now: () => new Date("2026-11-10T07:41:02.120Z"),
  });
  w.jump(0);
  w.playback("running", 0);
  w.motion(0.08312);
  assertEquals(events, [
    {
      event: "playback",
      data: { state: "running", at: "2026-11-10T07:41:02.120Z", position: 0 },
    },
    {
      event: "cue",
      data: {
        id: "1B",
        label: "NAME",
        text: "[CUE 1B · NAME]",
        index: 0,
        at: "2026-11-10T07:41:02.120Z",
        position: 0.0831,
      },
    },
  ]);
});

Deno.test("the fixture's events are what the watcher produces", () => {
  const script = Deno.readTextFileSync("fixtures/cue-events/script.txt");
  const want = JSON.parse(
    Deno.readTextFileSync("fixtures/cue-events/events.json"),
  );
  const got = simulate(script);
  assertEquals(got, want);
  // Every cue fires, in order, and the two passed again after the hand scroll
  // back fire a second time.
  const ids = got.filter((e) => e.event === "cue").map((e) =>
    (e.data as { index: number }).index
  );
  assertEquals(ids, [0, 1, 2, 3, 4, 3, 4, 5, 6, 7, 8]);
  assert(got[0].event === "playback" && got[0].data.state === "reset");
});
