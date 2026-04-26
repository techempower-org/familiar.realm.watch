import type { PalaceDrawer } from "./types.ts";
import { voice } from "./lang/familiar-voice.ts";

export interface GroundingInput {
  drawers: PalaceDrawer[];
  warnings: string[];
  availableInScope: number;
  wingScope: string | null;
  /** When true, append a system directive nudging the assistant to suggest rephrasing/scoping. */
  stuck?: boolean;
}

/**
 * Confidence gate (Phase 4 of the v0.2 design).
 *
 * Returns a system-prompt directive when retrieval looks weak, asking the
 * assistant to open with the themed `voice.weakContext` caveat. Empty string
 * when retrieval is strong enough that we don't need to hedge.
 *
 * "Weak" = top result similarity < 0.3 AND fewer than 2 results returned.
 * The two-pronged condition prevents false positives on naturally-low-similarity
 * queries that still have many candidates (e.g. broad/conversational prompts).
 */
export function confidencePrefix(drawers: PalaceDrawer[]): string {
  const top = drawers[0]?.similarity ?? 0;
  if (top < 0.3 && drawers.length < 2) {
    return `\n── Confidence note ──\nRetrieval is weak. Open with: "${voice.weakContext}" then answer with whatever the palace context above does support.`;
  }
  return "";
}

/**
 * Returns a system-prompt directive when the user has been asking similar
 * questions repeatedly. The assistant is asked to graciously suggest
 * rephrasing or wing scope rather than just plowing forward.
 */
export function stuckDirective(): string {
  return `\n── Loop note ──\nThe user has asked several similar questions in this session. Briefly suggest: "${voice.stuckSearching}" then proceed with your best answer.`;
}

const PERSONA = `You are the familiar — a magical companion who lives inside JP's realm.watch palace.
You read the palace before you speak and write the palace after. You have a grounded, warm voice;
speak plainly and never perform wisdom you don't have. The palace below is your memory.`;

const DIRECTIVES = `── Grounding directives ──
- Answer only from the palace context above. If the answer is not present, say "I don't have that in the palace."
- Cite drawer IDs for every factual claim about the user, their projects, their realm, or past events: [drawer_id].
- If the palace contains multiple values for the same thing (dates, facts, opinions that shifted over time), list them and name the ambiguity — do not silently pick one.
- If the palace context contains the answer, you must use it. Do not refuse with "I don't know" when the retrieval clearly has the information.
- If you were not asked a factual question (jokes, greetings, creative writing), you don't need palace context — respond naturally. The directives above apply to *claims*, not to conversation.`;

export function buildSystemPrompt(input: GroundingInput): string {
  const parts: string[] = [];
  parts.push(PERSONA);
  parts.push("");
  parts.push(renderContextBlock(input));
  parts.push("");
  parts.push(DIRECTIVES);
  const conf = confidencePrefix(input.drawers);
  if (conf) parts.push(conf);
  if (input.stuck) parts.push(stuckDirective());
  return parts.join("\n");
}

function renderContextBlock(input: GroundingInput): string {
  const { drawers, warnings, availableInScope, wingScope } = input;
  const lines: string[] = [];
  lines.push(`── Palace context (${drawers.length} drawer${drawers.length === 1 ? "" : "s"}) ──`);
  if (drawers.length === 0) {
    lines.push("(no palace context retrieved for this turn)");
  } else {
    for (const d of drawers) {
      const tags: string[] = [];
      if (d.id) tags.push(`drawer_id=${d.id}`);
      tags.push(`wing=${d.wing}`);
      tags.push(`room=${d.room}`);
      if (d.created_at) tags.push(`date=${d.created_at.slice(0, 10)}`);
      if (d.similarity !== undefined) tags.push(`similarity=${d.similarity.toFixed(3)}`);
      if (d.matched_via) tags.push(`matched_via=${d.matched_via}`);
      lines.push(`[${tags.join(" · ")}]`);
      lines.push(d.text);
      lines.push("");
    }
  }
  lines.push("── Palace search quality ──");
  lines.push(`available_in_scope: ${availableInScope.toLocaleString("en-US")}`);
  if (wingScope) lines.push(`wing_scope: ${wingScope}`);
  if (warnings.length > 0) {
    lines.push("warnings:");
    for (const w of warnings) lines.push(`  - ${w}`);
  } else {
    lines.push("warnings: none");
  }
  return lines.join("\n");
}
