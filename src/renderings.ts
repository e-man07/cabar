/**
 * Prism renderings: deterministic multi-fidelity renderings of a retrieved
 * unit (the CABAR-2 "Prism" extension of CABAR's all-or-nothing selection).
 *
 * CABAR-1 spent budget on a unit at a single fidelity (verbatim, or nothing —
 * with an extractive tail for the rest). Prism turns that binary into a ladder:
 * a unit can be rendered at VERBATIM (full content), EXTRACT (query-aware
 * sentence extract, ≤~40% of verbatim tokens), CLAIMS (its pre-resolved claim
 * bullets), or MENTION (a one-line dereferenceable pointer). The MCKP selector
 * (PrismSelector) then picks per-unit fidelities to maximize utility under the
 * token budget instead of dropping units wholesale.
 *
 * Every rendering here is PURE and deterministic: no LLM, no I/O, no clock.
 * Costs are measured through an injected `TokenCounter` (char/4 by default,
 * real BPE when you inject one) so the same code costs the same
 * text the caller will bill for. Claims are pre-fetched by the caller and live
 * on the unit — this module never fetches them.
 */

import type { PrismUnit } from './prism';
import type { TokenCounter } from './shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** EXTRACT targets at most this fraction of the verbatim token count. */
export const EXTRACT_TARGET_RATIO = 0.4;
/** Positional prior: the opening sentence carries topic-setting signal. */
export const EXTRACT_FIRST_SENTENCE_BONUS = 1;
/** MENTION lines truncate their sentence to at most this many tokens. */
export const MENTION_MAX_TOKENS = 25;

// ---------------------------------------------------------------------------
// Shared lexical helpers (reused by PrismSelector for novelty Jaccard so the
// rendering token-sets and the MMR token-sets are tokenized identically — and
// so verbatim novelty matches CabarSelector's exactly for the equivalence test)
// ---------------------------------------------------------------------------

/** Lowercased word (3+ chars) token set — same family as CabarSelector.tokenize. */
export function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]{3,}/g);
  return new Set(matches ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Sentence split — same regex family as CabarSelector.buildTailSummary. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Word-boundary truncation to a token budget, appending an ellipsis only when
 * the text is actually cut. Uses the injected counter so the cut respects the
 * caller's tokenization (char/4 or BPE). Always keeps at least the first word.
 */
export function truncateToTokens(text: string, maxTokens: number, counter: TokenCounter): string {
  if (counter.count(text) <= maxTokens) return text;
  const words = text.split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const candidate = out ? `${out} ${w}` : w;
    if (counter.count(`${candidate}…`) > maxTokens) break;
    out = candidate;
  }
  if (!out) out = words[0] ?? '';
  return `${out}…`;
}

// ---------------------------------------------------------------------------
// Renderings (each deterministic, no LLM)
// ---------------------------------------------------------------------------

/** VERBATIM — the unit's full content, unchanged. */
export function verbatim(u: PrismUnit): string {
  return u.content;
}

/**
 * EXTRACT — query-aware sentence extraction targeting ≤~40% of verbatim tokens.
 *
 * Sentences are scored by query-term overlap plus a first-sentence positional
 * prior, deduped on normalized text, then greedily packed (highest score first,
 * stable on original order) up to the ~40% token target. Selected sentences are
 * emitted in ORIGINAL narrative order (unlike the score-ordered tail) so the
 * extract reads coherently. Never returns empty for non-empty content: if the
 * target is too small for any sentence, the single top-scored sentence is kept
 * (a single-sentence unit thus extracts to itself, and is dropped later by the
 * selector's cost-dominance guard rather than duplicating verbatim).
 */
export function extract(u: PrismUnit, query: string, counter: TokenCounter): string {
  const sentences = splitSentences(u.content);
  if (sentences.length <= 1) return u.content.trim();

  const queryTokens = tokenize(query);
  const target = Math.max(1, Math.floor(counter.count(u.content) * EXTRACT_TARGET_RATIO));

  interface Scored {
    text: string;
    order: number;
    score: number;
    cost: number;
  }
  const scored: Scored[] = [];
  const seen = new Set<string>();
  sentences.forEach((text, order) => {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(normalized)) return; // exact-normalized dedup, keep first occurrence
    seen.add(normalized);
    let overlap = 0;
    for (const t of tokenize(text)) {
      if (queryTokens.has(t)) overlap++;
    }
    scored.push({
      text,
      order,
      score: overlap + (order === 0 ? EXTRACT_FIRST_SENTENCE_BONUS : 0),
      cost: counter.count(text),
    });
  });

  // Greedy pack by score (stable on original order), staying within the target.
  const byScore = [...scored].sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen: Scored[] = [];
  let used = 0;
  for (const s of byScore) {
    if (used + s.cost > target) continue; // skip; a smaller lower-scored sentence may still fit
    chosen.push(s);
    used += s.cost;
  }
  if (chosen.length === 0) chosen.push(byScore[0]!); // never empty for multi-sentence content

  // Emit in original narrative order.
  chosen.sort((a, b) => a.order - b.order);
  return chosen.map((s) => s.text).join(' ');
}

/**
 * CLAIMS — the unit's pre-resolved claims as '- <claim>' bullet lines.
 * UNAVAILABLE (null) when the caller pre-fetched no claims for this unit.
 */
export function claimsRendering(u: PrismUnit): string | null {
  if (!u.claims?.length) return null;
  return u.claims.map((c) => `- ${c}`).join('\n');
}

/**
 * MENTION — a one-line dereferenceable pointer:
 *   [<id>@<yyyy-mm-dd if timestamp>] <first sentence, ≤25 tokens>
 * This is the answer-lossless floor: even a unit that loses the budget contest
 * still leaves a citable trace the caller can dereference back to the full unit.
 */
export function mention(u: PrismUnit, counter: TokenCounter): string {
  const first = splitSentences(u.content)[0] ?? u.content.trim();
  const snippet = truncateToTokens(first, MENTION_MAX_TOKENS, counter);
  const idPart = u.timestamp ? `${u.id}@${u.timestamp.toISOString().slice(0, 10)}` : u.id;
  return `[${idPart}] ${snippet}`;
}
