// CUSTOM (symrho fork): the TMP100 card — the manual half of the preset.
//
// Built in script and appended to the sidebar, rather than written into
// index.html, so that upstream's markup (which changes often) carries no
// conflict-prone edits for it. The agent API drives the very same methods
// below, so a change made by an agent shows on these controls and a change
// made here shows in the API's status: there is one copy of the settings.

import type WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import type WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import type { ThemeControls } from "../themeControls.ts";
import { ThemeStorage } from "../themes.ts";
import {
  TMP100_DEFAULTS,
  TMP100_LIMITS,
  TMP100_NAME,
  TMP100_SLUG,
  TMP100_TEXT_SCALE,
  tmp100Css,
  type Tmp100Params,
  Tmp100Storage,
} from "./tmp100.ts";

/** What the card needs from the control page. */
export interface Tmp100Host {
  themes: ThemeControls;
  /** Set the shared Text Scale (rem), through the slider the operator uses. */
  setTextScale(rem: number): void;
}

type SliderSpec = {
  key: "lineWidthCh" | "lineSpacing" | "paragraphGap" | "readingLinePct";
  label: string;
  step: number;
};

const SLIDERS: SliderSpec[] = [
  { key: "lineWidthCh", label: "Line width (characters)", step: 1 },
  { key: "lineSpacing", label: "Line spacing", step: 0.05 },
  { key: "paragraphGap", label: "Paragraph gap (em)", step: 0.1 },
  { key: "readingLinePct", label: "Reading line (% from top)", step: 1 },
];

const SWITCHES: {
  key: "mirror" | "flipVertical" | "readingMarker";
  label: string;
}[] = [
  { key: "mirror", label: "Mirror for glass" },
  { key: "flipVertical", label: "Flip upside down" },
  { key: "readingMarker", label: "Reading-line markers" },
];

/**
 * Store the preset as a theme before ThemeControls reads the theme list.
 *
 * ThemeControls builds its dropdown once, from storage, in its constructor;
 * seeding first is what puts "LinkedIn / TMP100" in the Layout dropdown on the
 * very first run, without reaching into its private renderer.
 */
export function seedTmp100Theme(store: Storage = localStorage) {
  const themes = new ThemeStorage(store);
  const css = tmp100Css(new Tmp100Storage(store).get());
  if (themes.get(TMP100_SLUG)) {
    themes.update(TMP100_SLUG, { name: TMP100_NAME, css });
  } else themes.create(TMP100_NAME, css);
}

export class Tmp100Controls {
  storage: Tmp100Storage;
  #host: Tmp100Host;
  #sliders = new Map<SliderSpec["key"], WaSlider>();
  #switches = new Map<string, WaSwitch>();
  #centre!: WaSwitch;
  /** Free-form status lines other custom modules write (timing, API). */
  status: HTMLElement;

  constructor(host: Tmp100Host, store?: Storage) {
    this.#host = host;
    this.storage = new Tmp100Storage(store);
    // Make sure the preset exists as a theme *before* anyone asks for the
    // layout, and that its CSS matches the stored parameters — a reload after
    // an upgrade of this file regenerates it.
    this.#writeTheme();
    this.status = document.createElement("div");
    this.status.className = "tmp100-status";
    this.#buildCard();
    this.#render();
  }

  /** Whether the viewers are wearing the preset right now. */
  isActive(): boolean {
    return this.#host.themes.storage.getLayout() === TMP100_SLUG;
  }

  params(): Tmp100Params {
    return this.storage.get();
  }

  /**
   * Switch every display to the preset, with its text size.
   *
   * Text size goes through the Text Scale slider, so it lands in exactly the
   * state the manual slider would have produced.
   */
  applyPreset(opts: { textScale?: boolean } = {}) {
    this.#writeTheme();
    this.#host.themes.apply(TMP100_SLUG);
    if (opts.textScale !== false) this.#host.setTextScale(TMP100_TEXT_SCALE);
  }

  /** Change some parameters. Re-sends the theme only if it is on screen. */
  update(patch: Partial<Tmp100Params>): Tmp100Params {
    const next = this.storage.update(patch);
    this.#writeTheme();
    if (this.isActive()) this.#host.themes.apply(TMP100_SLUG);
    this.#render();
    return next;
  }

  reset() {
    this.update({ ...TMP100_DEFAULTS });
  }

  #writeTheme() {
    const theme = { name: TMP100_NAME, css: tmp100Css(this.storage.get()) };
    const themes = this.#host.themes.storage;
    if (themes.get(TMP100_SLUG)) themes.update(TMP100_SLUG, theme);
    else if (themes.create(TMP100_NAME, theme.css) !== TMP100_SLUG) {
      // create() mints the slug from the name, which is TMP100_SLUG unless a
      // theme of that name already existed. Nothing breaks either way; the
      // preset is just found by its own slug from here on.
      console.warn("TMP100 preset stored under an unexpected slug");
    }
  }

  #render() {
    const p = this.storage.get();
    for (const [key, slider] of this.#sliders) slider.value = p[key];
    for (const [key, sw] of this.#switches) {
      sw.checked = p[key as keyof Tmp100Params] as boolean;
    }
    if (this.#centre) this.#centre.checked = p.align === "center";
  }

  #buildCard() {
    const card = document.createElement("wa-card");
    card.id = "divTmp100";
    card.setAttribute("appearance", "outlined");
    card.setAttribute("with-header", "");
    const title = document.createElement("span");
    title.slot = "header";
    title.className = "card-title";
    title.innerHTML = `<wa-icon name="video"></wa-icon> LinkedIn / TMP100`;
    card.append(title);

    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;gap:0.6rem";

    const buttons = document.createElement("wa-button-group");
    const use = document.createElement("wa-button");
    use.setAttribute("size", "small");
    use.setAttribute("variant", "brand");
    use.textContent = "Use preset";
    use.addEventListener("click", () => this.applyPreset());
    const reset = document.createElement("wa-button");
    reset.setAttribute("size", "small");
    reset.textContent = "Reset";
    reset.addEventListener("click", () => this.reset());
    buttons.append(use, reset);
    body.append(buttons);

    for (const spec of SLIDERS) {
      const slider = document.createElement("wa-slider") as WaSlider;
      slider.label = spec.label;
      slider.min = TMP100_LIMITS[spec.key].min;
      slider.max = TMP100_LIMITS[spec.key].max;
      slider.step = spec.step;
      slider.setAttribute("with-tooltip", "");
      slider.addEventListener("change", () => {
        this.update({ [spec.key]: Number(slider.value) });
      });
      this.#sliders.set(spec.key, slider);
      body.append(slider);
    }
    for (const spec of SWITCHES) {
      const sw = document.createElement("wa-switch") as WaSwitch;
      sw.textContent = spec.label;
      sw.addEventListener("change", () => {
        this.update({ [spec.key]: sw.checked });
      });
      this.#switches.set(spec.key, sw);
      body.append(sw);
    }
    this.#centre = document.createElement("wa-switch") as WaSwitch;
    this.#centre.textContent = "Centre text";
    this.#centre.addEventListener("change", () => {
      this.update({ align: this.#centre.checked ? "center" : "left" });
    });
    body.append(this.#centre, this.status);

    card.append(body);
    // After the Transport card, which holds the two sliders this works with.
    const transport = document.querySelector("#divTransport");
    if (transport) transport.after(card);
    else document.querySelector("#controls")?.append(card);
  }
}
