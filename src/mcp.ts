import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod/v4";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type BridgeResponse = {
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

const pending = new Map<string, PendingRequest>();
let figmaSocket: WebSocket | null = null;

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: 7331
});

function rejectPending(reason: string): void {
  for (const [id, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
    pending.delete(id);
  }
}

wss.on("listening", () => {
  console.error("[figma-live] websocket listening on ws://127.0.0.1:7331");
});

wss.on("error", (error) => {
  console.error(`[figma-live] websocket error: ${error.message}`);
});

wss.on("connection", (socket) => {
  if (figmaSocket && figmaSocket.readyState === WebSocket.OPEN) {
    figmaSocket.close(1012, "Replaced by a new Figma bridge connection");
  }

  figmaSocket = socket;
  console.error("[figma-live] Figma plugin connected");

  socket.on("message", (raw) => {
    let response: BridgeResponse;
    try {
      response = JSON.parse(raw.toString()) as BridgeResponse;
    } catch {
      console.error("[figma-live] ignored invalid JSON from Figma plugin");
      return;
    }

    if (typeof response.id !== "string") return;
    const waiter = pending.get(response.id);
    if (!waiter) return;

    clearTimeout(waiter.timer);
    pending.delete(response.id);

    if (typeof response.error === "string") {
      waiter.reject(new Error(response.error));
      return;
    }

    waiter.resolve(response.result);
  });

  socket.on("close", () => {
    if (figmaSocket !== socket) return;
    figmaSocket = null;
    rejectPending("Figma plugin disconnected while a request was in flight");
    console.error("[figma-live] Figma plugin disconnected");
  });
});

function callFigma(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!figmaSocket || figmaSocket.readyState !== WebSocket.OPEN) {
    throw new Error(
      "Figma is not connected. Open Figma Desktop, run Plugins → Development → OpenCode Bridge, and keep the plugin window open."
    );
  }

  const id = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Figma request timed out: ${method}`));
    }, 10_000);

    pending.set(id, { resolve, reject, timer });
    figmaSocket!.send(JSON.stringify({ id, method, params }));
  });
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "figma-live",
    version: "0.1.0"
  });

  server.registerTool(
    "figma_status",
    {
      description: "Check whether the live Figma plugin is connected to this OpenCode MCP process.",
      inputSchema: z.object({})
    },
    async () =>
      toolResult({
        connected: figmaSocket?.readyState === WebSocket.OPEN,
        websocket: "ws://127.0.0.1:7331"
      })
  );

  server.registerTool(
    "figma_get_selection",
    {
      description:
        "Inspect the currently selected objects in the active Figma document. Returns compact structural data including hierarchy, dimensions, text, and auto-layout.",
      inputSchema: z.object({
        depth: z.number().int().min(0).max(8).optional()
      })
    },
    async ({ depth }) =>
      toolResult(
        await callFigma("get_selection", {
          ...(depth === undefined ? {} : { depth })
        })
      )
  );

  server.registerTool(
    "figma_get_node",
    {
      description: "Inspect a Figma scene node by node ID.",
      inputSchema: z.object({
        nodeId: z.string().min(1),
        depth: z.number().int().min(0).max(8).optional()
      })
    },
    async ({ nodeId, depth }) =>
      toolResult(
        await callFigma("get_node", {
          nodeId,
          ...(depth === undefined ? {} : { depth })
        })
      )
  );

  server.registerTool(
    "figma_resize",
    {
      description:
        "Resize a Figma node. If nodeId is omitted, exactly one node must be selected. Omitted dimensions keep their current values.",
      inputSchema: z.object({
        nodeId: z.string().min(1).optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional()
      })
    },
    async (args) => toolResult(await callFigma("resize", args))
  );

  server.registerTool(
    "figma_set_text",
    {
      description:
        "Change the characters of a Figma text layer. If nodeId is omitted, exactly one text node must be selected. Existing fonts are loaded before mutation.",
      inputSchema: z.object({
        nodeId: z.string().min(1).optional(),
        text: z.string()
      })
    },
    async (args) => toolResult(await callFigma("set_text", args))
  );

  server.registerTool(
    "figma_undo_last_change",
    {
      description:
        "Undo the most recently committed bridge mutation in Figma. Resize and text changes are committed as separate undo steps.",
      inputSchema: z.object({})
    },
    async () => toolResult(await callFigma("undo"))
  );

  return server;
}

serveStdio(() => buildServer());
