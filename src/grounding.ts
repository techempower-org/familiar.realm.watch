import type { PalaceDrawer } from "./types.ts";
import { voice } from "./lang/familiar-voice.ts";

export interface GroundingInput {
  drawers: PalaceDrawer[];
  warnings: string[];
  availableInScope: number;
  wingScope: string | null;
  /** When true, append a system directive nudging the assistant to suggest rephrasing/scoping. */
  stuck?: boolean;
  /** Override "now" for deterministic tests. Defaults to Date.now() at call site. */
  now?: Date;
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
speak plainly and never perform wisdom you don't have. The palace is your shared memory with JP —
not a database to recite from. Use it as a friend would: as context for what you already know
about them, not as the only thing you can say.`;

/**
 * Anchor the model in the current moment. Same pattern clock.realm.watch's
 * SessionStart hook uses for Claude Code: a single timestamp line so the
 * model never has to guess the date or weekday from training data.
 *
 * Format mirrors `date +"%A %Y-%m-%d %H:%M %Z"` for consistency across the
 * realm.watch ecosystem. Recomputed per turn (cheap), so a session that
 * spans midnight reflects the new date by the next message.
 */
function nowAnchor(now: Date): string {
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  // Time zone abbreviation via Intl — falls back gracefully on unsupported runtimes.
  let tz = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(now);
    tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    // leave tz empty
  }
  return `── Now ──\n${dayName} ${yyyy}-${mm}-${dd} ${hh}:${min}${tz ? " " + tz : ""}`;
}

const DIRECTIVES = `── How to use the palace context ──
- For factual claims about JP, their projects, their realm, or past events: prefer the palace context and cite the drawer it came from. Use the EXACT format \`[drawer_xxx]\` — square brackets around the literal drawer id (e.g. \`[drawer_storyvox_architecture_bae0315]\`). Do NOT write the word "drawer_id" as a label, just the bracketed id itself. Multiple-citation example: "Phi-4 runs at 28 tok/s [drawer_familiar_realm_watch_decisions_abc123] on the P102 [drawer_familiar_realm_watch_hardware_def456]."
- For questions about you (the familiar) — your nature, role, what you can do, your strengths and quirks: answer from your persona above. Palace context is a supplement, not the source. Do not literalize technical config values as personality traits (e.g., a "strength: 0.65" knob in a config drawer is not your *strength* as a familiar).
- If palace context contains multiple values for the same fact (a date, a name that shifted over time), list them and name the ambiguity — don't silently pick one.
- If palace context is thin or contains mostly technical/system/infrastructure drawers, don't force-cite them. Answer naturally from what you do know, and tell JP honestly what's missing.
- For greetings, jokes, creative chat, or meta-questions about this conversation: no palace grounding required. Respond as the familiar would.
- When you cite, cite sparingly — at most one bracketed drawer per fact. Don't decorate every clause.`;

export function buildSystemPrompt(input: GroundingInput): string {
  const parts: string[] = [];
  parts.push(PERSONA);
  parts.push("");
  parts.push(nowAnchor(input.now ?? new Date()));
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
