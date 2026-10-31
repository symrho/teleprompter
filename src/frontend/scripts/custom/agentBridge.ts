// CUSTOM (symrho fork): the control page's end of the agent API bridge.
//
// One WebSocket to /api/bridge on the server this page was loaded from. The
// server sends {id, op, params}; this answers {id, ok, status, result|error}.
// It reconnects on its own, so restarting the server or an agent never needs
// the operator to reload. Nothing here is required for manual use: if the
// socket never connects, the prompter works exactly as upstream's does.

import { AgentController, answer } from "./agent.ts";

export type BridgeStatus = "connecting" | "connected" | "offline";

export function connectAgentBridge(
  ctl: AgentController,
  onStatus: (s: BridgeStatus) => void = () => {},
): () => void {
  let ws: WebSocket | null = null;
  let retry = 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const url = new URL("/api/bridge", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  const open = () => {
    if (stopped) return;
    onStatus("connecting");
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      retry = 1000;
      onStatus("connected");
    });
    ws.addEventListener("message", async (e) => {
      let req: { id?: unknown; op?: unknown; params?: unknown };
      try {
        req = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof req.id !== "string" || typeof req.op !== "string") return;
      const reply = await answer(ctl, {
        id: req.id,
        op: req.op,
        params: req.params,
      });
      ws?.send(JSON.stringify(reply));
    });
    ws.addEventListener("close", () => {
      ws = null;
      onStatus("offline");
      if (stopped) return;
      // Capped backoff: a server that is simply not running costs one
      // failed connection every 10s, not a stream of console errors.
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 10_000);
    });
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}

/**
 * The words of a published script, one line per line and a blank line between
 * blocks — the shape countWords expects.
 *
 * Parsed into a `<template>`, which is inert: a `div` in the live document
 * would fetch any `<img>` the markup names (see the paste trap in CLAUDE.md).
 */
export function htmlToText(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent ?? "");
    else if (n.nodeName === "BR") out.push("\n");
    else {
      n.childNodes.forEach(walk);
      if (/^(P|H[1-6]|LI|DIV|BLOCKQUOTE|PRE)$/.test(n.nodeName)) {
        out.push("\n\n");
      }
    }
  };
  t.content.childNodes.forEach(walk);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The next frame to flush a coalesced message in.
 *
 * `requestAnimationFrame` never fires in a hidden tab, and the control page
 * is often behind the recording app while an agent configures it: a speed or
 * text size sent then would wait, unsent, until the operator looked. A hidden
 * page has no frame to align with anyway, so it goes on the next task.
 */
export function nextFrame(cb: () => void): number {
  if (document.visibilityState === "hidden") {
    return setTimeout(cb, 0) as unknown as number;
  }
  return requestAnimationFrame(cb);
}
