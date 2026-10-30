// CUSTOM (symrho fork): plain-text scripts for spoken delivery.
//
// Three things are kept apart, on purpose:
//
//   A. the original script, exactly as supplied;
//   B. an optional agent-prepared version of it (rewritten for speech by
//      something *outside* the prompter);
//   C. presentation: how either one is laid out on the screen.
//
// Nothing here rewrites words. `thoughtGroups` only decides where lines
// break, and `cues` only decides how [bracketed directions] look; the text
// that is spoken is always the text that was supplied. DOM-free and tested.

export type ScriptPresentation = {
  /** Break each paragraph into short spoken phrases, one per line. */
  thoughtGroups: boolean;
  /** Longest phrase, in words, before a break is forced. */
  maxGroupWords: number;
  /** How to show [bracketed] stage directions such as "[Pause.]". */
  cues: "show" | "dim" | "hide";
};

export const DEFAULT_PRESENTATION: Readonly<ScriptPresentation> = Object
  .freeze({
    thoughtGroups: true,
    maxGroupWords: 6,
    cues: "dim",
  });

/** Text Scale-independent colour for a cue: the palette's pale blue. */
export const CUE_COLOUR = "#7aa2ff";

export type ScriptRecord = {
  /** A: the script as supplied. */
  original: string;
  /** B: an agent-prepared version, or null when there is none. */
  prepared: string | null;
  /** Which of the two is on screen. */
  active: "original" | "prepared";
  /** C: layout of the active text. */
  presentation: ScriptPresentation;
  /** The document it was loaded into. */
  documentName: string;
  /** Speaking rate the timing estimate is made against. */
  targetWpm: number;
  loadedAt: string;
};

export const DEFAULT_WPM = 130;
export const WPM_LIMITS = { min: 60, max: 260 } as const;
/** Large enough for any video script, small enough to refuse a pasted book. */
export const MAX_SCRIPT_CHARS = 100_000;

/** The text a record puts on screen. */
export function activeText(rec: ScriptRecord): string {
  return rec.active === "prepared" && rec.prepared !== null
    ? rec.prepared
    : rec.original;
}

/** Normalise line endings and trim each line's trailing space. */
export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd())
    .join("\n").trim();
}

/**
 * Paragraphs: separated by one or more blank lines. A single line break inside
 * a paragraph is kept as a line break — the author put it there.
 */
export function paragraphs(text: string): string[][] {
  const norm = normaliseText(text);
  if (!norm) return [];
  return norm.split(/\n\s*\n+/).map((p) => p.split("\n"));
}

const CUE = /\[[^\]\n]*\]/g;

/**
 * Words that are spoken. Bracketed cues are not; a dash on its own is not.
 * Counted per line and joined with a separator, so two lines never fuse into
 * one token (see the `textContent` trap in CLAUDE.md).
 */
export function countWords(text: string): number {
  let n = 0;
  for (const line of normaliseText(text).split("\n")) {
    for (const token of line.replace(CUE, " ").split(/\s+/)) {
      if (/[\p{L}\p{N}]/u.test(token)) n++;
    }
  }
  return n;
}

/** Seconds to say `words` at `wpm`. */
export function estimateSeconds(words: number, wpm: number): number {
  if (!(wpm > 0)) return 0;
  return (words / wpm) * 60;
}

/** "1:29" — minutes and zero-padded seconds, rounded to the nearest second. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type ScriptTiming = {
  words: number;
  targetWpm: number;
  estimatedSeconds: number;
  estimatedDuration: string;
};

export function timing(text: string, wpm: number): ScriptTiming {
  const words = countWords(text);
  const seconds = estimateSeconds(words, wpm);
  return {
    words,
    targetWpm: wpm,
    estimatedSeconds: Math.round(seconds * 10) / 10,
    estimatedDuration: formatDuration(seconds),
  };
}

/**
 * Split one line of prose into spoken phrases.
 *
 * Breaks after sentence ends and after clause punctuation (, ; : and dashes)
 * once a phrase has at least two words, and forces a break at `maxWords`.
 * Words are never changed, dropped or reordered: joining the result with
 * spaces gives back the line, which the tests check.
 */
export function thoughtGroups(line: string, maxWords: number): string[] {
  const tokens = line.split(/\s+/).filter(Boolean);
  const groups: string[] = [];
  let current: string[] = [];
  let spoken = 0;
  const flush = () => {
    if (current.length) groups.push(current.join(" "));
    current = [];
    spoken = 0;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // A cue stands on a line of its own: it is an instruction, not a phrase.
    if (/^\[[^\]]*\]$/.test(tok) || tok.startsWith("[")) {
      flush();
      // Collect a multi-word cue up to its closing bracket.
      const cue = [tok];
      while (!cue[cue.length - 1].includes("]") && i + 1 < tokens.length) {
        cue.push(tokens[++i]);
      }
      groups.push(cue.join(" "));
      continue;
    }
    // A dash between words ("on — and on") ends the phrase before it.
    if (/^[—–-]$/.test(tok)) {
      current.push(tok);
      flush();
      continue;
    }
    current.push(tok);
    spoken++;
    const sentenceEnd = /[.!?…]["'”’)]*$/.test(tok);
    const clauseEnd = /[,;:]["'”’)]*$/.test(tok);
    if (sentenceEnd || (clauseEnd && spoken >= 2) || spoken >= maxWords) {
      flush();
    }
  }
  flush();
  return groups;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLine(line: string, cues: ScriptPresentation["cues"]): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(CUE)) {
    out += escapeHtml(line.slice(last, m.index));
    if (cues === "show") out += escapeHtml(m[0]);
    else if (cues === "dim") {
      out += `<span style="color: ${CUE_COLOUR}">${escapeHtml(m[0])}</span>`;
    }
    last = m.index! + m[0].length;
  }
  out += escapeHtml(line.slice(last));
  return cues === "hide" ? out.replace(/\s{2,}/g, " ").trim() : out;
}

/**
 * The editor HTML for a plain-text script: one `<p>` per paragraph, a `<br>`
 * per line within it. Everything is escaped, so a script can never inject
 * markup into the controller or a display.
 */
export function scriptToHtml(
  text: string,
  presentation: ScriptPresentation,
): string {
  const paras = paragraphs(text);
  if (!paras.length) return "<p></p>";
  return paras.map((lines) => {
    const out: string[] = [];
    for (const line of lines) {
      const parts = presentation.thoughtGroups
        ? thoughtGroups(line, presentation.maxGroupWords)
        : [line];
      for (const part of parts) {
        const html = renderLine(part, presentation.cues);
        if (html) out.push(html);
      }
    }
    return `<p>${out.join("<br>")}</p>`;
  }).join("");
}
