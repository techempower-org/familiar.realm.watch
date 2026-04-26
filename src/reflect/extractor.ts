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

Given an assistant's response text, return a JSON array of factual claims worth remembering. A claim is "worth remembering" if it states something concrete: a fact, a relationship, a definition, a decision. Skip greetings, hedges, refusals, opinions, and meta-commentary.

Return ONLY a JSON array. Each entry has:
  - fact: a single self-contained sentence stating the claim
  - source_span: [start, end] character offsets into the input text

If the input contains no extractable claims, return [].

Do not wrap the JSON in markdown fences. Do not add commentary.`;

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
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { fact?: unknown; source_span?: unknown };
    if (typeof e.fact !== "string") continue;
    const span =
      Array.isArray(e.source_span) && e.source_span.length === 2 &&
      typeof e.source_span[0] === "number" && typeof e.source_span[1] === "number"
        ? ([e.source_span[0], e.source_span[1]] as [number, number])
        : ([0, e.fact.length] as [number, number]);
    candidates.push({ fact: e.fact, source_span: span });
  }
  return candidates.slice(0, opts.maxFacts);
}
