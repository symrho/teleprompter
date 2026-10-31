// CUSTOM (symrho fork): a thin MCP adapter over the agent HTTP API.
//
// Everything the prompter can do is in the HTTP API (AGENT_API.md); this file
// only re-exposes it as MCP tools for agents that speak MCP rather than HTTP.
// No MCP SDK and no dependencies: MCP's stdio transport is newline-delimited
// JSON-RPC 2.0, and a server that offers tools needs four methods of it.
//
// Run (Claude Code):
//   claude mcp add prompter -- deno run \
//     --allow-net=127.0.0.1:8080 \
//     --allow-env=TELEPROMPTER_URL,TELEPROMPTER_API_TOKEN \
//     /path/to/teleprompter/tools/mcp/prompter-mcp.ts
//
// TELEPROMPTER_URL defaults to http://127.0.0.1:8080. TELEPROMPTER_API_TOKEN
// is sent as a bearer token when set.

export const PROTOCOL_VERSION = "2025-06-18";

type Json = Record<string, unknown>;

type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  method: "GET" | "PUT" | "PATCH" | "POST";
  path: string;
  /** Which arguments become the request body (default: all of them). */
  body?: (args: Json) => Json | undefined;
};

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

const TMP100_PROPS = {
  mirror: { type: "boolean", description: "Mirror left-right for the glass" },
  flipVertical: { type: "boolean", description: "Also flip upside down" },
  lineWidthCh: {
    type: "number",
    minimum: 8,
    maximum: 60,
    description: "Column width in characters",
  },
  lineSpacing: { type: "number", minimum: 0.9, maximum: 3 },
  paragraphGap: { type: "number", minimum: 0, maximum: 4, description: "em" },
  readingLinePct: {
    type: "number",
    minimum: 5,
    maximum: 95,
    description: "Reading line, % from the top",
  },
  readingMarker: { type: "boolean" },
  align: { type: "string", enum: ["left", "center"] },
};

export const TOOLS: Tool[] = [
  {
    name: "prompter_get_status",
    description:
      "Is the teleprompter ready? Returns state (NO_CONTROLLER, NO_VIEWER, NOT_READY, READY, RUNNING, PAUSED), the readiness checks that failed, playback, displays, and script timing (words, target WPM, estimated duration).",
    inputSchema: NO_ARGS,
    method: "GET",
    path: "/api/status",
  },
  {
    name: "prompter_load_script",
    description:
      "Load a plain-text script onto the teleprompter: paused, at the beginning, published to the iPad. Blank lines separate paragraphs; [bracketed] text is a cue (dimmed, not counted). Keeps the original and an optional prepared version separate. By default the scroll speed is set from targetWpm.",
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "The original script" },
        prepared: {
          type: "string",
          description:
            "Optional version rewritten for speech; shown instead of text",
        },
        active: { type: "string", enum: ["original", "prepared"] },
        document: {
          type: "string",
          description: "Document name; a document with this name is replaced",
        },
        preset: {
          type: "string",
          enum: ["linkedin-tmp100", "default", "big-clock"],
        },
        targetWpm: { type: "number", minimum: 60, maximum: 260 },
        speedFromWpm: { type: "boolean", description: "Default true" },
        presentation: {
          type: "object",
          additionalProperties: false,
          properties: {
            thoughtGroups: {
              type: "boolean",
              description:
                "Break lines into short spoken phrases (default true)",
            },
            maxGroupWords: { type: "number", minimum: 2, maximum: 20 },
            cues: { type: "string", enum: ["show", "dim", "hide"] },
          },
        },
      },
    },
    method: "PUT",
    path: "/api/script",
  },
  {
    name: "prompter_get_script",
    description:
      "The loaded script: original, prepared, which is active, the presentation options, the text the displays show, and its timing.",
    inputSchema: NO_ARGS,
    method: "GET",
    path: "/api/script",
  },
  {
    name: "prompter_configure",
    description:
      "Change presentation and playback settings. Everything is validated first; nothing is applied if any field is wrong. Speed is stage pixels per second (forward positive); speedFromWpm computes it from the target WPM and the live layout.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        preset: {
          type: "string",
          enum: ["linkedin-tmp100", "default", "big-clock"],
        },
        speed: { type: "number", minimum: -500, maximum: 500 },
        speedFromWpm: { type: "boolean" },
        textScale: {
          type: "number",
          minimum: 0.1,
          maximum: 10,
          description: "rem",
        },
        targetWpm: { type: "number", minimum: 60, maximum: 260 },
        ...TMP100_PROPS,
      },
    },
    method: "PATCH",
    path: "/api/config",
  },
  {
    name: "prompter_start",
    description:
      "Start scrolling from the current position. Fails if the speed is 0 or no display is connected.",
    inputSchema: NO_ARGS,
    method: "POST",
    path: "/api/control/start",
  },
  {
    name: "prompter_pause",
    description: "Pause scrolling, keeping the speed and position.",
    inputSchema: NO_ARGS,
    method: "POST",
    path: "/api/control/pause",
  },
  {
    name: "prompter_resume",
    description: "Resume scrolling after a pause.",
    inputSchema: NO_ARGS,
    method: "POST",
    path: "/api/control/resume",
  },
  {
    name: "prompter_goto_start",
    description: "Go back to the beginning and pause, ready for another take.",
    inputSchema: NO_ARGS,
    method: "POST",
    path: "/api/control/start-over",
  },
  {
    name: "prompter_goto",
    description:
      "Move every display to a position in the script: 0 is the start, 1 the end.",
    inputSchema: {
      type: "object",
      required: ["position"],
      additionalProperties: false,
      properties: { position: { type: "number", minimum: 0, maximum: 1 } },
    },
    method: "POST",
    path: "/api/control/goto",
  },
];

