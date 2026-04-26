/**
 * Extract candidate facts from an assistant turn via the InferenceRouter.
 *
 * Prompt asks for a JSON array of {fact, source_span}. Robust to
 * malformed output: returns [] on parse failure rather than throwing,
 * because reflect is off the hot path and partial data is fine.
 */

import type { ReflectCandidate } from "./types.ts";
import type { InferenceChatProvider } from "../types.ts";

const SYSTEM_PROMPT = `You extract factual claims from text for a knowledge base.

Return a JSON array. Each entry is an object with a "fact" string field
that is a self-contained sentence stating the claim. Optionally include
"source_span": [start, end] character offsets.

A claim is "worth remembering" if it states something concrete: a fact,
relationship, definition, or decision. Skip greetings, hedges, refusals,
opinions, and meta-commentary. If the input has no extractable claims,
return [].

EXAMPLE INPUT:
"DiaryBuffer flushes every 10 turns or on session end. The familiar's primary GPU is the RTX 2080 Ti."

EXAMPLE OUTPUT:
[
  {"fact": "DiaryBuffer flushes every 10 turns or on session end."},
  {"fact": "The familiar's primary GPU is the RTX 2080 Ti."}
]

Return ONLY the JSON array. No markdown fences. No commentary.`;

export interface ExtractorOptions {
  inference: InferenceChatProvider;
  /** Maximum number of facts to return (slices the parsed array). */
  maxFacts: number;
}

export async function extractCandidates(
  assistantTurn: string,
  opts: ExtractorOptions,
): Promise<ReflectCandidate[]> {
  let acc = "";
  try {
    for await (const chunk of opts.inference.chatStream({
      model: "",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: assistantTurn },
      ],
    })) {
      acc += chunk.message?.content ?? "";
      if (chunk.done) break;
    }
  } catch {
    return [];
  }

  // Strip ```json fences if the model added them despite the instruction.
  const stripped = acc
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const candidates: ReflectCandidate[] = [];
  for (const entry of parsed) {
    // Accept the canonical shape: { fact: string, source_span?: [n,n] }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as { fact?: unknown; source_span?: unknown };
      if (typeof e.fact === "string") {
        const span =
          Array.isArray(e.source_span) && e.source_span.length === 2 &&
          typeof e.source_span[0] === "number" && typeof e.source_span[1] === "number"
            ? ([e.source_span[0], e.source_span[1]] as [number, number])
            : ([0, e.fact.length] as [number, number]);
        candidates.push({ fact: e.fact, source_span: span });
        continue;
      }
    }
    // Permissive: small models sometimes emit a bare string per fact.
    if (typeof entry === "string" && entry.trim().length > 0) {
      candidates.push({ fact: entry, source_span: [0, entry.length] });
      continue;
    }
    // Skip array-of-strings entries (triple-shaped output from weaker models)
    // — gate would reject these as too short anyway.
  }
  return candidates.slice(0, opts.maxFacts);
}
