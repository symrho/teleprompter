// CUSTOM (symrho fork): the linkedin-tmp100 preset's parameters and CSS.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  parseTmp100,
  TMP100_DEFAULTS,
  TMP100_SLUG,
  tmp100Css,
  Tmp100Storage,
  validateTmp100Patch,
} from "./tmp100.ts";
import { isUserLayout, themeSlug } from "../themes.ts";

function mapStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

Deno.test("the preset's slug is the one ThemeStorage mints for its name", () => {
  // seedTmp100Theme relies on create() landing on TMP100_SLUG.
  assertEquals(themeSlug("LinkedIn / TMP100"), TMP100_SLUG);
  assert(isUserLayout(TMP100_SLUG));
});

Deno.test("defaults mirror the text and keep a narrow column", () => {
  assert(TMP100_DEFAULTS.mirror);
  assertFalse(TMP100_DEFAULTS.flipVertical);
  assert(TMP100_DEFAULTS.lineWidthCh <= 24);
});

Deno.test("a valid patch passes through unchanged", () => {
  const r = validateTmp100Patch({
    lineWidthCh: 20,
    mirror: false,
    align: "center",
  });
  assert(r.ok);
  assertEquals(r.value, { lineWidthCh: 20, mirror: false, align: "center" });
});

Deno.test("out-of-range and mistyped values are refused, by field", () => {
  const r = validateTmp100Patch({
    lineWidthCh: 500,
    mirror: "yes",
    readingLinePct: Number.NaN,
    colour: "red",
  });
  assertFalse(r.ok);
  if (r.ok) return;
  assertEquals(r.errors.map((e) => e.field).sort(), [
    "colour",
    "lineWidthCh",
    "mirror",
    "readingLinePct",
  ]);
});

Deno.test("a non-object patch is one error, not a throw", () => {
  for (const bad of [null, 3, "x", [1]]) {
    assertFalse(validateTmp100Patch(bad).ok);
  }
});

Deno.test("parse drops one bad field and keeps the rest", () => {
  const p = parseTmp100(
    JSON.stringify({ lineWidthCh: 22, lineSpacing: "big" }),
  );
  assertEquals(p.lineWidthCh, 22);
  assertEquals(p.lineSpacing, TMP100_DEFAULTS.lineSpacing);
  assertEquals(parseTmp100("{not json"), { ...TMP100_DEFAULTS });
  assertEquals(parseTmp100(null), { ...TMP100_DEFAULTS });
});

Deno.test("storage remembers updates", () => {
  const store = mapStore();
  new Tmp100Storage(store).update({ readingLinePct: 30 });
  assertEquals(new Tmp100Storage(store).get().readingLinePct, 30);
});

Deno.test("the CSS mirrors #main, not #stage", () => {
  const css = tmp100Css({ ...TMP100_DEFAULTS, mirror: true });
  assert(css.includes("transform: scale(-1, 1)"));
  // #stage's transform is how a display is fitted to its screen.
  assertFalse(/#stage\s*{[^}]*transform/.test(css));
  assert(
    tmp100Css({ ...TMP100_DEFAULTS, mirror: false }).includes("scale(1, 1)"),
  );
  assert(
    tmp100Css({ ...TMP100_DEFAULTS, flipVertical: true }).includes(
      "scale(-1, -1)",
    ),
  );
});

Deno.test("the CSS puts the first line on the reading line", () => {
  const css = tmp100Css({ ...TMP100_DEFAULTS, readingLinePct: 35 });
  assert(css.includes("padding: calc(35cqh - 0.5lh) 0 65cqh"));
});

Deno.test("the CSS uses no viewport units", () => {
  // viewerThemes.css: a vh/vw/vi resolves against the real screen and the
  // displays stop agreeing on a line.
  const css = tmp100Css({ ...TMP100_DEFAULTS });
  assertFalse(/\d(vh|vw|vi|vb|dvh|dvw)\b/.test(css));
});

Deno.test("the CSS keeps the reading markers optional", () => {
  assert(
    tmp100Css({ ...TMP100_DEFAULTS, readingMarker: true }).includes(
      "#header::before",
    ),
  );
  assertFalse(
    tmp100Css({ ...TMP100_DEFAULTS, readingMarker: false }).includes(
      "#header::before",
    ),
  );
});
