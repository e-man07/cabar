/**
 * CabarSelector: Context-Budget-Aware Retrieval.
 *
 * Pure, deterministic selection of which retrieved units are worth spending
 * prompt-token budget on, replacing "take the top-K by score" with a greedy
 * utility/cost knapsack:
 *
 *   utility(u, S) = relevance(u) × recency(u) × novelty(u, S)
 *
 * where S is the set already selected (novelty is recomputed against the
 * CURRENT S on every iteration, so a second near-duplicate of an already-picked
 * unit contributes ~0 marginal utility and is skipped in favor of budget spent
 * elsewhere). Units below `tauFloor` relevance are dropped entirely; units at
 * or above the floor that don't make the cut are extractively summarized into
 * a compact `tailSummary` instead of being discarded outright.
 *
 * No LLM calls, no I/O, no `Date.now()`: the caller supplies `now` (defaults
 * to `new Date()` at the call site) so `select()` is a pure, replayable
 * function of its inputs.
 */

import { CHAR4_COUNTER, DEFAULT_RECENCY_DECAY_DAYS, recencyDecay, stripUndefined, type Similarity, type TokenCounter } from './shared';
import { truncateToTokens as truncateWithCounter } from './renderings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CabarUnit {
  id: string;
  content: string;
  /** Relevance from your retriever, normalized to [0,1] (top item ideally 1.0). */
  score: number;
  timestamp?: Date;
  /** Optional vector for `similarity: embeddingSimilarity`. */
  embedding?: ArrayLike<number>;
}

export interface CabarSelectOptions {
  /** Token budget for the guaranteed block + selected units. The tail summary is capped separately by tailBudgetTokens. */
  budgetTokens?: number;
  /** Hard cap on the number of units selected, independent of budget. */
  maxUnits?: number;
  /** Hard token cap for the extractive tail summary (on top of budgetTokens). */
  tailBudgetTokens?: number;
  /** Minimum relevance score for a unit to survive into the tail at all (below this: dropped). */
  tauFloor?: number;
  /**
   * Blend factor between "ignore recency" (0) and "full recency effect" (1).
   * ρ = recencyLambda × decay + (1 − recencyLambda). At 0, ρ ≡ 1 for every
   * unit regardless of timestamp — required for multi-session safety (a
   * cross-session query shouldn't be penalized just because the recall is old).
   */
  recencyLambda?: number;
  /** Recency scale in days for the exponential decay e^(-age/days). Default 365. */
  recencyDecayDays?: number;
  /**
   * Blend factor between "ignore novelty" (0) and "full novelty effect" (1)
   * applied to the raw novelty(u,S) ∈ [0,1] term:
   *   effectiveNovelty = 1 − noveltyWeight × (1 − novelty(u,S))
   * Defaults to 1, i.e. utility = r × ρ × novelty(u,S) exactly as specified.
   */
  noveltyWeight?: number;
  /** Tokens pre-charged against budgetTokens before selection starts (e.g. the resolved-claims block). */
  guaranteedTokens?: number;
  /** Deterministic "current time" for recency scoring. Defaults to `new Date()`. */
  now?: Date;
  /** Injectable token cost model. Defaults to the char/4 estimator. */
  tokenCounter?: TokenCounter;
  /**
   * Similarity used for novelty, in [0, 1]. Defaults to word-set Jaccard.
   * Pass `embeddingSimilarity` (with `embedding` on each unit) to catch paraphrases.
   */
  similarity?: Similarity<CabarUnit>;
  /**
   * Adaptive stopping mode. When true, the greedy loop's
   * stop condition is replaced: instead of the fixed `budgetTokens`/`maxUnits`
   * caps, it keeps accepting units past `minKeep` only while the next unit's
   * relevance fraction (score / top-candidate score) is >= `relFloor` AND its
   * novelty vs the already-selected set is >= `novFloor`; `maxCeilingTokens`
   * becomes the only hard token bound (`maxUnits` is ignored). This lets the
   * pool's own relevance-score shape decide how much to keep — noisy pools
   * (one strong hit, many weak ones) stop near `minKeep`; concentrated/spread
   * pools with a genuine relevant tail keep more. Default false: behavior is
   * byte-identical to the fixed-budget path.
   */
  adaptive?: boolean;
  /** Adaptive mode: units accepted before the relFloor/novFloor stop rule can trigger. Default 3. */
  minKeep?: number;
  /** Adaptive mode: below this fraction of the top candidate's score, the greedy fill stops. Default 0.4. */
  relFloor?: number;
  /** Adaptive mode: below this novelty vs the selected set, the greedy fill stops. Default 0.2. */
  novFloor?: number;
  /** Adaptive mode: hard token ceiling — replaces budgetTokens as the bound. Default 4000. */
  maxCeilingTokens?: number;
  /**
   * Adaptive mode: also honor `maxUnits` as a hard ceiling ("capped adaptive").
   * The relFloor/novFloor early-stop can still stop BELOW maxUnits on cliff-y
   * (noisy) pools — this only prevents adaptive from keeping MORE than maxUnits on
   * uniformly-relevant (concentrated) pools, where the uncapped rule over-keeps
   * with no accuracy payoff. Unifies cabar1's ceiling with adaptive's early stop:
   * concentrated → cap binds (≡ cabar1); noisy → cliff stops early (≡ adaptive).
   * Default false (preserves the original uncapped adaptive arm byte-identically).
   */
  capToMaxUnits?: boolean;
}

