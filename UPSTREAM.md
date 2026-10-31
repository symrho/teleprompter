# Staying in step with upstream

This fork tracks [17xande-dev/teleprompter](https://github.com/17xande-dev/teleprompter).
Upstream is MIT licensed. Its `LICENSE` and attribution stay as they are, and
the fork's additions are under the same licence.

## Remotes

```sh
git remote -v
# origin    https://github.com/symrho/teleprompter.git        (your fork)
# upstream  https://github.com/17xande-dev/teleprompter.git   (original)

# On a fresh clone of the fork:
git remote add upstream https://github.com/17xande-dev/teleprompter.git
```

## Pulling upstream changes

Merge rather than rebase: the fork's history is shared, and a merge keeps a
record of which upstream commit you took.

```sh
git fetch upstream
git switch main
git log --oneline main..upstream/main      # what is new upstream
git switch -c merge-upstream-$(date +%Y%m%d)
git merge upstream/main
# resolve conflicts (see below), then run every gate:
make test          # build, Go vet/gofmt/race tests, deno check, lint, tests
git push -u origin HEAD                    # open a PR into your main
```

## Where conflicts will happen

Nearly everything custom lives in new files (`custom/`, `agentapi.go`,
`tools/mcp/`, the `*.md` files at the root), and those can't conflict. The
hooks into upstream files are small and marked `CUSTOM (symrho fork)`:

| Upstream file | Hook | If it conflicts |
| --- | --- | --- |
| `teleprompter.ts` | imports; `tmp100` and `agent` fields; `seedTmp100Theme()` before `new ThemeControls()`; `new Tmp100Controls(...)` after it; after `buildCommands`, the agent host, custom commands and bridge; `nextFrame` in `#pushSettings`; the `#agentHost()` method | Re-apply each hook against upstream's new code. `#agentHost` uses private members (`#autoScrollRunning`, `#lastRatio`, `#publishedHtml`, `#draftHeld`, `#pdfBytes`, `#signaling`, `#previewScroller`, `#postToPreview`, `link`, `viewers`). If upstream renames one, update it there. |
| `main.go` | two flags, `agent.wrap(...)`, `logLANAddresses` | Keep upstream's version and re-add the three lines. |
| `docControls.ts` | `putDocument` | Re-add the method. It uses only `storage`, `#renderItems` and `load`. |
| `editor.ts` | `editorJSONFromHtml` at the end | Re-add it. It needs `buildConfig`, `GardState` and `history`. |
| `deno.jsonc` | the `test` task's file globs | Keep upstream's task and re-add the two extra globs. |
| `README.md` | the note at the top | Trivial. |

## Upstream changes that need a closer look

- **Viewer markup or base CSS** (`viewer.html`, `viewerBase.css`): the preset's
  CSS targets `#stage`, `#header` and `#main`, and relies on `#stage` being
  the scroller and size container. If those change, update `tmp100Css()`.
- **Themes** (`themes.ts`, `themeControls.ts`): the preset is a user theme
  with slug `theme-user-linkedin-tmp100`, seeded before `ThemeControls` is
  built. A change to how user themes are stored, named or shipped affects it.
- **Transport** (`rngSpeed`, `rngScale`, `toggleAutoScroll`, `#pushSettings`,
  `sendMyPosition`): the agent host drives these directly. If upstream
  replaces the sliders or moves the funnel, move the host with it, so there
  is still one path and no duplicated state.
- **Protocol** (`protocol.ts`): the fork doesn't touch it. Nothing to do
  unless the theme or scroll messages change shape.
- **Server** (`hub.go`, `signal.go`): not touched. `agentapi.go` borrows only
  the `pongWait`, `pingPeriod` and `writeWait` constants.

After any merge, run the checklist in [QUICKSTART.md](QUICKSTART.md#physical-validation-checklist)
on the real iPad before the next recording.

## Sending things upstream

If something here would help upstream generally (the hidden-tab flush, for
example), offer it as a separate, minimal PR against upstream's `main` from a
clean branch. Don't send the fork's whole branch.
