/**
 * POST /api/familiar/eval
 *
 * Implements the multipass-structural-memory-eval `SMEAdapter` contract for
 * familiar. The adapter on the multipass side calls this endpoint with a
 * query; the response gives multipass everything it needs to score:
 *
 *   - `answer`             — what the LLM said (or a stub when mock=true)
 *   - `context_string`     — verbatim system prompt sent to inference
 *                            (multipass tiktoken-counts this for Cat 7 Abacus)
 *   - `retrieved_entities` — SME-shaped drawers selected after rerank/budget
 *   - `retrieved_edges`    — empty in v0.2; KG triples in v0.3+
 *
 * Spec: ~/Projects/multipass-structural-memory-eval/docs/sme_spec_v8.md
 */

import type { PalaceClient } from "../palace-client.ts";
import type {
  Config,
  InferenceChatProvider,
  SmeQueryRequest,
  SmeQueryResponse,
} from "../types.ts";
import { retrieveAndGround } from "../memory-protocol.ts";

export interface EvalRouteDeps {
  cfg: Config;
  palace: PalaceClient;
  /**
   * InferenceChatProvider used when mock !== true. Typically the
   * InferenceRouter (which wraps llama.cpp + Ollama with circuit breakers).
   */
  inference: InferenceChatProvider;
  /**
   * Optional HyDE generator — wired from familiar.ts when
   * PALACE_USE_HYDE=true. Pre-search query expansion via ollama
   * generateShort. Without this on the eval route, A/B benchmarks
   * (multipass-structural-memory-eval) couldn't measure HyDE's
   * uplift because the eval path calls retrieveAndGround directly
   * — bypassing the chat-route HyDE wiring.
   */
  hydeGenerate?: (query: string) => Promise<string>;
}

const STUB_ANSWER =
  "(mock=true: inference skipped — context_string is the only meaningful field)";

export async function handleEval(req: Request, deps: EvalRouteDeps): Promise<Response> {
  let body: SmeQueryRequest;
  try {
    body = (await req.json()) as SmeQueryRequest;
  } catch {
    return jsonErr("invalid JSON body", 400);
  }

  if (!body.query || typeof body.query !== "string") {
    return jsonErr("query required", 400);
  }

  const limit = body.limit ?? deps.cfg.retrievalLimit;
  const warnings: string[] = [];
  let contextString = "";
  let entities: SmeQueryResponse["retrieved_entities"] = [];
  let availableInScope: number | undefined;

  try {
    const grounded = await retrieveAndGround({
      palace: deps.palace,
      userMessage: body.query,
      wingScope: body.wing ?? null,
      retrievalLimit: limit,
      contextBudgetTokens: deps.cfg.tokenBudget.context,
      recentCitations: [],
      hydeGenerate: deps.hydeGenerate,
    });
    contextString = grounded.systemPrompt;
    entities = grounded.entities;
    availableInScope = grounded.availableInScope;
    warnings.push(...grounded.warnings);
  } catch {
    warnings.push("palace_unreachable");
    contextString = "(palace unreachable — no context)";
  }

  let answer = STUB_ANSWER;
  if (!body.mock) {
    try {
      const messages = [
        { role: "system" as const, content: contextString },
        { role: "user" as const, content: body.query },
      ];
      let acc = "";
      for await (const chunk of deps.inference.chatStream({ messages })) {
        acc += chunk.message?.content ?? "";
        if (chunk.done) break;
      }
      answer = acc.trim() || "(empty response from inference)";
    } catch (err) {
      warnings.push("inference_failed");
      answer = `(inference failed: ${(err as Error).message})`;
    }
  }

  const response: SmeQueryResponse = {
    answer,
    context_string: contextString,
    retrieved_entities: entities,
    retrieved_edges: [], // v0.2: empty. v0.3+: KG triples for these entities.
    error: null,
    warnings,
    ...(availableInScope !== undefined ? { available_in_scope: availableInScope } : {}),
  };

  return new Response(JSON.stringify(response, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonErr(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