export interface CabarStats {
  candidateCount: number;
  candidateTokens: number;
  selectedTokens: number;
  tailSummaryTokens: number;
  budgetTokens: number;
  /** guaranteedTokens + selectedTokens + tailSummaryTokens — actual spend against budgetTokens. */
  utilizedTokens: number;
}

export interface CabarSelectResult {
  selected: CabarUnit[];
  /** Unselected units at or above tauFloor — summarized into tailSummary, not dropped. */
  tail: CabarUnit[];
  tailSummary: string;
  stats: CabarStats;
}

/** Fixed-mode selector defaults. Exported so `cabar.config.ts` can source the
 * budget/maxUnits ceilings from one place instead of re-declaring the literals. */
export const DEFAULTS: Required<Omit<CabarSelectOptions, 'now' | 'tokenCounter' | 'similarity' | 'adaptive' | 'minKeep' | 'relFloor' | 'novFloor' | 'maxCeilingTokens' | 'capToMaxUnits'>> = {
  budgetTokens: 4000,
  maxUnits: 8,
  tailBudgetTokens: 600,
  tauFloor: 0.15,
  recencyLambda: 0.3,
  recencyDecayDays: DEFAULT_RECENCY_DECAY_DAYS,
  noveltyWeight: 1,
  guaranteedTokens: 0,
};

/** Adaptive-mode-only defaults (fixed global constants, never tuned per query type). */
export const ADAPTIVE_DEFAULTS = {
  minKeep: 3,
  relFloor: 0.4,
  novFloor: 0.2,
  maxCeilingTokens: 4000,
};

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Tokenization / similarity helpers
// ---------------------------------------------------------------------------

/**
 * Lowercased word (3+ chars) token set. CabarSelector runs after retrieval, on
 * already-scored units, without embeddings: Jaccard over word tokens is the
 * deliberately cheap novelty stand-in. Cosine over the units' embeddings
 * would be a drop-in upgrade.
 */
