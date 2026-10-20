/**
 * PrismSelector: CABAR-2 multi-fidelity budgeted selection.
 *
 * Where CabarSelector answers "which units do we spend verbatim budget
 * on, and summarize the rest", Prism answers the finer question "at WHICH
 * FIDELITY do we render each unit". It solves a Multiple-Choice Knapsack
 * Problem (MCKP): each unit offers a small menu of renderings — verbatim /
 * extract / claims / mention — with distinct (cost, utility) points, and the
 * selector greedily packs marginal-utility-per-token, allowed to UPGRADE an
 * already-selected unit to a costlier fidelity when that upgrade is the densest
 * feasible move. All-or-nothing (CABAR-1) is the special case of a two-point
 * menu {verbatim, absent}; Prism dominates it under tight budgets by trading a
 * verbatim unit for several cheaper-fidelity units that together carry more.
 *
 * Design invariants (same purity contract as CabarSelector):
 *   - PURE + deterministic: no LLM, no I/O, no Date.now — the caller supplies
 *     `now`; `claims` are pre-fetched onto the units by the caller.
 *   - Provider-agnostic token cost: the injectable `TokenCounter` defaults to
 *     the shared char/4 estimator (prod), and benchmarks inject a real BPE
 *     counter. Selection logic never assumes a specific vocabulary.
 *   - Cache-stable OUTPUT ORDERING: selected units are emitted by
 *     (timestamp asc, id asc), NOT by score, so the same units land in the same
 *     prompt slots turn-over-turn (KV-cache friendly).
 *   - β-hysteresis: an optional per-unit bonus for re-selecting a unit at
 *     ≥ its previous fidelity (keeps prompts stable turn-over-turn). Defaults
 *     to 0, a no-op.
 *   - Answer-lossless FLOOR: every unit at or above `tauFloor` that misses the
 *     budget still gets a mention line in the tail, so nothing recallable is
 *     silently dropped.
 */

import { CHAR4_COUNTER, DEFAULT_RECENCY_DECAY_DAYS, recencyDecay, stripUndefined, type TokenCounter } from './shared';
import { extract, mention, claimsRendering, verbatim, tokenize, jaccard, truncateToTokens } from './renderings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { TokenCounter } from './shared';

/** The four rendering fidelities, most→least faithful. */
export type Fidelity = 'verbatim' | 'extract' | 'claims' | 'mention';

/** Fidelity rank (higher = more faithful) — used by the β-hysteresis predicate. */
const FIDELITY_RANK: Record<Fidelity, number> = { mention: 0, claims: 1, extract: 2, verbatim: 3 };

/** A retrieved unit plus its caller-pre-fetched claims (the CabarUnit + claims). */
export interface PrismUnit {
  id: string;
  content: string;
  /** Relevance from your retriever, normalized to [0,1] (top item ideally 1.0). */
  score: number;
  timestamp?: Date;
  /** Pre-resolved claim strings; enables the CLAIMS fidelity. Selector never fetches these. */
  claims?: string[];
}

/** Per-fidelity multipliers φ(f) — how much utility a fidelity retains vs verbatim. */
export type FidelityFactors = Record<Fidelity, number>;