export type Fetcher = (
  method: string,
  path: string,
  body?: Json,
) => Promise<{ status: number; json: unknown }>;

export function httpFetcher(base: string, token?: string): Fetcher {
  return async (method, path, body) => {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // keep the text
    }
    return { status: res.status, json };
  };
}

type Request = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Json;
};

/** Handle one JSON-RPC message; returns the response, or null for a notification. */
export async function handle(
  msg: Request,
  fetcher: Fetcher,
): Promise<Json | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code, message },
  });
  if (msg.id === undefined) return null; // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "teleprompter", version: "1.0.0" },
        instructions:
          "Controls a local teleprompter. Call prompter_get_status first; the control page must be open on the Mac. The operator starts the recording and usually the scrolling.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool ${String(name)}`);
      const args = (msg.params?.arguments ?? {}) as Json;
      try {
        const body = tool.method === "GET"
          ? undefined
          : (tool.body ? tool.body(args) : args);
        const res = await fetcher(tool.method, tool.path, body);
        const ok = res.status >= 200 && res.status < 300;
        return reply({
          content: [{ type: "text", text: JSON.stringify(res.json, null, 2) }],
          structuredContent: typeof res.json === "object"
            ? res.json
            : undefined,
          isError: !ok,
        });
      } catch (err) {
        return reply({
          content: [{
            type: "text",
            text:
              `The teleprompter server is not reachable (${err}). Start it on the Mac and open the control page.`,
          }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

if (import.meta.main) {
  const base = Deno.env.get("TELEPROMPTER_URL") ?? "http://127.0.0.1:8080";
  const fetcher = httpFetcher(
    base.replace(/\/$/, ""),
    Deno.env.get("TELEPROMPTER_API_TOKEN"),
  );
  const enc = new TextEncoder();
  let buf = "";
  for await (
    const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
  ) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Request;
      try {
        msg = JSON.parse(line);
      } catch {
        await Deno.stdout.write(enc.encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "parse error" },
          }) + "\n",
        ));
        continue;
      }
      const out = await handle(msg, fetcher);
      if (out) await Deno.stdout.write(enc.encode(JSON.stringify(out) + "\n"));
    }
  }
}