function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]{3,}/g);
  return new Set(matches ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// CabarSelector
// ---------------------------------------------------------------------------

export class CabarSelector {
  /**
   * Select which units fit the budget, greedily maximizing utility/cost
   * density, with a best-single-vs-greedy swap (budgeted-max-coverage 2-approx
   * guarantee) and an extractive tail summary for the rest.
   */
  static select(units: CabarUnit[], query: string, opts: CabarSelectOptions = {}): CabarSelectResult {
    const cfg = { ...DEFAULTS, ...stripUndefined(opts) };
    const now = opts.now ?? new Date();
    const counter = opts.tokenCounter ?? CHAR4_COUNTER;
    const count = (t: string) => counter.count(t);

    const adaptive = opts.adaptive === true;
    const minKeep = opts.minKeep ?? ADAPTIVE_DEFAULTS.minKeep;
    const relFloor = opts.relFloor ?? ADAPTIVE_DEFAULTS.relFloor;
    const novFloor = opts.novFloor ?? ADAPTIVE_DEFAULTS.novFloor;
    const maxCeilingTokens = opts.maxCeilingTokens ?? ADAPTIVE_DEFAULTS.maxCeilingTokens;
    const capToMaxUnits = opts.capToMaxUnits === true;
    // The top score is computed as an explicit max (not a units[0] read) so a
    // caller that passes an unsorted or re-ranked pool still gets the correct,
    // fixed-at-the-start normalizer for the adaptive relevance cliff.
    const topScore = units.length > 0 ? Math.max(...units.map((u) => u.score)) : 1;

    const costOf = new Map<string, number>();
    const tokensOf = new Map<string, Set<string>>();
    let candidateTokens = 0;
    for (const u of units) {
      const cost = count(u.content);
      costOf.set(u.id, cost);
      tokensOf.set(u.id, tokenize(u.content));
      candidateTokens += cost;
    }

    // Adaptive mode: maxCeilingTokens is the only hard token bound (budgetTokens/
    // maxUnits are ignored); guaranteedTokens is still pre-charged against it.
    const effectiveBudget = adaptive ? maxCeilingTokens : cfg.budgetTokens;
    const remainingBudget = Math.max(0, effectiveBudget - cfg.guaranteedTokens);

    const recencyOf = (u: CabarUnit): number => {
      if (!u.timestamp || cfg.recencyLambda === 0) return 1;
      const ageInDays = Math.max(0, (now.getTime() - u.timestamp.getTime()) / MS_PER_DAY);
      const decay = recencyDecay(ageInDays, cfg.recencyDecayDays);
      return cfg.recencyLambda * decay + (1 - cfg.recencyLambda);
    };

    const noveltyOf = (u: CabarUnit, selectedSoFar: CabarUnit[]): number => {
      if (selectedSoFar.length === 0) return 1;
      const a = tokensOf.get(u.id)!;
      let maxSim = 0;
      for (const s of selectedSoFar) {
        const sim = opts.similarity ? opts.similarity(u, s) : jaccard(a, tokensOf.get(s.id)!);
        if (sim > maxSim) maxSim = sim;
      }
      return 1 - maxSim;
    };

    const utilityOf = (u: CabarUnit, selectedSoFar: CabarUnit[]): number => {
      const r = u.score;
      const rho = recencyOf(u);
      const noveltyRaw = noveltyOf(u, selectedSoFar);
      const effectiveNovelty = 1 - cfg.noveltyWeight * (1 - noveltyRaw);
      return r * rho * effectiveNovelty;
    };

    // --- Greedy loop: pick feasible argmax utility/cost density each round ---
    const selected: CabarUnit[] = [];
    const selectedIds = new Set<string>();
    let selectedTokens = 0;
    let greedyTotalUtility = 0;

    // Capped adaptive: when capToMaxUnits is set, adaptive also respects maxUnits as
    // a hard ceiling (the relFloor/novFloor rule below can still stop earlier).
    while ((adaptive && !capToMaxUnits) || selected.length < cfg.maxUnits) {
      let best: { unit: CabarUnit; utility: number; density: number } | null = null;

      for (const u of units) {
        if (selectedIds.has(u.id)) continue;
        const cost = costOf.get(u.id)!;
        if (selectedTokens + cost > remainingBudget) continue;

        const utility = utilityOf(u, selected);
        if (utility <= 0) continue; // no marginal benefit — don't spend budget on it

        const density = cost > 0 ? utility / cost : Infinity;
        if (!best || density > best.density) {
          best = { unit: u, utility, density };
        }
      }

      if (!best) break;

      // Adaptive stopping rule: past the minKeep floor, stop
      // the greedy fill once the next candidate's relevance fraction or novelty
      // vs the selected set drops below their floors — replaces the fixed
      // budgetTokens/maxUnits caps as the pool's own relevance shape decides
      // how much to keep.
      if (adaptive && selected.length >= minKeep) {
        const relFrac = best.unit.score / (topScore || 1);
        const nov = noveltyOf(best.unit, selected);
        if (relFrac < relFloor || nov < novFloor) break;
      }

      selected.push(best.unit);
      selectedIds.add(best.unit.id);
      selectedTokens += costOf.get(best.unit.id)!;
      greedyTotalUtility += best.utility;
    }

    // --- Best-single-vs-greedy swap (budgeted-max-coverage guarantee) ---
    // maxUnits is ignored in adaptive mode, so the guard is unconditional then.
    if (adaptive || cfg.maxUnits >= 1) {
      let bestSingle: { unit: CabarUnit; utility: number } | null = null;
      for (const u of units) {
        const cost = costOf.get(u.id)!;
        if (cost > remainingBudget) continue;
        const utility = utilityOf(u, []); // evaluated alone, novelty(u, ∅) = 1
        if (!bestSingle || utility > bestSingle.utility) {
          bestSingle = { unit: u, utility };
        }
      }
      if (bestSingle && bestSingle.utility > greedyTotalUtility) {
        selected.length = 0;
        selected.push(bestSingle.unit);
        selectedIds.clear();
        selectedIds.add(bestSingle.unit.id);
        selectedTokens = costOf.get(bestSingle.unit.id)!;
      }
    }

    // --- Tail: unselected units at/above tauFloor, extractively summarized ---
    const tail = units.filter((u) => !selectedIds.has(u.id) && u.score >= cfg.tauFloor);
    // Tail-cost guard: on small pools the per-unit-prefixed extractive summary
    // can cost MORE than the content it replaces. The summary must never
    // exceed the verbatim tail content: build both candidates, emit the
    // cheaper, and hard-cap at tailBudgetTokens either way.
    const extractive = buildTailSummary(tail, query, cfg.tailBudgetTokens, count);
    const verbatim = tail.map((u) => u.content.trim()).join('\n');
    let tailSummary =
      tail.length === 0 ? '' : count(verbatim) < count(extractive) ? verbatim : extractive;
    if (count(tailSummary) > cfg.tailBudgetTokens) {
      // char/4 keeps its original character cut; a real tokenizer gets a word-by-word cut.
      tailSummary =
        counter === CHAR4_COUNTER
          ? truncateToTokens(tailSummary, cfg.tailBudgetTokens)
          : truncateWithCounter(tailSummary, cfg.tailBudgetTokens, counter);
    }
    const tailSummaryTokens = count(tailSummary);

    return {
      selected,
      tail,
      tailSummary,
      stats: {
        candidateCount: units.length,
        candidateTokens,
        selectedTokens,
        tailSummaryTokens,
        budgetTokens: effectiveBudget,
        utilizedTokens: cfg.guaranteedTokens + selectedTokens + tailSummaryTokens,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Extractive tail summary (deterministic, no LLM)
// ---------------------------------------------------------------------------

interface ScoredSentence {
  text: string;
  score: number;
  unitId: string;
  timestamp?: Date;
  order: number;
}

/** Hard-cap text at a token budget using the shared char/4 heuristic (word-boundary cut). */
function truncateToTokens(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 4;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Splits each tail unit into sentences, scores each by (query-term overlap +
 * parent unit's relevance score), and greedily fills `tailBudgetTokens` in
 * descending score order (stable tie-break on original order, so this is
 * deterministic across runs for the same inputs). Exact-normalized-text dedup
 * drops near-identical sentences. No LLM call.
 */
function buildTailSummary(
  tail: CabarUnit[],
  query: string,
  tailBudgetTokens: number,
  count: (text: string) => number,
): string {
  if (tail.length === 0 || tailBudgetTokens <= 0) return '';

  const queryTokens = tokenize(query);
  const sentences: ScoredSentence[] = [];
  let order = 0;

  for (const unit of tail) {
    const parts = unit.content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const text of parts) {
      const tokens = tokenize(text);
      let overlap = 0;
      for (const t of tokens) {
        if (queryTokens.has(t)) overlap++;
      }
      sentences.push({
        text,
        score: overlap + unit.score,
        unitId: unit.id,
        timestamp: unit.timestamp,
        order: order++,
      });
    }
  }

  sentences.sort((a, b) => b.score - a.score || a.order - b.order);

  const seen = new Set<string>();
  const lines: string[] = [];
  let usedTokens = 0;

  for (const s of sentences) {
    const normalized = s.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(normalized)) continue;

    const idPart = s.timestamp ? `${s.unitId}@${s.timestamp.toISOString().slice(0, 10)}` : s.unitId;
    const line = `[${idPart}] ${s.text}`;
    const lineTokens = count(lines.length === 0 ? line : `\n${line}`);

    if (usedTokens + lineTokens > tailBudgetTokens) break; // greedy fill stops at the budget

    seen.add(normalized);
    lines.push(line);
    usedTokens += lineTokens;
  }

  return lines.join('\n');
}
