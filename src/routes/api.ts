import type { HealthDeps } from "../health.ts";
import type { SigilInfo } from "../sigil.ts";
import { getHealth } from "../health.ts";

export async function handleVersion(_req: Request, sigil: SigilInfo): Promise<Response> {
  return new Response(JSON.stringify(sigil, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handleHealth(_req: Request, deps: HealthDeps): Promise<Response> {
  const report = await getHealth(deps);
  const allOk = Object.values(report.dependencies).every((d) => d.status === "ok");
  return new Response(JSON.stringify(report, null, 2), {
    status: allOk ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

export interface ModelsRouteDeps {
  /** Upstream OpenAI-compatible `/v1/models` URL — usually the llama-server chat host. */
  chatUpstreamUrl: string;
  /** Server's default model from env, returned as the fallback selection. */
  defaultModel: string;
}

interface UpstreamModel {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  // llama-server's /v1/models embeds rich per-model metadata under `meta`.
  meta?: {
    n_ctx?: number;
    n_ctx_train?: number;
    n_params?: number;
    size?: number;
    n_vocab?: number;
  };
}

/**
 * GET /api/familiar/models — list chat-capable models available on the upstream
 * llama-server / Ollama instance. Used by the web UI's model picker (issue #1).
 *
 * Shape is deliberately small and frontend-shaped: `{ default, models: [{id, label,
 * params_b, context, size_mb}] }`. Lets the picker show "phi-4 14B · 4k ctx" without
 * the frontend doing any inference on the upstream's loose schema.
 *
 * Why this lives in familiar-api rather than the frontend calling /v1/models direct:
 *   - The browser would need to talk to llama-server cross-origin (auth + CORS),
 *     and llama-server isn't behind Authelia.
 *   - We get to filter embedding-only models (they declare `embeddings` in
 *     `capabilities`) so the picker doesn't accidentally offer nomic-embed.
 *   - One place to add caching / fallbacks if llama-server is temporarily down.
 */
export async function handleModels(_req: Request, deps: ModelsRouteDeps): Promise<Response> {
  try {
    const res = await fetch(`${deps.chatUpstreamUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ default: deps.defaultModel, models: [], error: `upstream ${res.status}` }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const upstream = await res.json() as { data?: UpstreamModel[]; models?: UpstreamModel[] };
    // llama-server's response has both `data` (OpenAI-shape) and `models` (Ollama-shape).
    // Prefer `data` since it's the OpenAI canon and llama-server is more reliable there.
    const raw = upstream.data ?? upstream.models ?? [];
    const models = raw
      .map((m) => {
        const id = m.id ?? "";
        const meta = m.meta ?? {};
        const paramsB = meta.n_params ? Math.round(meta.n_params / 1e9 * 10) / 10 : null;
        const sizeMb = meta.size ? Math.round(meta.size / (1024 * 1024)) : null;
        const ctx = meta.n_ctx ?? meta.n_ctx_train ?? null;
        return {
          id,
          // Human label: "phi-4 14B · 4k ctx". Trim known suffixes so the
          // picker reads cleanly without losing the actual model id below.
          label: prettyLabel(id, paramsB, ctx),
          params_b: paramsB,
          context: ctx,
          size_mb: sizeMb,
        };
      })
      .filter((m) => m.id);
    return new Response(JSON.stringify({ default: deps.defaultModel, models }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      default: deps.defaultModel,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

function prettyLabel(id: string, paramsB: number | null, ctx: number | null): string {
  // "phi-4-Q4_K_M.gguf" → "phi-4 Q4_K_M". Drop file extension + un-dash the base.
  const stem = id.replace(/\.gguf$/i, "").replace(/-/g, " ");
  const parts: string[] = [stem];
  if (paramsB !== null) parts.push(`${paramsB}B`);
  if (ctx !== null) {
    const k = ctx >= 1024 ? `${Math.round(ctx / 1024)}k` : `${ctx}`;
    parts.push(`${k} ctx`);
  }
  return parts.join(" · ");
}
