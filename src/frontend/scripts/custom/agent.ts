// CUSTOM (symrho fork): what the agent API's operations *do*.
//
// The server (agentapi.go) only relays; every request lands here, in the
// control page, as an operation name and a JSON object. This module validates
// it and carries it out through `AgentHost` — a handful of closures the control
// page builds over its own sliders and functions. It holds no prompter state
// of its own beyond the script records (the original/prepared text, which the
// editor has no place for) and the target WPM.
//
// DOM-free, with the host and the storage injected, so the whole operation
// set is unit-tested against a fake host.

import {
  activeText,
  DEFAULT_PRESENTATION,
  DEFAULT_WPM,
  MAX_SCRIPT_CHARS,
  type ScriptPresentation,
  type ScriptRecord,
  scriptToHtml,
  timing,
  WPM_LIMITS,
} from "./script.ts";
import {
  type FieldError,
  TMP100_DEFAULTS,
  TMP100_LIMITS,
  TMP100_PRESET,
  TMP100_SLUG,
  TMP100_TEXT_SCALE,
  type Tmp100Params,
  validateTmp100Patch,
} from "./tmp100.ts";

/** Bumped only for a breaking change; additions keep the same version. */
export const AGENT_API_VERSION = 1;

/** The Scroll Speed slider's range, in stage pixels per second. */
export const SPEED_LIMITS = { min: -500, max: 500 } as const;
/** The Text Scale slider's range, in rem. */
export const TEXT_SCALE_LIMITS = { min: 0.1, max: 10 } as const;

/** Built-in layouts by their API names. */
export const PRESETS: Record<string, string> = {
  [TMP100_PRESET]: TMP100_SLUG,
  "default": "theme-default",
  "big-clock": "theme-big-clock",
};

export type HostSnapshot = {
  /** Forward is positive, in stage px/s. */
  speed: number;
  /** The Space-bar state: whether the pacer is allowed to move. */
  running: boolean;
  textScale: number;
  layout: string;
  layoutName: string;
  viewers: { connected: number; local: number; remote: number };
  signaling: boolean;
  /** 0..1, the shared scroll position. */
  position: number;
  liveEditing: boolean;
  /** Edits are being held back from the displays. */
  draftHeld: boolean;
  pdfOpen: boolean;
  document: { id: string; name: string };
};

/** The control page, as the agent API sees it. */
export interface AgentHost {
  snapshot(): HostSnapshot;
  setSpeed(pxPerSecond: number): void;
  setRunning(running: boolean): void;
  setTextScale(rem: number): void;
  /** Apply a layout by slug. The TMP100 slug also applies its text size. */
  setLayout(slug: string): void;
  tmp100(): Tmp100Params;
  updateTmp100(patch: Partial<Tmp100Params>): void;
  goto(position: number): void;
  /** Write and open a document, and publish it to the displays. */
  loadDocument(name: string, html: string): void;
  /** The text the displays are showing, one line per line. */
  displayedText(): string;
  /** The displays' scroll range, measured on the preview, or null. */
  scrollRange(): number | null;
  /** Resolve once the displays have had time to lay out a change. */
  settle(): Promise<void>;
}

export interface AgentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORE_KEY = "teleprompter.custom.agent";

type Stored = {
  targetWpm: number;
  /** Script records by document id. */
  scripts: Record<string, ScriptRecord>;
};

export class AgentError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: FieldError[],
  ) {
    super(message);
  }
}

function invalid(fields: FieldError[]): AgentError {
  return new AgentError(
    422,
    "validation_failed",
    fields.map((f) => `${f.field} ${f.message}`).join("; "),
    fields,
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(
  errors: FieldError[],
  field: string,
  v: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push({ field, message: "must be a number" });
  } else if (v < min || v > max) {
    errors.push({ field, message: `must be between ${min} and ${max}` });
  } else return v;
  return undefined;
}

function bool(errors: FieldError[], field: string, v: unknown) {
  if (typeof v !== "boolean") {
    errors.push({ field, message: "must be true or false" });
    return undefined;
  }
  return v;
}

function unknownKeys(
  errors: FieldError[],
  params: Record<string, unknown>,
  allowed: readonly string[],
  prefix = "",
) {
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) {
      errors.push({ field: prefix + k, message: "is not a recognised field" });
    }
  }
}

const TMP100_KEYS = Object.keys(TMP100_DEFAULTS) as (keyof Tmp100Params)[];