export interface PrismSelectOptions {
  /** Token budget for the guaranteed block + selected renderings. The tail is capped separately by tailBudgetTokens. */
  budgetTokens?: number;
  /** Hard cap on DISTINCT units selected (upgrades do not count against it). */
  maxUnits?: number;
  /** Hard token cap for the mention-line tail (separate from budgetTokens). */
  tailBudgetTokens?: number;
  /** Minimum score for a unit to earn a tail mention line (below this: dropped). */
  tauFloor?: number;
  /** ρ = recencyLambda·decay + (1−recencyLambda). 0 ⇒ ρ≡1 (multi-session safe). */
  recencyLambda?: number;
  /** Recency scale in days for the exponential decay e^(-age/days). Default 365. */
  recencyDecayDays?: number;
  /** Blend on the novelty term: effectiveNovelty = 1 − noveltyWeight·(1 − novelty). */
  noveltyWeight?: number;
  /** Tokens pre-charged against budgetTokens before selection (e.g. resolved-claims block). */
  guaranteedTokens?: number;
  /** Deterministic "current time" for recency. Defaults to `new Date()`. */
  now?: Date;
  /** Injectable token cost model. Defaults to the shared char/4 estimator. */
  tokenCounter?: TokenCounter;
  /** Per-fidelity utility multipliers φ. Merged over defaults. */
  fidelityFactors?: Partial<FidelityFactors>;
  /** β — multiplicative bonus ×(1+β) for re-selecting a unit at ≥ prev fidelity. */
  hysteresisBonus?: number;
  /** Prior turn's selection (unit → fidelity) for the β-hysteresis predicate. */
  prevSelected?: Array<{ unitId: string; fidelity: Fidelity }>;
  /**
   * Adaptive stopping mode. When true, ADD-move admission
   * (a unit newly entering the selection) is gated: past `minKeep` distinct
   * units, a unit may only be ADD-admitted if its relevance fraction (score /
   * top-candidate score) is >= `relFloor` AND the candidate rendering's
   * novelty vs the already-chosen renderings is >= `novFloor`. UPGRADE moves
   * and the mention-tail are unaffected. `maxCeilingTokens` replaces
   * `budgetTokens` as the only hard token bound (`maxUnits` is ignored).
   * Default false: behavior is byte-identical to the fixed-budget path.
   */
  adaptive?: boolean;
  /** Adaptive mode: distinct units ADD-admitted before the relFloor/novFloor gate applies. Default 3. */
  minKeep?: number;
  /** Adaptive mode: below this fraction of the top candidate's score, ADD admission stops. Default 0.4. */
  relFloor?: number;
  /** Adaptive mode: below this novelty vs chosen renderings, ADD admission stops. Default 0.2. */
  novFloor?: number;
  /** Adaptive mode: hard token ceiling — replaces budgetTokens as the bound. Default 4000. */
  maxCeilingTokens?: number;
}

export interface PrismSelectedUnit {
  unit: PrismUnit;
  fidelity: Fidelity;
  rendered: string;
  tokens: number;
}

export interface PrismStats {
  /** Sum of every candidate unit's VERBATIM cost (the pre-selection ceiling). */
  candidateTokens: number;
  selectedTokens: number;
  tailTokens: number;
  budgetTokens: number;
  /** guaranteedTokens + selectedTokens + tailTokens — actual spend vs budgetTokens. */
  utilizedTokens: number;
  fidelityHistogram: Record<Fidelity, number>;
  /** Number of greedy moves applied (adds + upgrades). */
  moves: number;
}

