// CUSTOM (symrho fork): the `linkedin-tmp100` preset.
//
// A viewer layout for reading direct to camera through a Glide Gear TMP100,
// with an iPad mini as the display and a webcam behind the glass. It is
// delivered as an ordinary *user theme* — CSS generated from the parameters
// below and stored through ThemeStorage — so it reaches the iPad over the
// existing ThemeMessage path, is replayed to a viewer that joins late by the
// existing catch-up, and needs no change to viewer.ts or protocol.ts. That is
// the whole reason it is CSS rather than new protocol: it keeps the fork's
// footprint on upstream's sync path at zero.
//
// DOM-free so it can be unit-tested, like themes.ts.

/** The preset's public name, as the agent API and the docs spell it. */
export const TMP100_PRESET = "linkedin-tmp100";

/**
 * The theme slug the preset is stored under.
 *
 * Fixed rather than minted by `uniqueSlug`, so the API, the TMP100 card and a
 * reload all agree on which theme is the preset. It carries the user-theme
 * prefix, which is what makes the viewer treat it like any other user theme.
 */
export const TMP100_SLUG = "theme-user-linkedin-tmp100";

export const TMP100_NAME = "LinkedIn / TMP100";

export type Tmp100Params = {
  /** Mirror left-right, for reading off teleprompter glass. */
  mirror: boolean;
  /** Mirror top-bottom too, for rigs that reflect the display upside down. */
  flipVertical: boolean;
  /** Reading-column width, in characters (`ch` of the script's own font). */
  lineWidthCh: number;
  /** Line height, as a multiple of the font size. */
  lineSpacing: number;
  /** Space between paragraphs, in `em`. Intentional paragraph breaks show. */
  paragraphGap: number;
  /** Height of the reading line, as a percentage of the screen from the top. */
  readingLinePct: number;
  /** Whether to draw the small reading-line markers at the column edges. */
  readingMarker: boolean;
  /** Text alignment within the column. */
  align: "left" | "center";
};

/**
 * Defaults, chosen for an iPad mini in landscape about an arm's length away.
 *
 * The column is narrow on purpose: the camera is behind the middle of the
 * glass, and every character of line width is eye travel the camera sees. 16ch
 * at the preset's text size is about three to five words a line. The reading
 * line sits a little above the middle because that is where the lens usually
 * is on a tablet rig; it is the first thing worth adjusting on the real glass.
 */
export const TMP100_DEFAULTS: Readonly<Tmp100Params> = Object.freeze({
  mirror: true,
  flipVertical: false,
  lineWidthCh: 16,
  lineSpacing: 1.3,
  paragraphGap: 0.9,
  readingLinePct: 40,
  readingMarker: true,
  align: "left",
});

/** The text size and speed applied with the preset (Text Scale rem, px/s). */
export const TMP100_TEXT_SCALE = 4;

/** Bounds, shared by the validator, the TMP100 card's sliders and the docs. */
export const TMP100_LIMITS = {
  lineWidthCh: { min: 8, max: 60 },
  lineSpacing: { min: 0.9, max: 3 },
  paragraphGap: { min: 0, max: 4 },
  readingLinePct: { min: 5, max: 95 },
} as const;

export type FieldError = { field: string; message: string };

/**
 * Check a partial update against the parameter types and bounds.
 *
 * Out-of-range numbers are refused rather than clamped. An agent that asks for
 * a 200ch column has made a mistake worth telling it about; quietly applying
 * 60 would leave it believing the screen shows something it does not.
 */
export function validateTmp100Patch(
  patch: unknown,
  prefix = "",
): { ok: true; value: Partial<Tmp100Params> } | {
  ok: false;
  errors: FieldError[];
} {
  const errors: FieldError[] = [];
  const value: Partial<Tmp100Params> = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return {
      ok: false,
      errors: [{ field: prefix || "body", message: "must be an object" }],
    };
  }
  for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
    const field = prefix ? `${prefix}.${key}` : key;
    switch (key) {
      case "mirror":
      case "flipVertical":
      case "readingMarker":
        if (typeof raw !== "boolean") {
          errors.push({ field, message: "must be true or false" });
        } else value[key] = raw;
        break;
      case "align":
        if (raw !== "left" && raw !== "center") {
          errors.push({ field, message: 'must be "left" or "center"' });
        } else value.align = raw;
        break;
      case "lineWidthCh":
      case "lineSpacing":
      case "paragraphGap":
      case "readingLinePct": {
        const { min, max } = TMP100_LIMITS[key];
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          errors.push({ field, message: "must be a number" });
        } else if (raw < min || raw > max) {
          errors.push({ field, message: `must be between ${min} and ${max}` });
        } else value[key] = raw;
        break;
      }
      default:
        errors.push({ field, message: "is not a TMP100 setting" });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Read stored parameters, falling back field by field to the defaults. */
