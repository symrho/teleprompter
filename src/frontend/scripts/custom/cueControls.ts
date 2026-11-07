// CUSTOM (symrho fork): the DOM half of cue events — where each cue sits in
// the preview, which stands in for every display (see cues.ts for why).
//
// Measured lazily and cached: the tracker asks on every pacer sample, ~60 a
// second, and walking the script's text and laying out a range per cue that
// often is pointless when nothing moved. The cache is dropped when the
// preview's script changes (a MutationObserver) or its box does (the key).
// Caching also keeps the offsets *stable* between relayouts, so a cue sitting
// exactly on the line cannot flicker across it from sub-pixel noise.

import { type CueGeometry, type CueMark, parseCue } from "./cues.ts";

export class PreviewCues {
  #stage: () => HTMLElement | null;
  #readingLine: (stage: HTMLElement) => number;
  #observed: Document | null = null;
  #observer: MutationObserver | null = null;
  #dirty = true;
  #key = "";
  #cues: CueMark[] = [];

  /**
   * @param stage The preview's `#stage`, resolved on every call: the iframe's
   *   document is replaced on every reload.
   * @param readingLine How far below the stage's scroll top the reading line
   *   sits, in stage px. The layout decides this, so the page supplies it.
   */
  constructor(
    stage: () => HTMLElement | null,
    readingLine: (stage: HTMLElement) => number,
  ) {
    this.#stage = stage;
    this.#readingLine = readingLine;
  }

  /** The geometry the tracker needs, or null with no preview to measure. */
  geometry(): CueGeometry | null {
    const stage = this.#stage();
    if (!stage) return null;
    this.#watch(stage.ownerDocument);
    const readingLine = this.#readingLine(stage);
    // The text scale, the theme and the stage's dimensions all change layout
    // without touching the script's DOM; scrollHeight moves with every one of
    // them that matters.
    const key =
      `${stage.scrollHeight}|${stage.clientHeight}|${stage.clientWidth}`;
    if (this.#dirty || key !== this.#key) {
      this.#cues = measureCues(stage);
      this.#key = key;
      this.#dirty = false;
    }
    return {
      range: stage.scrollHeight - stage.clientHeight,
      readingLine,
      cues: this.#cues,
    };
  }

  /** How many cues the displays are showing. */
  count(): number {
    return this.geometry()?.cues.length ?? 0;
  }

  #watch(doc: Document) {
    if (this.#observed === doc) return;
    this.#observer?.disconnect();
    this.#observed = doc;
    this.#dirty = true;
    const View = doc.defaultView?.MutationObserver;
    if (!View) return;
    this.#observer = new View(() => this.#dirty = true);
    // #main, not the body: the clock strip ticks every second and would mark
    // the cache dirty each time.
    this.#observer.observe(doc.querySelector("#main") ?? doc.body ?? doc, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
}

/**
 * Every cue on the stage, with the offset of its text's bottom edge in the
 * stage's scroll space.
 *
 * A cue is a text node that is *only* a cue: `scriptToHtml` gives every cue a
 * line of its own (and, dimmed, a span of its own), which is the "on its own
 * line" rule of the script format seen from the DOM. A cue hidden by the
 * presentation (`cues: "hide"`) is not in the DOM at all, and one hidden by a
 * theme has no boxes — neither can be crossed, so neither is listed.
 *
 * Rects, then undone back to layout space: the stage may be transform-scaled
 * to fit its screen (never in the preview, but measured rather than assumed),
 * and the TMP100 layout may flip `#main` vertically. The reading line is a
 * layout-space quantity — `#main`'s padding puts position 0's first line on
 * it — so the cue has to be too.
 */
export function measureCues(stage: HTMLElement): CueMark[] {
  const doc = stage.ownerDocument;
  const main = stage.querySelector<HTMLElement>("#main") ?? stage;
  const stageRect = stage.getBoundingClientRect();
  const scale = stage.offsetHeight ? stageRect.height / stage.offsetHeight : 1;
  const mainRect = main.getBoundingClientRect();
  const flipped = isFlippedVertically(main);

  const out: CueMark[] = [];
  const walker = doc.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const cue = parseCue(n.nodeValue ?? "");
    if (!cue) continue;
    range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects()).filter((r) =>
      r.width > 0 || r.height > 0
    );
    if (!rects.length) continue;
    // The bottom edge as laid out. Flipped, the laid-out bottom is drawn at
    // the top, mirrored about #main's centre.
    const visual = flipped
      ? mainRect.top + mainRect.bottom - Math.min(...rects.map((r) => r.top))
      : Math.max(...rects.map((r) => r.bottom));
    const y = (visual - stageRect.top) / scale + stage.scrollTop;
    out.push({ ...cue, y });
  }
  range.detach();
  return out;
}

function isFlippedVertically(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  const t = view?.getComputedStyle(el).transform;
  if (!t || t === "none" || !view) return false;
  try {
    return new view.DOMMatrixReadOnly(t).d < 0;
  } catch {
    return false;
  }
}
