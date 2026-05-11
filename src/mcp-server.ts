/**
 * MCP server: exposes familiar to MCP clients (Claude Code, agents, etc.)
 *
 * Three tools, all backed by the same retrieve+ground+generate pipeline
 * that powers /v1/chat/completions:
 *   - familiar_recall  → palace search, returns formatted drawers
 *   - familiar_reflect → palace-grounded reflection on a topic
 *   - familiar_chat    → palace-grounded conversational reply
 *
 * Transport: WebStandardStreamableHTTPServerTransport — takes a Web-standard
 * Request, returns a Promise<Response>. Drop-in for Bun.serve's fetch handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { PalaceClient } from "./palace-client.ts";
import type { Config, InferenceChatProvider } from "./types.ts";
import { retrieveAndGround } from "./memory-protocol.ts";

export interface McpServerDeps {
  cfg: Config;
  palace: PalaceClient;
  inference: InferenceChatProvider;
}

const NAME = "familiar";
const VERSION = "0.2.0";

/**
 * Format palace drawers as one human-readable block per drawer, separated
 * by `---`. Drawer IDs preserved in the standard `[drawer_xxx]` form so
 * downstream MCP clients can grep them out.
 */
function formatDrawers(drawers: Array<{ id?: string; wing: string; room: string; text: string; topic?: string }>): string {
  if (drawers.length === 0) return "No relevant memories in the palace.";
  return drawers
    .map((d) => `[${d.id ?? "?"}] (${d.wing}/${d.room}${d.topic ? ` · ${d.topic}` : ""})\n${d.text}`)
    .join("\n\n---\n\n");
}

async function streamToString(provider: InferenceChatProvider, system: string, user: string): Promise<string> {
  let acc = "";
  for await (const chunk of provider.chatStream({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  })) {
    acc += chunk.message?.content ?? "";
    if (chunk.done) break;
  }
  return acc.trim() || "(empty response from inference)";
}

export function createFamiliarMcp(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });

  server.tool(
    "familiar_recall",
    "Retrieve up to 5 palace memories relevant to a query. Use this to look up specific facts, projects, people, or events without composing a full chat turn.",
    { query: z.string().min(1), wing: z.string().optional() },
    async ({ query, wing }) => {
      try {
        const result = await deps.palace.search({
          query: query.slice(0, 250),
          limit: deps.cfg.retrievalLimit,
          wing: wing ?? undefined,
        });
        const drawers = (result.results ?? []).filter((d) => typeof d.text === "string");
        return { content: [{ type: "text", text: formatDrawers(drawers) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Palace search failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "familiar_reflect",
    "Generate a palace-grounded reflection or summary on a given topic. Runs full retrieve+ground+generate.",
    { topic: z.string().min(1), wing: z.string().optional() },
    async ({ topic, wing }) => {
      try {
        const grounded = await retrieveAndGround({
          palace: deps.palace,
          userMessage: topic,
          wingScope: wing ?? null,
          retrievalLimit: deps.cfg.retrievalLimit,
          contextBudgetTokens: deps.cfg.tokenBudget.context,
          recentCitations: [],
        });
        const answer = await streamToString(deps.inference, grounded.systemPrompt, `Reflect on: ${topic}`);
        return { content: [{ type: "text", text: answer }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Reflection failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "familiar_chat",
    "Send a conversational message to the familiar. Returns a palace-grounded reply.",
    { message: z.string().min(1), wing: z.string().optional() },
    async ({ message, wing }) => {
      try {
        const grounded = await retrieveAndGround({
          palace: deps.palace,
          userMessage: message,
          wingScope: wing ?? null,
          retrievalLimit: deps.cfg.retrievalLimit,
          contextBudgetTokens: deps.cfg.tokenBudget.context,
          recentCitations: [],
        });
        const answer = await streamToString(deps.inference, grounded.systemPrompt, message);
        return { content: [{ type: "text", text: answer }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Chat failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

/**
 * Mount the MCP server on a Web-standard transport. Returns a request handler
 * that the Bun.serve fetch dispatcher can call directly for /mcp routes.
 */
export async function mountFamiliarMcp(deps: McpServerDeps): Promise<{
  handle: (req: Request) => Promise<Response>;
  server: McpServer;
}> {
  const server = createFamiliarMcp(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  return {
    handle: (req: Request) => transport.handleRequest(req),
    server,
  };
}
