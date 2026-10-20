/**
 * CabarSelector — Unit Tests
 *
 * Pure-function tests: no DB, no LLM, no wall-clock reads (every test passes
 * an explicit `now`). Covers the budget/knapsack invariants, the novelty-based
 * dedup, the recencyLambda=0 multi-session-safety guarantee, tail-summary
 * correctness/determinism, and the best-single-vs-greedy swap.
 */

import { describe, it, expect } from 'vitest';
import { CabarSelector, CabarUnit } from '../src/cabar';
import { estimateTokens } from '../src/shared';

const NOW = new Date('2026-07-11T00:00:00.000Z');

/** Disjoint-token filler so units never share a word — isolates novelty effects to tests that want them. */
function fill(letter: string, len: number): string {
  return letter.repeat(len);
}

describe('CabarSelector.select', () => {
  describe('budget and maxUnits', () => {
    it('never lets selected + guaranteed exceed budgetTokens', () => {
      const units: CabarUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40), // cost = 10 tokens each
        score: 0.9 - i * 0.1,
      }));

      const result = CabarSelector.select(units, 'query', {
        budgetTokens: 25,
        guaranteedTokens: 5,
        maxUnits: 8,
        now: NOW,
      });

      expect(result.stats.selectedTokens + 5).toBeLessThanOrEqual(25);
      // remaining budget is 20 → exactly 2 units of cost 10 fit
      expect(result.selected.length).toBe(2);
    });

    it('respects maxUnits even when budget would allow more', () => {
      const units: CabarUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40),
        score: 0.9 - i * 0.1,
      }));

      const result = CabarSelector.select(units, 'query', {
        budgetTokens: 1000,
        maxUnits: 2,
        now: NOW,
      });

      expect(result.selected.length).toBe(2);
    });
  });

  describe('greedy density ordering', () => {
    it('picks the highest utility/cost density unit first', () => {
      const units: CabarUnit[] = [
        { id: 'A', content: fill('a', 40), score: 0.9 }, // cost 10, density 0.09
        { id: 'B', content: fill('b', 20), score: 0.6 }, // cost 5,  density 0.12 (highest)
        { id: 'C', content: fill('c', 40), score: 0.3 }, // cost 10, density 0.03
      ];

      const result = CabarSelector.select(units, 'query', {
        budgetTokens: 100,
        maxUnits: 3,
        now: NOW,
      });

      expect(result.selected.map((u) => u.id)).toEqual(['B', 'A', 'C']);
    });
  });

  describe('novelty dedup', () => {
    it('selects only one of two identical-content units', () => {
      const units: CabarUnit[] = [
        { id: 'dup1', content: fill('x', 40), score: 0.9 },
        { id: 'dup2', content: fill('x', 40), score: 0.9 },
      ];

      const result = CabarSelector.select(units, 'query', {
        budgetTokens: 1000,
        maxUnits: 5,
        now: NOW,
      });

      expect(result.selected.length).toBe(1);
    });
  });

  describe('recencyLambda = 0 (multi-session safety)', () => {
    it('produces the same selection whether or not timestamps are present', () => {
      const baseUnits: Array<Omit<CabarUnit, 'timestamp'>> = [
        { id: 'old', content: fill('o', 40), score: 0.8 },
        { id: 'new', content: fill('n', 40), score: 0.8 },
      ];

      const withTimestamps: CabarUnit[] = [
        { ...baseUnits[0]!, timestamp: new Date('2020-01-01T00:00:00.000Z') }, // ~2378 days old
        { ...baseUnits[1]!, timestamp: NOW },
      ];
      const withoutTimestamps: CabarUnit[] = baseUnits.map((u) => ({ ...u }));

      const optsA = { budgetTokens: 1000, maxUnits: 5, recencyLambda: 0, now: NOW };
      const resultWithTimestamps = CabarSelector.select(withTimestamps, 'query', optsA);
      const resultWithoutTimestamps = CabarSelector.select(withoutTimestamps, 'query', optsA);

      expect(resultWithTimestamps.selected.map((u) => u.id)).toEqual(
        resultWithoutTimestamps.selected.map((u) => u.id)
      );
    });

    it('makes rho ≡ 1 for a timestamped unit regardless of age', () => {
      const veryOld: CabarUnit = {
        id: 'ancient',
        content: fill('a', 40),
        score: 0.5,
        timestamp: new Date('1990-01-01T00:00:00.000Z'),
      };
      const noTimestamp: CabarUnit = { id: 'undated', content: fill('a', 40), score: 0.5 };

      const r1 = CabarSelector.select([veryOld], 'query', { recencyLambda: 0, now: NOW, budgetTokens: 1000 });
      const r2 = CabarSelector.select([noTimestamp], 'query', { recencyLambda: 0, now: NOW, budgetTokens: 1000 });

      expect(r1.stats.selectedTokens).toBe(r2.stats.selectedTokens);
      expect(r1.selected.length).toBe(1);
      expect(r2.selected.length).toBe(1);
    });
  });

  describe('tail', () => {
    const units: CabarUnit[] = [
      { id: 'sel1', content: fill('a', 40), score: 0.9 },
      { id: 'sel2', content: fill('b', 40), score: 0.85 },
      { id: 'tail1', content: fill('c', 40), score: 0.5 },
      { id: 'tail2', content: fill('d', 40), score: 0.2 },
      { id: 'dropped', content: fill('e', 40), score: 0.1 }, // below default tauFloor (0.15)
    ];

    it('contains every unselected unit >= tauFloor and none below it', () => {
      const result = CabarSelector.select(units, 'query about c and d', {
        budgetTokens: 25, // only 2 units of cost 10 fit
        maxUnits: 8,
        now: NOW,
      });

      expect(result.selected.map((u) => u.id).sort()).toEqual(['sel1', 'sel2']);
      const tailIds = result.tail.map((u) => u.id).sort();
      expect(tailIds).toEqual(['tail1', 'tail2']);
      expect(result.tail.every((u) => u.score >= 0.15)).toBe(true);
      expect(tailIds).not.toContain('dropped');
    });

    it('keeps tailSummary within tailBudgetTokens and is deterministic across runs', () => {
      const opts = { budgetTokens: 25, tailBudgetTokens: 30, maxUnits: 8, now: NOW };
      const run1 = CabarSelector.select(units, 'query about c and d', opts);
      const run2 = CabarSelector.select(units, 'query about c and d', opts);

      expect(estimateTokens(run1.tailSummary)).toBeLessThanOrEqual(30);
      expect(run1.tailSummary).toBe(run2.tailSummary);
      expect(run1.stats.tailSummaryTokens).toBe(run2.stats.tailSummaryTokens);
    });

    it('tail-cost guard: summary never costs more than the verbatim tail content', () => {
      // Two tiny tail units — the per-unit-prefixed extractive summary would
      // exceed their raw content (the negative-savings case on
      // small pools); the guard must fall back to verbatim.
      // 2 high-density units fill the maxUnits cap; the tiny low-score units
      // land in the tail regardless of leftover budget.
      const tiny: CabarUnit[] = [
        { id: 'sel1', content: fill('a', 40), score: 0.9 },
        { id: 'sel2', content: fill('b', 40), score: 0.85 },
        { id: 't1', content: 'ship it monday', score: 0.2 },
        { id: 't2', content: 'alice owns rollout', score: 0.18 },
      ];
      const result = CabarSelector.select(tiny, 'rollout owner', {
        budgetTokens: 200,
        maxUnits: 2,
        now: NOW,
      });

      expect(result.selected.map((u) => u.id).sort()).toEqual(['sel1', 'sel2']);
      expect(result.tail.map((u) => u.id).sort()).toEqual(['t1', 't2']);
      const verbatimTokens = estimateTokens(
        result.tail.map((u) => u.content.trim()).join('\n'),
      );
      expect(result.stats.tailSummaryTokens).toBeLessThanOrEqual(verbatimTokens);
      expect(result.tailSummary).toContain('alice owns rollout');
    });

    it('tail-cost guard: empty tail still yields an empty summary', () => {
      const result = CabarSelector.select(
        [{ id: 'only', content: fill('a', 40), score: 0.9 }],
        'q',
        { budgetTokens: 100, maxUnits: 8, now: NOW },
      );
      expect(result.tail).toEqual([]);
      expect(result.tailSummary).toBe('');
      expect(result.stats.tailSummaryTokens).toBe(0);
    });
  });

  describe('explicit-undefined option poisoning (NaN-budget hardening)', () => {
    it('still enforces budgetTokens when guaranteedTokens/maxUnits are explicitly undefined', () => {
      // A caller merging a partial options object can produce a key that IS
      // present with value `undefined` (e.g. `{ ...base, guaranteedTokens:
      // maybe }` where `maybe` is undefined) rather than simply omitting the
      // key. `{ ...DEFAULTS, ...opts }` then overrides DEFAULTS.guaranteedTokens
      // (0) with `undefined`, so `budgetTokens - guaranteedTokens` becomes NaN
      // and every `tokens + cost > budget` check evaluates to false — the
      // selector silently ignores its budget and selects everything.
      const units: CabarUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40), // cost = 10 tokens each
        score: 0.9 - i * 0.1,
      }));

      const result = CabarSelector.select(units, 'query', {
        budgetTokens: 25,
        guaranteedTokens: undefined,
        maxUnits: undefined,
        now: NOW,
      });

      expect(result.stats.selectedTokens).toBeLessThanOrEqual(25);
      expect(Number.isFinite(result.stats.utilizedTokens)).toBe(true);
    });

    it('does not select every candidate when guaranteedTokens alone is explicitly undefined', () => {
      // Isolates the mechanism: `budgetTokens - undefined = NaN`, and every
      // `tokens + cost > NaN` comparison is false, so a normal (defined)
      // maxUnits no longer bounds the selection either — all 5 units (cost 10
      // each = 50 tokens) get picked against a budgetTokens of 25.
      const units: CabarUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40), // cost = 10 tokens each
        score: 0.9 - i * 0.1,
      }));

      const result = CabarSelector.select(units, 'query', {
        budgetTokens: 25,
        guaranteedTokens: undefined,
        maxUnits: 8,
        now: NOW,
      });

      expect(result.stats.selectedTokens).toBeLessThanOrEqual(25);
    });
  });

  describe('best-single-vs-greedy swap', () => {
    it('replaces a low-value greedy pick with a single giant-utility unit', () => {
      // 4 near-duplicate low-utility "crumbs" (only the first contributes any
      // marginal utility — the rest are novelty-zeroed dupes) vs. one large,
      // highly relevant unit that doesn't fit the budget alongside the crumb.
      const crumbs: CabarUnit[] = [0, 1, 2, 3].map((i) => ({
        id: `crumb${i}`,
        content: fill('c', 40), // cost 10, identical content across all 4
        score: 0.5,
      }));
      const giant: CabarUnit = {
        id: 'giant',
        content: fill('g', 360), // cost 90
        score: 1.0,
      };

      const result = CabarSelector.select([...crumbs, giant], 'query', {
        budgetTokens: 95,
        maxUnits: 8,
        now: NOW,
      });

      expect(result.selected.map((u) => u.id)).toEqual(['giant']);
      expect(result.stats.selectedTokens).toBe(90);
    });
  });
});

describe('CabarSelector tokenCounter', () => {
  const words = { name: 'words', count: (t: string) => t.split(/\s+/).filter(Boolean).length };
  const units: CabarUnit[] = Array.from({ length: 10 }, (_, i) => ({
    id: `u${i}`,
    content: `unit ${i} talks about topic${i} with some filler words to give it length number ${i}.`,
    score: 1 - i * 0.05,
  }));

  it('costs units with the injected counter and respects the budget in its units', () => {
    const r = CabarSelector.select(units, 'topic', { tokenCounter: words, budgetTokens: 40, maxUnits: 10 });
    const used = r.selected.reduce((n, u) => n + words.count(u.content), 0);
    expect(r.stats.selectedTokens).toBe(used);
    expect(used).toBeLessThanOrEqual(40);
    expect(r.stats.tailSummaryTokens).toBe(words.count(r.tailSummary));
  });

  it('caps the tail with the injected counter', () => {
    const r = CabarSelector.select(units, 'topic', { tokenCounter: words, maxUnits: 1, tailBudgetTokens: 20 });
    expect(words.count(r.tailSummary)).toBeLessThanOrEqual(20);
  });
});
