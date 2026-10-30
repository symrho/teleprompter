// CUSTOM (symrho fork): plain-text script handling and timing.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  countWords,
  DEFAULT_PRESENTATION,
  formatDuration,
  paragraphs,
  scriptToHtml,
  thoughtGroups,
  timing,
} from "./script.ts";

Deno.test("words are counted per line, and cues are not words", () => {
  assertEquals(countWords("one two\nthree"), 3);
  assertEquals(countWords("Hello. [Pause.] Again — now"), 3);
  assertEquals(countWords(""), 0);
  assertEquals(countWords("It's 20 years, isn't it?"), 5);
});

Deno.test("timing matches the brief's example", () => {
  const t = timing(Array(193).fill("word").join(" "), 130);
  assertEquals(t.words, 193);
  assertEquals(t.targetWpm, 130);
  assertEquals(t.estimatedDuration, "1:29");
});

Deno.test("durations format as m:ss", () => {
  assertEquals(formatDuration(0), "0:00");
  assertEquals(formatDuration(59.6), "1:00");
  assertEquals(formatDuration(75), "1:15");
});

Deno.test("blank lines separate paragraphs; single breaks are kept", () => {
  assertEquals(paragraphs("a\nb\n\n\n c \r\n\r\nd"), [["a", "b"], [" c"], [
    "d",
  ]]);
});

Deno.test("thought groups never change the words", () => {
  const line =
    "So I did something simpler. I asked people in my network who run businesses one question: where would AI actually help you?";
  const groups = thoughtGroups(line, 6);
  assertEquals(groups.join(" "), line);
  assert(groups.every((g) => g.split(" ").length <= 6));
  assertEquals(groups[0], "So I did something simpler.");
});

Deno.test("a cue gets a line of its own", () => {
  const groups = thoughtGroups("after 20 years. [Pause.] If you", 6);
  assertEquals(groups, ["after 20 years.", "[Pause.]", "If you"]);
  const multi = thoughtGroups(
    "rest of the year. [Cut to screen: the log.] Thirteen",
    6,
  );
  assertEquals(multi[1], "[Cut to screen: the log.]");
});

Deno.test("HTML is escaped, so a script cannot inject markup", () => {
  const html = scriptToHtml("<img src=x onerror=alert(1)> & co", {
    ...DEFAULT_PRESENTATION,
    thoughtGroups: false,
  });
  assertFalse(html.includes("<img"));
  assert(html.includes("&lt;img"));
  assert(html.includes("&amp; co"));
});

Deno.test("paragraphs become <p>, lines become <br>", () => {
  const html = scriptToHtml("one\ntwo\n\nthree", {
    ...DEFAULT_PRESENTATION,
    thoughtGroups: false,
  });
  assertEquals(html, "<p>one<br>two</p><p>three</p>");
});

Deno.test("cues can be dimmed, shown or hidden", () => {
  const base = { ...DEFAULT_PRESENTATION, thoughtGroups: false };
  assert(
    scriptToHtml("a [Pause.] b", { ...base, cues: "dim" }).includes(
      '<span style="color:',
    ),
  );
  assertEquals(
    scriptToHtml("a [Pause.] b", { ...base, cues: "show" }),
    "<p>a [Pause.] b</p>",
  );
  assertEquals(
    scriptToHtml("a [Pause.] b", { ...base, cues: "hide" }),
    "<p>a b</p>",
  );
});

Deno.test("an empty script is one empty paragraph, not nothing", () => {
  assertEquals(scriptToHtml("  \n\n ", DEFAULT_PRESENTATION), "<p></p>");
});
