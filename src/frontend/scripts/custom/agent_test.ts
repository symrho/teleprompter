// CUSTOM (symrho fork): the agent API's operations, against a fake control
// page. The fake keeps the same single state the real page does (sliders, the
// Space-bar flag, the layout, the published text), so these check that an
// operation lands in that state and that status reads it back.

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  AgentController,
  AgentError,
  type AgentHost,
  answer,
  type HostSnapshot,
} from "./agent.ts";
import { TMP100_DEFAULTS, TMP100_SLUG, type Tmp100Params } from "./tmp100.ts";

function fakeHost(over: Partial<HostSnapshot> = {}) {
  const state = {
    speed: 0,
    running: true, // upstream's page starts with the pacer allowed to run
    textScale: 3,
    layout: "theme-default",
    layoutName: "Clocks & Text",
    viewers: { connected: 1, local: 0, remote: 1 },
    signaling: true,
    position: 0.5,
    liveEditing: true,
    draftHeld: false,
    pdfOpen: false,
    document: { id: "doc-1", name: "Old" },
    ...over,
  };
  let tmp: Tmp100Params = { ...TMP100_DEFAULTS };
  let html = "";
  const docs = new Map<string, string>();
  const calls: string[] = [];
  const host: AgentHost = {
    snapshot: () => structuredClone(state),
    setSpeed: (v) => {
      calls.push(`speed ${v}`);
      state.speed = v;
    },
    setRunning: (on) => {
      calls.push(`running ${on}`);
      state.running = on;
    },
    setTextScale: (rem) => {
      state.textScale = rem;
    },
    setLayout: (slug) => {
      calls.push(`layout ${slug}`);
      state.layout = slug;
      if (slug === TMP100_SLUG) state.textScale = 4;
    },
    tmp100: () => ({ ...tmp }),
    updateTmp100: (p) => {
      tmp = { ...tmp, ...p };
    },
    goto: (r) => {
      calls.push(`goto ${r}`);
      state.position = r;
    },
    loadDocument: (name, h) => {
      calls.push(`load ${name}`);
      if (!docs.has(name)) docs.set(name, `doc-${docs.size + 2}`);
      state.document = { id: docs.get(name)!, name };
      html = h;
    },
    displayedText: () =>
      html.replace(/<br>/g, "\n").replace(/<\/p>/g, "\n\n").replace(
        /<[^>]+>/g,
        "",
      ),
    // 130 words at 130 WPM is 60s; a 6000px range then reads at 100px/s.
    scrollRange: () => (html ? 6000 : null),
    settle: () => Promise.resolve(),
  };
  return { host, state, calls, html: () => html };
}

function memStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const WORDS_130 = Array.from({ length: 130 }, (_, i) => `w${i}`).join(" ");

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await assertRejects(() => p, AgentError);
  assertEquals([err.status, err.code], [status, code]);
  return err;
}

Deno.test("load_script publishes, pauses, rewinds and sets speed from WPM", async () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  const status = await ctl.handle("load_script", {
    text: WORDS_130,
    preset: "linkedin-tmp100",
    document: "Launch",
  }) as { state: string; ready: boolean };
  // Paused before anything moves, rewound after the content is in place.
  assertEquals(f.calls[0], "running false");
  assert(f.calls.indexOf("load Launch") < f.calls.indexOf("goto 0"));
  assertEquals(f.state.speed, 100);
  assertEquals(f.state.layout, TMP100_SLUG);
  assertEquals(status.state, "READY");
  assert(status.ready);
});

Deno.test("get_script keeps the original, the prepared text and the presentation apart", async () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  await ctl.handle("load_script", {
    text: "Original words here.",
    prepared: "Prepared, for speech.",
    presentation: { thoughtGroups: false },
  });
  const s = await ctl.handle("get_script", {}) as Record<string, unknown>;
  assertEquals(s.original, "Original words here.");
  assertEquals(s.prepared, "Prepared, for speech.");
  assertEquals(s.active, "prepared");
  assertEquals((s.timing as { words: number }).words, 3);
  assert(f.html().includes("Prepared, for speech."));

  // Switching back shows the original without resending it.
  await ctl.handle("update_script", { active: "original" });
  assert(f.html().includes("Original words here."));
});

Deno.test("the script record survives a new controller (a page reload)", async () => {
  const store = memStore();
  const f = fakeHost();
  await new AgentController(f.host, store).handle("load_script", {
    text: "Hello there",
    targetWpm: 150,
  });
  const again = new AgentController(f.host, store);
  const s = await again.handle("get_script", {}) as {
    original: string;
    timing: { targetWpm: number };
  };
  assertEquals(s.original, "Hello there");
  assertEquals(s.timing.targetWpm, 150);
});