export function parseTmp100(raw: string | null): Tmp100Params {
  if (!raw) return { ...TMP100_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...TMP100_DEFAULTS };
  }
  const out: Tmp100Params = { ...TMP100_DEFAULTS };
  if (!parsed || typeof parsed !== "object") return out;
  // One bad field drops that field, not the whole record — the same tolerance
  // parseThemes and parseDocs have.
  for (const [key, value] of Object.entries(parsed)) {
    const one = validateTmp100Patch({ [key]: value });
    if (one.ok) Object.assign(out, one.value);
  }
  return out;
}

/**
 * The preset's stylesheet.
 *
 * Written against the fixed viewer markup (see THEME_TEMPLATE in themes.ts):
 * `#stage` is the scroller, `#header` the clock strip, `#main` the script.
 *
 * - Sizes are in `cqh`/`ch`, never viewport units, for the reason
 *   viewerThemes.css gives: every display lays out in the reference box.
 * - `#main` is padded by the reading line above and by the rest of the screen
 *   below, so position 0 puts the first line *on* the reading line and the end
 *   of the script can reach it too. Nothing in the sync maths needs to know.
 * - The mirror is a transform on `#main` and the reading markers, not on
 *   `#stage`: the stage's own transform is how a display is fitted to its
 *   screen, and a second one there would replace it.
 * - The clock strip is reduced to a zero-height sticky row and reused to carry
 *   the reading markers. Clocks and messages are hidden: the iPad shows the
 *   script and nothing else while prompting.
 */
export function tmp100Css(p: Tmp100Params): string {
  const flip = `scale(${p.mirror ? -1 : 1}, ${p.flipVertical ? -1 : 1})`;
  const below = 100 - p.readingLinePct;
  // With a vertical flip the screen's top is the reflection's bottom, so the
  // reading line is measured from the other end to stay where the reader sees
  // it.
  const line = p.flipVertical ? below : p.readingLinePct;
  const marker = p.readingMarker
    ? `
#header::before,
#header::after {
  content: "";
  position: absolute;
  top: calc(${line}cqh - 0.6rem);
  border-block: 0.6rem solid transparent;
}
#header::before {
  left: 0.4rem;
  border-left: 1.1rem solid var(--tmp100-marker);
}
#header::after {
  right: 0.4rem;
  border-right: 1.1rem solid var(--tmp100-marker);
}`
    : "";
  return `/* ${TMP100_NAME} (${TMP100_PRESET}) — generated by the TMP100 card.
   Edits made here are replaced the next time the preset's settings change. */
:root {
  --viewer-bg: black;
  --viewer-color: white;
  --tmp100-marker: #666;
  --viewer-block-gap: 0;
}
#stage {
  scrollbar-width: none;
}
#header {
  position: sticky;
  top: 0;
  height: 0;
  padding: 0;
  overflow: visible;
  z-index: 10;
}
#header > * {
  display: none;
}${marker}
#main {
  font-family: -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif;
  font-weight: 600;
  font-size: var(--textScale);
  line-height: ${p.lineSpacing};
  text-align: ${p.align};
  box-sizing: content-box;
  width: min(100% - 2 * var(--viewer-gutter), ${p.lineWidthCh}ch);
  margin-inline: auto;
  padding: calc(${p.readingLinePct}cqh - 0.5lh) 0 ${below}cqh;
  transform: ${flip};
  hyphens: none;
}
#main p + p {
  margin-top: ${p.paragraphGap}em;
}
`;
}

// The slice of localStorage this needs, injected so tests can hand it a map.
export interface Tmp100Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TMP100_KEY = "teleprompter.custom.tmp100";

/** The preset's parameters, remembered for this browser. */
export class Tmp100Storage {
  #store: Tmp100Store;
  #params: Tmp100Params;

  constructor(store: Tmp100Store = localStorage) {
    this.#store = store;
    let raw: string | null = null;
    try {
      raw = store.getItem(TMP100_KEY);
    } catch {
      // Private mode or a blocked store: run on the defaults.
    }
    this.#params = parseTmp100(raw);
  }

  get(): Tmp100Params {
    return { ...this.#params };
  }

  update(patch: Partial<Tmp100Params>): Tmp100Params {
    this.#params = { ...this.#params, ...patch };
    try {
      this.#store.setItem(TMP100_KEY, JSON.stringify(this.#params));
    } catch {
      // Not persisted; the screen still shows it for this session.
    }
    return this.get();
  }
}
