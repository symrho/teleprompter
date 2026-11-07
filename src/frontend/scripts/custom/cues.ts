// CUSTOM (symrho fork): cue events — which `[CUE id · LABEL]` line has just
// crossed the reading line.
//
// The video pipeline switches OBS scenes off these, so the prompter only has
// to say *when* the talent reached a cue; it knows nothing about scenes. This
// module is the DOM-free half: the cue grammar, and the state machine that
// turns a stream of scroll positions into crossings. `cueControls.ts` measures
// the preview, which supplies the geometry.
//
// Why the preview: every display lays out in the reference box and the preview
// *is* that box (see the stage section in CLAUDE.md), so a position measured
// there is every display's position. Nothing new travels over WebRTC, and the
// viewer is unchanged.

/** A cue as written in the script. */
export type Cue = {
  id: string;
  label: string;
  /** The cue exactly as it appears, brackets included. */
  text: string;
};

// `[CUE <id> · <LABEL>]`. The id is one token; the label is everything after
// the first middle dot, so a label may carry dots of its own
// (`[CUE E · END CARD · HOLD 3 S, THEN STOP]` is id E). Any other bracketed
// text — `[PAUSE]`, `[CUE]` with no label — is a direction, not a cue.
const CUE_LINE = /^\[CUE\s+([^\s\]·]+)\s*·\s*([^\]]*?)\s*\]$/u;

/** The cue a line *is*, or null. The line must hold the cue and nothing else. */
export function parseCue(line: string): Cue | null {
  const text = line.trim();
  const m = CUE_LINE.exec(text);
  if (!m || !m[2]) return null;
  return { id: m[1], label: m[2], text };
}

/** Every cue in a plain-text script, in order — one per line it stands on. */
export function cuesInText(script: string): Cue[] {
  const out: Cue[] = [];
  for (const line of script.split(/\r\n?|\n/)) {
    const cue = parseCue(line);
    if (cue) out.push(cue);
  }
  return out;
}

/** A cue placed in the reference display's document. */
export type CueMark = Cue & {
  /**
   * Where the bottom of the cue's text sits, in stage pixels from the top of
   * the scrollable content (i.e. the same space as `scrollTop`).
   */
  y: number;
};

/** What the tracker needs to know about the displays, at one moment. */
export type CueGeometry = {
  /** `scrollHeight - clientHeight` of the reference stage. */
  range: number;
  /** How far below the stage's scroll top the reading line sits, in px. */
  readingLine: number;
  /** The cues, in document order. */
  cues: CueMark[];
};

export type PlaybackState = "running" | "paused" | "reset";

export type CueEventData = {
  id: string;
  label: string;
  text: string;
  /** Position of this cue among all the script's cues, from 0. */
  index: number;
  at: string;
  position: number;
};

export type PlaybackEventData = {
  state: PlaybackState;
  at: string;
  position: number;
};

export type CueStreamEvent =
  | { event: "cue"; data: CueEventData }
  | { event: "playback"; data: PlaybackEventData };

/** The shared position as the API reports it everywhere: four places. */
export function roundPosition(r: number): number {
  return Math.round(Math.min(1, Math.max(0, r)) * 10000) / 10000;
}

/**
 * Turns positions into crossings.
 *
 * A cue *fires* when a forward move carries the reading line over it: when its
 * offset lies in the stretch between where the reading line was and where it
 * is now. Nothing else fires — not a move backwards, not a jump, not a
 * relayout — and that one rule gives the whole contract:
 *
 * - a cue fires once, however many samples the crossing spans, because the
 *   stretches of consecutive samples do not overlap;
 * - scrolling back over it and forward again crosses it again, so it re-fires;
 * - start-over is a jump to 0, after which every cue is ahead: all re-armed.
 *
 * Both ends of the stretch are measured in the geometry of *now*. That is what
 * makes a relayout harmless: a cue that moves across the line because the
 * script was edited or resized has not been scrolled past, and with the ratio
 * unchanged the stretch is empty. Remembering a "behind" flag per cue instead
 * would fire it, or would need a layout signature to suppress that — and a
 * signature that changes mid-crossing loses the cue.
 *
 * The offset is the *bottom* of the cue's text, so a cue fires once it has
 * been read past, not merely reached. That is also what makes a cue on the
 * script's very first line fire at all: position 0 puts the first line *on*
 * the reading line (see tmp100Css), its bottom still below it, and the first
 * moment of scrolling carries it over.
 */
export class CueTracker {
  #ratio: number | null = null;

  /**
   * Feed one position. `jump` is for a position that was *set* — goto,
   * start-over, "send my position" — rather than scrolled to: jumping past
   * five cues must not switch five scenes in a burst.
   */
  observe(
    ratio: number,
    g: CueGeometry | null,
    jump = false,
  ): { cue: CueMark; index: number }[] {
    if (!Number.isFinite(ratio)) return [];
    const prev = this.#ratio;
    this.#ratio = ratio;
    // No direction test is needed: moving backwards makes `to` less than
    // `from`, and an empty stretch holds no cue.
    if (jump || !g || prev === null) return [];
    const range = Math.max(0, g.range);
    // Half a pixel of slack, so a cue measured a sub-pixel below a line that
    // has stopped exactly on it still counts as read.
    const from = prev * range + g.readingLine + 0.5;
    const to = ratio * range + g.readingLine + 0.5;
    const fired: { cue: CueMark; index: number }[] = [];
    g.cues.forEach((cue, index) => {
      if (cue.y > from && cue.y <= to) fired.push({ cue, index });
    });
    return fired;
  }
}

/**
 * The cue tracker wired to its inputs and its output. DOM-free: the page hands
 * it the geometry and somewhere to send events, so the whole thing is tested
 * with a fake of each.
 */
export class CueWatcher {
  readonly tracker = new CueTracker();
  #geometry: () => CueGeometry | null;
  #emit: (e: CueStreamEvent) => void;
  #now: () => Date;

  constructor(opts: {
    geometry: () => CueGeometry | null;
    emit: (e: CueStreamEvent) => void;
    now?: () => Date;
  }) {
    this.#geometry = opts.geometry;
    this.#emit = opts.emit;
    this.#now = opts.now ?? (() => new Date());
  }

  /** The displays moved: a pacer sample, a hand scroll, a scrub. */
  motion(ratio: number) {
    this.#observe(ratio, false);
  }

  /** The displays were put somewhere: goto, start-over, a re-anchor. */
  jump(ratio: number) {
    this.#observe(ratio, true);
  }

  playback(state: PlaybackState, ratio: number) {
    this.#emit({
      event: "playback",
      data: {
        state,
        at: this.#now().toISOString(),
        position: roundPosition(ratio),
      },
    });
  }

  #observe(ratio: number, jump: boolean) {
    const fired = this.tracker.observe(ratio, this.#geometry(), jump);
    if (!fired.length) return;
    const at = this.#now().toISOString();
    for (const { cue, index } of fired) {
      this.#emit({
        event: "cue",
        data: {
          id: cue.id,
          label: cue.label,
          text: cue.text,
          index,
          at,
          position: roundPosition(ratio),
        },
      });
    }
  }
}