Deno.test("invalid requests are refused with field errors, and nothing is applied", async () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  const err = await expectError(
    ctl.handle("configure", {
      speed: 9000,
      mirror: "yes",
      textScale: 2,
      bogus: 1,
    }),
    422,
    "validation_failed",
  );
  assertEquals(err.fields!.map((e) => e.field).sort(), [
    "bogus",
    "mirror",
    "speed",
  ]);
  // textScale was valid but the request as a whole was not.
  assertEquals(f.state.textScale, 3);

  await expectError(
    ctl.handle("load_script", { text: "   " }),
    422,
    "validation_failed",
  );
  await expectError(ctl.handle("load_script", {}), 422, "validation_failed");
  await expectError(
    ctl.handle("load_script", { text: "x".repeat(100_001) }),
    422,
    "validation_failed",
  );
  await expectError(
    ctl.handle("goto", { position: 2 }),
    422,
    "validation_failed",
  );
  await expectError(ctl.handle("goto", {}), 422, "validation_failed");
  await expectError(
    ctl.handle("configure", { preset: "nope" }),
    422,
    "validation_failed",
  );
  await expectError(ctl.handle("status", [1, 2]), 422, "validation_failed");
  await expectError(ctl.handle("rm -rf", {}), 404, "unknown_operation");
});

Deno.test("configure drives the same state the sliders hold", async () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  const cfg = await ctl.handle("configure", {
    preset: "linkedin-tmp100",
    textScale: 5,
    speed: 42,
    mirror: false,
    lineWidthCh: 20,
    targetWpm: 140,
  }) as Record<string, unknown>;
  assertEquals(f.state.speed, 42);
  assertEquals(f.state.textScale, 5);
  assertEquals(cfg.preset, "linkedin-tmp100");
  assertEquals((cfg.tmp100 as Tmp100Params).mirror, false);
  assertEquals((cfg.tmp100 as Tmp100Params).lineWidthCh, 20);
  assertEquals(cfg.targetWpm, 140);
});

Deno.test("speedFromWpm needs a measurable script, and not a speed beside it", async () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  await expectError(
    ctl.handle("configure", { speedFromWpm: true }),
    409,
    "cannot_measure",
  );
  await expectError(
    ctl.handle("configure", { speedFromWpm: true, speed: 3 }),
    422,
    "validation_failed",
  );
  await ctl.handle("load_script", { text: WORDS_130, speedFromWpm: false });
  assertEquals(f.state.speed, 0);
  await ctl.handle("configure", { targetWpm: 65, speedFromWpm: true });
  assertEquals(f.state.speed, 50);
});

Deno.test("start, pause, resume and start-over", async () => {
  const f = fakeHost({ running: false });
  const ctl = new AgentController(f.host, memStore());
  await expectError(ctl.handle("start", {}), 409, "speed_zero");
  f.state.speed = 30;
  let s = await ctl.handle("start", {}) as { state: string };
  assertEquals(s.state, "RUNNING");
  s = await ctl.handle("pause", {}) as { state: string };
  assertFalse(f.state.running);
  s = await ctl.handle("resume", {}) as { state: string };
  assert(f.state.running);
  s = await ctl.handle("start_over", {}) as { state: string };
  assertFalse(f.state.running);
  assertEquals(f.state.position, 0);
  s = await ctl.handle("start_over", { run: true }) as { state: string };
  assert(f.state.running);
  assertEquals(s.state, "RUNNING");
});

Deno.test("start refuses with no display connected", async () => {
  const f = fakeHost({
    speed: 30,
    viewers: { connected: 0, local: 0, remote: 0 },
  });
  const ctl = new AgentController(f.host, memStore());
  await expectError(ctl.handle("start", {}), 409, "no_viewer");
  const s = await ctl.handle("status", {}) as { state: string; ready: boolean };
  assertEquals(s.state, "NO_VIEWER");
  assertFalse(s.ready);
});

Deno.test("goto accepts a position or a percent", async () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  await ctl.handle("goto", { percent: 25 });
  assertEquals(f.state.position, 0.25);
  await ctl.handle("goto", { position: 0.75 });
  assertEquals(f.state.position, 0.75);
});

Deno.test("status explains what is missing before READY", () => {
  const f = fakeHost();
  const ctl = new AgentController(f.host, memStore());
  const s = ctl.status();
  assertFalse(s.ready);
  const failing = s.readiness.filter((c) => !c.ok).map((c) => c.check);
  assertEquals(failing.sort(), ["at_start", "preset", "script", "speed"]);
});

Deno.test("update_script needs a script loaded through the API", async () => {
  const ctl = new AgentController(fakeHost().host, memStore());
  await expectError(
    ctl.handle("update_script", { active: "original" }),
    409,
    "no_agent_script",
  );
});

Deno.test("answer() turns errors into bridge replies and never throws", async () => {
  const ctl = new AgentController(fakeHost().host, memStore());
  const bad = await answer(ctl, {
    id: "1",
    op: "goto",
    params: { position: "x" },
  });
  assertEquals([bad.ok, bad.status, bad.error?.code], [
    false,
    422,
    "validation_failed",
  ]);
  const good = await answer(ctl, { id: "2", op: "status" });
  assertEquals([good.ok, good.status], [true, 200]);
});
