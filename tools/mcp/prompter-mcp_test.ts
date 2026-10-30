// CUSTOM (symrho fork): the MCP adapter maps tools onto the HTTP API and
// nothing else.

import { assert, assertEquals } from "@std/assert";
import { type Fetcher, handle, TOOLS } from "./prompter-mcp.ts";

function recorder(status = 200, json: unknown = { state: "READY" }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const f: Fetcher = (method, path, body) => {
    calls.push({ method, path, body });
    return Promise.resolve({ status, json });
  };
  return { f, calls };
}

Deno.test("initialize advertises tools", async () => {
  const out = await handle(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    recorder().f,
  );
  const r = out!.result as { capabilities: { tools: unknown } };
  assert(r.capabilities.tools);
});

Deno.test("every tool maps to an /api endpoint", async () => {
  const out = await handle(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    recorder().f,
  );
  const names = (out!.result as { tools: { name: string }[] }).tools.map((t) =>
    t.name
  );
  for (
    const n of [
      "prompter_get_status",
      "prompter_load_script",
      "prompter_get_script",
      "prompter_configure",
      "prompter_start",
      "prompter_pause",
      "prompter_resume",
      "prompter_goto_start",
    ]
  ) assert(names.includes(n), n);
  for (const t of TOOLS) assert(t.path.startsWith("/api/"), t.path);
});

Deno.test("a tool call sends its arguments as the body", async () => {
  const r = recorder();
  await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "prompter_load_script",
      arguments: { text: "Hi", preset: "linkedin-tmp100" },
    },
  }, r.f);
  assertEquals(r.calls, [{
    method: "PUT",
    path: "/api/script",
    body: { text: "Hi", preset: "linkedin-tmp100" },
  }]);
});

Deno.test("an API error comes back as a tool error, not a protocol error", async () => {
  const r = recorder(409, { error: { code: "speed_zero" } });
  const out = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "prompter_start", arguments: {} },
  }, r.f);
  const res = out!.result as { isError: boolean; content: { text: string }[] };
  assert(res.isError);
  assert(res.content[0].text.includes("speed_zero"));
});

Deno.test("unknown tools and methods are JSON-RPC errors; notifications get no reply", async () => {
  const f = recorder().f;
  const bad = await handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "shell" },
  }, f);
  assertEquals((bad!.error as { code: number }).code, -32602);
  const none = await handle(
    { jsonrpc: "2.0", id: 5, method: "resources/list" },
    f,
  );
  assertEquals((none!.error as { code: number }).code, -32601);
  assertEquals(
    await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, f),
    null,
  );
});