function presentationFrom(
  errors: FieldError[],
  raw: unknown,
  base: ScriptPresentation,
): ScriptPresentation {
  if (raw === undefined) return base;
  if (!isObject(raw)) {
    errors.push({ field: "presentation", message: "must be an object" });
    return base;
  }
  unknownKeys(
    errors,
    raw,
    ["thoughtGroups", "maxGroupWords", "cues"],
    "presentation.",
  );
  const out = { ...base };
  if ("thoughtGroups" in raw) {
    const v = bool(errors, "presentation.thoughtGroups", raw.thoughtGroups);
    if (v !== undefined) out.thoughtGroups = v;
  }
  if ("maxGroupWords" in raw) {
    const v = num(
      errors,
      "presentation.maxGroupWords",
      raw.maxGroupWords,
      2,
      20,
    );
    if (v !== undefined) out.maxGroupWords = Math.round(v);
  }
  if ("cues" in raw) {
    if (raw.cues === "show" || raw.cues === "dim" || raw.cues === "hide") {
      out.cues = raw.cues;
    } else {
      errors.push({
        field: "presentation.cues",
        message: 'must be "show", "dim" or "hide"',
      });
    }
  }
  return out;
}

function scriptText(errors: FieldError[], field: string, v: unknown) {
  if (typeof v !== "string") {
    errors.push({ field, message: "must be a string" });
  } else if (!v.trim()) {
    errors.push({ field, message: "must not be empty" });
  } else if (v.length > MAX_SCRIPT_CHARS) {
    errors.push({
      field,
      message: `must be at most ${MAX_SCRIPT_CHARS} characters`,
    });
  } else return v;
  return undefined;
}

export class AgentController {
  #host: AgentHost;
  #store: AgentStore;
  #state: Stored;
  #now: () => Date;

  constructor(host: AgentHost, store: AgentStore, now = () => new Date()) {
    this.#host = host;
    this.#store = store;
    this.#now = now;
    this.#state = { targetWpm: DEFAULT_WPM, scripts: {} };
    try {
      const raw = JSON.parse(store.getItem(STORE_KEY) ?? "null");
      if (isObject(raw)) {
        if (
          typeof raw.targetWpm === "number" &&
          raw.targetWpm >= WPM_LIMITS.min && raw.targetWpm <= WPM_LIMITS.max
        ) this.#state.targetWpm = raw.targetWpm;
        if (isObject(raw.scripts)) {
          this.#state.scripts = raw.scripts as Record<string, ScriptRecord>;
        }
      }
    } catch {
      // A corrupt record costs the stored originals, never the page.
    }
  }