export interface PrismSelectResult {
  selected: PrismSelectedUnit[];
  /** Unselected units at or above tauFloor — floored into the mention tail. */
  tail: PrismUnit[];
  /** The rendered tail block (mention lines, or verbatim on the tiny-pool guard). */
  tailBlock: string;
  stats: PrismStats;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: Required<
  Omit<
    PrismSelectOptions,
    | 'now'
    | 'tokenCounter'
    | 'fidelityFactors'
    | 'prevSelected'
    | 'adaptive'
    | 'minKeep'
    | 'relFloor'
    | 'novFloor'
    | 'maxCeilingTokens'
  >
> = {
  budgetTokens: 4000,
  maxUnits: 12,
  tailBudgetTokens: 600,
  tauFloor: 0.15,
  recencyLambda: 0.3,
  recencyDecayDays: DEFAULT_RECENCY_DECAY_DAYS,
  noveltyWeight: 1,
  guaranteedTokens: 0,
  hysteresisBonus: 0,
};

/** Adaptive-mode-only defaults (fixed global constants, never tuned per query type). */
const ADAPTIVE_DEFAULTS = {
  minKeep: 3,
  relFloor: 0.4,
  novFloor: 0.2,
  maxCeilingTokens: 4000,
};

/** Default φ: verbatim full-value, extract/claims discounted, mention a thin pointer. */
const DEFAULT_FIDELITY_FACTORS: FidelityFactors = {
  verbatim: 1.0,
  extract: 0.85,
  claims: 0.75,
  mention: 0.3,
};


const MS_PER_DAY = 86_400_000;

/** All fidelities in fixed order (drives stable move iteration + histogram init). */
const ALL_FIDELITIES: Fidelity[] = ['verbatim', 'extract', 'claims', 'mention'];

// ---------------------------------------------------------------------------
// Internal per-unit rendering menu
// ---------------------------------------------------------------------------

interface Rendering {
  fidelity: Fidelity;
  rendered: string;
  cost: number;
  tokens: Set<string>;
  phi: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// PrismSelector
// ---------------------------------------------------------------------------

export class PrismSelector {
  /**
   * MCKP-greedy multi-fidelity selection: build each unit's rendering menu,
   * greedily apply the densest feasible ADD/UPGRADE move, run the KMN
   * best-single swap, then floor the remainder into a mention tail.
   */
  static select(units: PrismUnit[], query: string, opts: PrismSelectOptions = {}): PrismSelectResult {
    const cfg = { ...DEFAULTS, ...stripUndefined(opts) };
    const now = opts.now ?? new Date();
    const counter = opts.tokenCounter ?? CHAR4_COUNTER;
    const phi: FidelityFactors = { ...DEFAULT_FIDELITY_FACTORS, ...opts.fidelityFactors };

    const adaptive = opts.adaptive === true;
    const minKeep = opts.minKeep ?? ADAPTIVE_DEFAULTS.minKeep;
    const relFloor = opts.relFloor ?? ADAPTIVE_DEFAULTS.relFloor;
    const novFloor = opts.novFloor ?? ADAPTIVE_DEFAULTS.novFloor;
    const maxCeilingTokens = opts.maxCeilingTokens ?? ADAPTIVE_DEFAULTS.maxCeilingTokens;
    // The top score is computed as an explicit max (not a units[0] read) so a
    // caller that passes an unsorted or re-ranked pool still gets the correct,
    // fixed-at-the-start normalizer for the adaptive relevance cliff.
    const topScore = units.length > 0 ? Math.max(...units.map((u) => u.score)) : 1;

    // Adaptive mode: maxCeilingTokens is the only hard token bound (budgetTokens/
    // maxUnits are ignored); guaranteedTokens is still pre-charged against it.
    const effectiveBudget = adaptive ? maxCeilingTokens : cfg.budgetTokens;
    const budget = Math.max(0, effectiveBudget - cfg.guaranteedTokens);

    const unitById = new Map<string, PrismUnit>();
    const inputIndex = new Map<string, number>();
    units.forEach((u, i) => {
      unitById.set(u.id, u);
      inputIndex.set(u.id, i);
    });

    // --- Build each unit's rendering menu (with the cost-dominance guard) ---
    // Verbatim is always offered; any other rendering costing ≥ verbatim is
    // dropped (e.g. claims lines longer than the memory itself, or an extract
    // that collapsed to the whole single-sentence content).
    const menuOf = new Map<string, Rendering[]>();
    let candidateTokens = 0;
    for (const u of units) {
      const vCost = counter.count(u.content);
      candidateTokens += vCost;

      const menu: Rendering[] = [];
      for (const f of ALL_FIDELITIES) {
        const rendered = renderFidelity(u, f, query, counter);
        if (rendered === null) continue; // UNAVAILABLE (e.g. no claims)
        const cost = counter.count(rendered);
        if (f !== 'verbatim' && cost >= vCost) continue; // cost-dominance guard
        menu.push({ fidelity: f, rendered, cost, tokens: tokenize(rendered), phi: phi[f], rank: FIDELITY_RANK[f] });
      }
      menuOf.set(u.id, menu);
    }

    // --- Recency ρ (same curve as CabarSelector) ---
    const recencyOf = (u: PrismUnit): number => {
      if (!u.timestamp || cfg.recencyLambda === 0) return 1;
      const ageInDays = Math.max(0, (now.getTime() - u.timestamp.getTime()) / MS_PER_DAY);
      const decay = recencyDecay(ageInDays, cfg.recencyDecayDays);
      return cfg.recencyLambda * decay + (1 - cfg.recencyLambda);
    };

    // --- Selection state ---
    const chosen = new Map<string, Rendering>();
    let selectedTokens = 0;
    let totalUtility = 0;
    let moves = 0;

    // Prior-turn fidelity ranks for the β-hysteresis predicate.
    const prevRank = new Map<string, number>();
    for (const p of opts.prevSelected ?? []) {
      const r = FIDELITY_RANK[p.fidelity];
      const existing = prevRank.get(p.unitId);
      if (existing === undefined || r < existing) prevRank.set(p.unitId, r); // lowest prev rank = easiest to satisfy ≥
    }

    // Novelty of a token-set vs the CHOSEN renderings of already-selected units
    // (excluding `excludeId` so an upgrade isn't penalized against itself).
    const noveltyOf = (tokens: Set<string>, excludeId: string | null): number => {
      let maxSim = 0;
      for (const [id, r] of chosen) {
        if (id === excludeId) continue;
        const sim = jaccard(tokens, r.tokens);
        if (sim > maxSim) maxSim = sim;
      }
      return 1 - maxSim;
    };

    // Utility g(u, rendering) with novelty vs chosen (minus excludeId) and β.
    const utilityOf = (u: PrismUnit, r: Rendering, excludeId: string | null): number => {
      const noveltyRaw = noveltyOf(r.tokens, excludeId);
      const effectiveNovelty = 1 - cfg.noveltyWeight * (1 - noveltyRaw);
      let g = u.score * recencyOf(u) * effectiveNovelty * r.phi;
      const pr = prevRank.get(u.id);
      if (cfg.hysteresisBonus > 0 && pr !== undefined && r.rank >= pr) {
        g *= 1 + cfg.hysteresisBonus;
      }
      return g;
    };

    // --- Greedy MCKP loop: densest feasible ADD or UPGRADE each round ---
    interface Move {
      unitId: string;
      rendering: Rendering;
      deltaG: number;
      deltaC: number;
      density: number;
    }
    // Strict comparison + fixed iteration order (units in input order, fidelities
    // in ALL_FIDELITIES order) ⇒ ties resolve to stable input order.
    const better = (a: Move, b: Move | null): boolean =>
      b === null || a.density > b.density || (a.density === b.density && a.deltaG > b.deltaG);

    for (;;) {
      let best: Move | null = null;

      for (const u of units) {
        const menu = menuOf.get(u.id)!;
        const current = chosen.get(u.id);

        if (!current) {
          // ADD moves — only if a distinct-unit slot remains. maxUnits is
          // ignored in adaptive mode (the relFloor/novFloor gate below
          // replaces it as the thing that stops new units from entering).
          if (!adaptive && chosen.size >= cfg.maxUnits) continue;
          for (const r of menu) {
            if (r.cost <= 0) continue;
            if (selectedTokens + r.cost > budget) continue;
            // Adaptive ADD-move admission gate: past minKeep
            // distinct units, a unit may only be newly added if it clears both
            // floors — relevance fraction vs the pool's top score, and this
            // candidate rendering's novelty vs what's already chosen. UPGRADE
            // moves (the `else` branch below) are never gated.
            if (adaptive && chosen.size >= minKeep) {
              const relFrac = u.score / (topScore || 1);
              const nov = noveltyOf(r.tokens, null);
              if (relFrac < relFloor || nov < novFloor) continue;
            }
            const deltaG = utilityOf(u, r, null);
            if (deltaG <= 0) continue;
            const move: Move = { unitId: u.id, rendering: r, deltaG, deltaC: r.cost, density: deltaG / r.cost };
            if (better(move, best)) best = move;
          }
        } else {
          // UPGRADE moves — to a strictly costlier fidelity of the same unit.
          const baseG = utilityOf(u, current, u.id);
          for (const r of menu) {
            const deltaC = r.cost - current.cost;
            if (deltaC <= 0) continue; // must be strictly costlier
            if (selectedTokens + deltaC > budget) continue;
            const deltaG = utilityOf(u, r, u.id) - baseG;
            if (deltaG <= 0) continue;
            const move: Move = { unitId: u.id, rendering: r, deltaG, deltaC, density: deltaG / deltaC };
            if (better(move, best)) best = move;
          }
        }
      }

      if (!best) break;
      selectedTokens += best.deltaC;
      totalUtility += best.deltaG;
      chosen.set(best.unitId, best.rendering);
      moves++;
    }

    // --- KMN best-single-vs-greedy swap (same as CabarSelector) ---
    // A single verbatim unit whose standalone utility beats the whole greedy
    // pack is taken instead — the budgeted-max-coverage 2-approx guarantee.
    // maxUnits is ignored in adaptive mode, so the guard is unconditional then.
    if (adaptive || cfg.maxUnits >= 1) {
      let bestSingle: { unit: PrismUnit; rendering: Rendering; utility: number } | null = null;
      for (const u of units) {
        const vr = menuOf.get(u.id)!.find((r) => r.fidelity === 'verbatim');
        if (!vr || vr.cost > budget) continue;
        const utility = u.score * recencyOf(u) * vr.phi; // evaluated alone: novelty(∅)=1
        if (!bestSingle || utility > bestSingle.utility) bestSingle = { unit: u, rendering: vr, utility };
      }
      if (bestSingle && bestSingle.utility > totalUtility) {
        chosen.clear();
        chosen.set(bestSingle.unit.id, bestSingle.rendering);
        selectedTokens = bestSingle.rendering.cost;
        totalUtility = bestSingle.utility;
      }
    }

    // --- Tail: mention-line floor for every unselected unit ≥ tauFloor ---
    // Mention lines replace CABAR-1's sentence soup: an answer-lossless,
    // dereferenceable pointer per unit. Greedy by score into a hard tail cap.
    const eligible = units
      .filter((u) => !chosen.has(u.id) && u.score >= cfg.tauFloor)
      .sort((a, b) => b.score - a.score || inputIndex.get(a.id)! - inputIndex.get(b.id)!);

    const mentionLines: string[] = [];
    let mentionUsed = 0;
    for (const u of eligible) {
      const line = mention(u, counter);
      const lineTokens = counter.count(mentionLines.length === 0 ? line : `\n${line}`);
      if (mentionUsed + lineTokens > cfg.tailBudgetTokens) break; // hard cap, never exceed
      mentionLines.push(line);
      mentionUsed += lineTokens;
    }
    const mentionBlock = mentionLines.join('\n');

    // Tail-cost guard (tiny pools): if the prefixed mention lines cost more than
    // the raw content they point at, emit the cheaper verbatim block instead.
    const verbatimBlock = eligible.map((u) => u.content.trim()).join('\n');
    let tailBlock =
      eligible.length === 0
        ? ''
        : counter.count(verbatimBlock) < counter.count(mentionBlock)
          ? verbatimBlock
          : mentionBlock;
    if (counter.count(tailBlock) > cfg.tailBudgetTokens) {
      tailBlock = truncateToTokens(tailBlock, cfg.tailBudgetTokens, counter);
    }
    const tailTokens = counter.count(tailBlock);

    // --- Output ordering: cache-stable (timestamp asc, id asc), NOT score ---
    const selected: PrismSelectedUnit[] = [...chosen.entries()]
      .map(([id, r]) => ({ unit: unitById.get(id)!, fidelity: r.fidelity, rendered: r.rendered, tokens: r.cost }))
      .sort((a, b) => tsKey(a.unit) - tsKey(b.unit) || a.unit.id.localeCompare(b.unit.id));

    const fidelityHistogram: Record<Fidelity, number> = { verbatim: 0, extract: 0, claims: 0, mention: 0 };
    for (const s of selected) fidelityHistogram[s.fidelity]++;

    return {
      selected,
      tail: eligible,
      tailBlock,
      stats: {
        candidateTokens,
        selectedTokens,
        tailTokens,
        budgetTokens: effectiveBudget,
        utilizedTokens: cfg.guaranteedTokens + selectedTokens + tailTokens,
        fidelityHistogram,
        moves,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dispatch to the right rendering; null = UNAVAILABLE (e.g. no claims). */
function renderFidelity(u: PrismUnit, f: Fidelity, query: string, counter: TokenCounter): string | null {
  switch (f) {
    case 'verbatim':
      return verbatim(u);
    case 'extract':
      return extract(u, query, counter);
    case 'claims':
      return claimsRendering(u);
    case 'mention':
      return mention(u, counter);
    default: {
      const _exhaustive: never = f;
      return _exhaustive;
    }
  }
}

/** Undated units sort first (epoch 0); stable across turns for cache-friendliness. */
function tsKey(u: PrismUnit): number {
  return u.timestamp ? u.timestamp.getTime() : 0;
}
