import type { OllamaClient } from "../ollama-client.ts";
import type { CircuitBreaker } from "../circuit-breaker.ts";
import type { Config } from "../types.ts";
import type { SlotResolver } from "../slots/resolver.ts";

export interface EmbeddingsRouteDeps {
  cfg: Config;
  /**
   * Legacy fallback embed client. Used when `resolver` is absent or
   * its embed slot returns null (unconfigured, invalid variant, or
   * non-ollama runtime — llama-cpp doesn't implement embed today).
   */
  ollamaEmbed: OllamaClient;
  /**
   * Slot resolver — Wave 2c. When present, every embed request asks
   * `resolver.embedClient()` first; falls back to `ollamaEmbed` on null.
   */
  resolver?: SlotResolver;
  breaker: CircuitBreaker;
}

interface OpenAIEmbedRequest {
  model?: string;
  input: string | string[];
}

/**
 * POST /v1/embeddings — OpenAI-compatible shape.
 * Input can be a single string or array. One Ollama call per input string
 * (Ollama v0.3+ supports batch but we keep it simple for v0.1).
 */
export async function handleEmbeddings(req: Request, deps: EmbeddingsRouteDeps): Promise<Response> {
  let body: OpenAIEmbedRequest;
  try {
    body = (await req.json()) as OpenAIEmbedRequest;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (!body.input) {
    return new Response(JSON.stringify({ error: "input required" }), { status: 400 });
  }
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  // Pick the embed client per request: slot resolver wins if it yields
  // a variant; otherwise the legacy ollamaEmbed (env-configured) takes
  // over. Build once, reuse across all input strings in this request.
  const slotClient = deps.resolver ? await deps.resolver.embedClient() : null;
  const embedClient = slotClient ?? deps.ollamaEmbed;
  const model = body.model ?? (slotClient ? undefined : deps.cfg.ollamaEmbed.model);

  try {
    const vectors = await deps.breaker.run(async () => {
      return Promise.all(inputs.map((text) => embedClient.embed({ model: model ?? "", text })));
    });
    const resp = {
      object: "list",
      data: vectors.map((v, i) => ({ object: "embedding", embedding: v, index: i })),
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
    return new Response(JSON.stringify(resp), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 503, headers: { "content-type": "application/json" } });
  }
}