  #save() {
    try {
      this.#store.setItem(STORE_KEY, JSON.stringify(this.#state));
    } catch {
      // Over quota or blocked: the script is still on screen.
    }
  }

  /** Run one operation. Throws AgentError for anything the caller got wrong. */
  async handle(op: string, params: unknown): Promise<unknown> {
    const p = params === undefined || params === null ? {} : params;
    if (!isObject(p)) {
      throw invalid([{ field: "body", message: "must be a JSON object" }]);
    }
    switch (op) {
      case "status":
        return this.status();
      case "get_script":
        return this.getScript();
      case "load_script":
        return await this.loadScript(p);
      case "update_script":
        return await this.updateScript(p);
      case "get_config":
        return this.config();
      case "configure":
        return await this.configure(p);
      case "list_presets":
        return this.presets();
      case "start":
      case "resume":
        return this.start(op);
      case "pause":
        this.#noFields(p, []);
        this.#host.setRunning(false);
        return this.status();
      case "start_over":
        return await this.startOver(p);
      case "goto":
        return this.goto(p);
      default:
        throw new AgentError(404, "unknown_operation", `no operation ${op}`);
    }
  }

  #noFields(p: Record<string, unknown>, allowed: string[]) {
    const errors: FieldError[] = [];
    unknownKeys(errors, p, allowed);
    if (errors.length) throw invalid(errors);
  }

  #record(): ScriptRecord | undefined {
    return this.#state.scripts[this.#host.snapshot().document.id];
  }

  #timing() {
    return timing(this.#host.displayedText(), this.#state.targetWpm);
  }

  /** The speed that reads the displayed script at the target WPM, or null. */
  suggestedSpeed(): number | null {
    const range = this.#host.scrollRange();
    const t = this.#timing();
    if (range === null || !(range > 0) || !(t.estimatedSeconds > 0)) {
      return null;
    }
    const speed = range / t.estimatedSeconds;
    return Math.round(Math.min(SPEED_LIMITS.max, speed) * 10) / 10;
  }

  status() {
    const s = this.#host.snapshot();
    const t = this.#timing();
    const scrolling = s.running && s.speed !== 0;
    const atStart = s.position < 0.01;
    const checks = [
      {
        check: "viewer",
        ok: s.viewers.connected > 0,
        required: true,
        message: s.viewers.connected > 0
          ? `${s.viewers.connected} display(s) connected`
          : "no display connected: open the viewer link on the iPad",
      },
      {
        check: "script",
        ok: t.words > 0 && !s.pdfOpen,
        required: true,
        message: s.pdfOpen
          ? "a PDF is showing instead of the script"
          : t.words > 0
          ? `${t.words} words loaded`
          : "no script loaded",
      },
      {
        check: "published",
        ok: !s.draftHeld,
        required: true,
        message: s.draftHeld
          ? "live editing is off and the displays are behind the editor"
          : "displays show the editor's script",
      },
      {
        check: "speed",
        ok: s.speed > 0,
        required: true,
        message: s.speed > 0
          ? `scroll speed ${s.speed}`
          : "scroll speed is 0 or reversed; set one or use speedFromWpm",
      },
      {
        check: "at_start",
        ok: atStart,
        required: true,
        message: atStart ? "at the beginning" : "not at the beginning",
      },
      {
        check: "paused",
        ok: !scrolling,
        required: true,
        message: scrolling ? "scrolling" : "paused",
      },
      {
        check: "preset",
        ok: s.layout === TMP100_SLUG,
        required: false,
        message: s.layout === TMP100_SLUG
          ? `layout ${TMP100_PRESET}`
          : `layout is ${s.layoutName}, not ${TMP100_PRESET}`,
      },
    ];
    const ready = checks.every((c) => c.ok || !c.required);
    const state = s.viewers.connected === 0
      ? "NO_VIEWER"
      : scrolling
      ? "RUNNING"
      : ready
      ? "READY"
      : !atStart && s.speed > 0
      ? "PAUSED"
      : "NOT_READY";
    return {
      apiVersion: AGENT_API_VERSION,
      state,
      ready,
      connected: true,
      readiness: checks,
      playback: {
        running: s.running,
        scrolling,
        speed: s.speed,
        position: Math.round(s.position * 10000) / 10000,
      },
      displays: { ...s.viewers, signaling: s.signaling },
      layout: { preset: this.#presetName(s.layout), name: s.layoutName },
      textScale: s.textScale,
      script: {
        document: s.document.name,
        loadedByAgent: !!this.#record(),
        ...t,
        remainingSeconds: Math.round(t.estimatedSeconds * (1 - s.position)),
        suggestedSpeed: this.suggestedSpeed(),
      },
      liveEditing: s.liveEditing,
    };
  }

  #presetName(slug: string): string | null {
    for (const [name, s] of Object.entries(PRESETS)) {
      if (s === slug) return name;
    }
    return null;
  }

  getScript() {
    const s = this.#host.snapshot();
    const rec = this.#record();
    const displayed = this.#host.displayedText();
    return {
      document: s.document.name,
      original: rec?.original ?? null,
      prepared: rec?.prepared ?? null,
      active: rec?.active ?? null,
      presentation: rec?.presentation ?? null,
      loadedAt: rec?.loadedAt ?? null,
      displayedText: displayed,
      timing: this.#timing(),
    };
  }

  async loadScript(p: Record<string, unknown>) {
    const errors: FieldError[] = [];
    unknownKeys(errors, p, [
      "text",
      "prepared",
      "active",
      "presentation",
      "document",
      "targetWpm",
      "preset",
      "speedFromWpm",
    ]);
    const text = scriptText(errors, "text", p.text);
    let prepared: string | null = null;
    if (p.prepared !== undefined && p.prepared !== null) {
      prepared = scriptText(errors, "prepared", p.prepared) ?? null;
    }
    let active: ScriptRecord["active"] = prepared !== null
      ? "prepared"
      : "original";
    if (p.active !== undefined) {
      if (p.active !== "original" && p.active !== "prepared") {
        errors.push({
          field: "active",
          message: 'must be "original" or "prepared"',
        });
      } else if (p.active === "prepared" && prepared === null) {
        errors.push({
          field: "active",
          message: '"prepared" needs a prepared text',
        });
      } else active = p.active;
    }
    const presentation = presentationFrom(
      errors,
      p.presentation,
      DEFAULT_PRESENTATION,
    );
    let name = "Agent script";
    if (p.document !== undefined) {
      if (
        typeof p.document !== "string" || !p.document.trim() ||
        p.document.length > 120
      ) {
        errors.push({
          field: "document",
          message: "must be a name of 1 to 120 characters",
        });
      } else name = p.document.trim();
    }
    const wpm = p.targetWpm === undefined
      ? undefined
      : num(errors, "targetWpm", p.targetWpm, WPM_LIMITS.min, WPM_LIMITS.max);
    const preset = this.#presetParam(errors, p.preset);
    const speedFromWpm = p.speedFromWpm === undefined
      ? true
      : bool(errors, "speedFromWpm", p.speedFromWpm);
    if (errors.length || text === undefined) throw invalid(errors);

    const record: ScriptRecord = {
      original: text,
      prepared,
      active,
      presentation,
      documentName: name,
      targetWpm: wpm ?? this.#state.targetWpm,
      loadedAt: this.#now().toISOString(),
    };
    if (wpm !== undefined) this.#state.targetWpm = wpm;

    // A new script never starts moving on its own.
    this.#host.setRunning(false);
    if (preset) this.#host.setLayout(PRESETS[preset]);
    this.#host.loadDocument(
      name,
      scriptToHtml(activeText(record), presentation),
    );
    this.#state.scripts[this.#host.snapshot().document.id] = record;
    this.#save();

    await this.#host.settle();
    this.#host.goto(0);
    if (speedFromWpm) this.#applySpeedFromWpm(false);
    return this.status();
  }

  async updateScript(p: Record<string, unknown>) {
    const rec = this.#record();
    if (!rec) {
      throw new AgentError(
        409,
        "no_agent_script",
        "the open document was not loaded through the API; PUT /api/script first",
      );
    }
    const errors: FieldError[] = [];
    unknownKeys(errors, p, ["prepared", "active", "presentation"]);
    const next = { ...rec };
    if ("prepared" in p) {
      next.prepared = p.prepared === null
        ? null
        : scriptText(errors, "prepared", p.prepared) ?? rec.prepared;
      if (next.prepared === null && next.active === "prepared") {
        next.active = "original";
      }
    }
    if (p.active !== undefined) {
      if (p.active !== "original" && p.active !== "prepared") {
        errors.push({
          field: "active",
          message: 'must be "original" or "prepared"',
        });
      } else if (p.active === "prepared" && next.prepared === null) {
        errors.push({
          field: "active",
          message: '"prepared" needs a prepared text',
        });
      } else next.active = p.active;
    }
    next.presentation = presentationFrom(
      errors,
      p.presentation,
      rec.presentation,
    );
    if (errors.length) throw invalid(errors);

    this.#host.setRunning(false);
    this.#host.loadDocument(
      rec.documentName,
      scriptToHtml(activeText(next), next.presentation),
    );
    this.#state.scripts[this.#host.snapshot().document.id] = next;
    this.#save();
    await this.#host.settle();
    this.#host.goto(0);
    return this.getScript();
  }

  config() {
    const s = this.#host.snapshot();
    return {
      preset: this.#presetName(s.layout),
      layout: s.layoutName,
      speed: s.speed,
      textScale: s.textScale,
      targetWpm: this.#state.targetWpm,
      tmp100: this.#host.tmp100(),
    };
  }

  presets() {
    return {
      presets: [
        {
          name: TMP100_PRESET,
          description:
            "Mirrored, narrow, high-contrast column for an iPad mini in a TMP100 with a webcam behind the glass",
          textScale: TMP100_TEXT_SCALE,
          defaults: TMP100_DEFAULTS,
          limits: TMP100_LIMITS,
        },
        { name: "default", description: "Upstream's clocks and text layout" },
        { name: "big-clock", description: "Upstream's clocks-only layout" },
      ],
    };
  }

  #presetParam(errors: FieldError[], v: unknown): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !(v in PRESETS)) {
      errors.push({
        field: "preset",
        message: `must be one of ${Object.keys(PRESETS).join(", ")}`,
      });
      return undefined;
    }
    return v;
  }

  #applySpeedFromWpm(strict: boolean) {
    const speed = this.suggestedSpeed();
    if (speed === null || speed <= 0) {
      if (strict) {
        throw new AgentError(
          409,
          "cannot_measure",
          "cannot work out a speed: load a script and keep the control page's preview visible",
        );
      }
      return;
    }
    this.#host.setSpeed(speed);
  }

  async configure(p: Record<string, unknown>) {
    const errors: FieldError[] = [];
    const tmp100Patch: Record<string, unknown> = {};
    for (const k of TMP100_KEYS) if (k in p) tmp100Patch[k] = p[k];
    unknownKeys(errors, p, [
      "preset",
      "speed",
      "textScale",
      "targetWpm",
      "speedFromWpm",
      ...TMP100_KEYS,
    ]);
    const preset = this.#presetParam(errors, p.preset);
    const speed = p.speed === undefined
      ? undefined
      : num(errors, "speed", p.speed, SPEED_LIMITS.min, SPEED_LIMITS.max);
    const textScale = p.textScale === undefined ? undefined : num(
      errors,
      "textScale",
      p.textScale,
      TEXT_SCALE_LIMITS.min,
      TEXT_SCALE_LIMITS.max,
    );
    const wpm = p.targetWpm === undefined
      ? undefined
      : num(errors, "targetWpm", p.targetWpm, WPM_LIMITS.min, WPM_LIMITS.max);
    const fromWpm = p.speedFromWpm === undefined
      ? false
      : bool(errors, "speedFromWpm", p.speedFromWpm);
    if (fromWpm && speed !== undefined) {
      errors.push({
        field: "speedFromWpm",
        message: "cannot be combined with speed",
      });
    }
    let patch: Partial<Tmp100Params> = {};
    if (Object.keys(tmp100Patch).length) {
      const r = validateTmp100Patch(tmp100Patch);
      if (r.ok) patch = r.value;
      else errors.push(...r.errors);
    }
    // Nothing is applied unless everything is valid: a half-applied
    // configuration is harder to reason about than a refused one.
    if (errors.length) throw invalid(errors);

    let relayout = false;
    if (preset) {
      this.#host.setLayout(PRESETS[preset]);
      relayout = true;
    }
    if (Object.keys(patch).length) {
      this.#host.updateTmp100(patch);
      relayout = true;
    }
    if (textScale !== undefined) {
      this.#host.setTextScale(textScale);
      relayout = true;
    }
    if (wpm !== undefined) {
      this.#state.targetWpm = wpm;
      this.#save();
    }
    if (speed !== undefined) this.#host.setSpeed(speed);
    if (fromWpm) {
      if (relayout) await this.#host.settle();
      this.#applySpeedFromWpm(true);
    }
    return this.config();
  }

  start(op: string) {
    const s = this.#host.snapshot();
    if (s.speed === 0) {
      throw new AgentError(
        409,
        "speed_zero",
        `cannot ${op}: the scroll speed is 0; PATCH /api/config with speed or speedFromWpm`,
      );
    }
    if (s.viewers.connected === 0) {
      throw new AgentError(
        409,
        "no_viewer",
        `cannot ${op}: no display is connected`,
      );
    }
    this.#host.setRunning(true);
    return this.status();
  }

  async startOver(p: Record<string, unknown>) {
    const errors: FieldError[] = [];
    unknownKeys(errors, p, ["run"]);
    const run = p.run === undefined ? false : bool(errors, "run", p.run);
    if (errors.length) throw invalid(errors);
    this.#host.setRunning(false);
    this.#host.goto(0);
    if (run) {
      await this.#host.settle();
      return this.start("start");
    }
    return this.status();
  }

  goto(p: Record<string, unknown>) {
    const errors: FieldError[] = [];
    unknownKeys(errors, p, ["position", "percent"]);
    let pos: number | undefined;
    if ("position" in p && "percent" in p) {
      errors.push({
        field: "position",
        message: "give position or percent, not both",
      });
    } else if ("position" in p) {
      pos = num(errors, "position", p.position, 0, 1);
    } else if ("percent" in p) {
      const pct = num(errors, "percent", p.percent, 0, 100);
      if (pct !== undefined) pos = pct / 100;
    } else {
      errors.push({
        field: "position",
        message: "is required (0 to 1), or give percent",
      });
    }
    if (errors.length || pos === undefined) throw invalid(errors);
    this.#host.goto(pos);
    return this.status();
  }
}

/** What the bridge sends back for one request. */
export type BridgeReply = {
  id: string;
  ok: boolean;
  status?: number;
  result?: unknown;
  error?: { code: string; message: string; fields?: FieldError[] };
};

/** Run a bridge request and shape the reply, never throwing. */
export async function answer(
  ctl: AgentController,
  req: { id: string; op: string; params?: unknown },
): Promise<BridgeReply> {
  try {
    const result = await ctl.handle(req.op, req.params);
    return { id: req.id, ok: true, status: 200, result };
  } catch (err) {
    if (err instanceof AgentError) {
      return {
        id: req.id,
        ok: false,
        status: err.status,
        error: { code: err.code, message: err.message, fields: err.fields },
      };
    }
    console.error("agent API operation failed", req.op, err);
    return {
      id: req.id,
      ok: false,
      status: 500,
      error: { code: "internal", message: String(err) },
    };
  }
}
