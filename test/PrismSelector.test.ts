/**
 * PrismSelector — Unit Tests (CABAR-2 multi-fidelity).
 *
 * Pure-function tests: no DB, no LLM, no wall-clock reads (every test passes an
 * explicit `now`). Covers determinism, budget/maxUnits/guaranteed invariants,
 * the fidelity-upgrade ladder, the cost-dominance guard, CABAR-1 equivalence
 * (verbatim-only ⇒ same id SET), the answer-lossless mention floor,
 * β-hysteresis, cache-stable output ordering, and the MCKP-≥-binary dominance
 * that motivates the whole extension.
 */

import { describe, it, expect } from 'vitest';
import {
  PrismSelector,
  PrismUnit,
  Fidelity,
  FidelityFactors,
} from '../src/prism';
import { CabarSelector, CabarUnit } from '../src/cabar';
import { verbatim, claimsRendering, mention } from '../src/renderings';
import { estimateTokens } from '../src/shared';

const NOW = new Date('2026-07-11T00:00:00.000Z');
const counter = { name: 'char4', count: estimateTokens };

/** Default φ, mirrored here for utility bookkeeping in the dominance/MCKP tests. */
const PHI: FidelityFactors = { verbatim: 1.0, extract: 0.85, claims: 0.75, mention: 0.3 };

/** Disjoint-token filler (single "sentence": no terminators) ⇒ verbatim-only menu. */
function fill(letter: string, len: number): string {
  return letter.repeat(len);
}

describe('PrismSelector.select', () => {
  describe('determinism', () => {
    it('returns deep-equal output for identical inputs (incl. now), run twice', () => {
      const units: PrismUnit[] = [
        { id: 'a', content: 'The rollout ships Monday. Alice owns it.', score: 0.9, claims: ['rollout Monday'] },
        { id: 'b', content: 'Budget approved by the board last week.', score: 0.7 },
        { id: 'c', content: fill('c', 60), score: 0.5, timestamp: new Date('2026-06-01T00:00:00.000Z') },
      ];
      const opts = { budgetTokens: 40, maxUnits: 3, now: NOW };
      const r1 = PrismSelector.select(units, 'rollout owner budget', opts);
      const r2 = PrismSelector.select(units, 'rollout owner budget', opts);
      expect(r1).toEqual(r2);
    });
  });

  describe('budget, maxUnits, guaranteedTokens', () => {
    it('never lets selected + guaranteed exceed budgetTokens', () => {
      const units: PrismUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40), // verbatim cost = 10, mention/extract dominated ⇒ verbatim-only
        score: 0.9 - i * 0.1,
      }));

      const result = PrismSelector.select(units, 'query', {
        budgetTokens: 25,
        guaranteedTokens: 5,
        maxUnits: 8,
        now: NOW,
      });

      expect(result.stats.selectedTokens + 5).toBeLessThanOrEqual(25);
      expect(result.selected.length).toBe(2); // remaining budget 20 → exactly 2 units of cost 10
      expect(result.stats.utilizedTokens).toBe(5 + result.stats.selectedTokens + result.stats.tailTokens);
    });

    it('caps DISTINCT units at maxUnits even when the budget allows more', () => {
      const units: PrismUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40),
        score: 0.9 - i * 0.1,
      }));
      const result = PrismSelector.select(units, 'query', { budgetTokens: 1000, maxUnits: 2, now: NOW });
      expect(result.selected.length).toBe(2);
    });

    describe('explicit-undefined option poisoning (NaN-budget hardening)', () => {
      it('still enforces budgetTokens when guaranteedTokens/maxUnits are explicitly undefined', () => {
        // Same hazard as CabarSelector: `{ ...DEFAULTS, ...opts }` lets an
        // explicit `guaranteedTokens: undefined` key override
        // DEFAULTS.guaranteedTokens (0) with `undefined`, turning
        // `budgetTokens - guaranteedTokens` into NaN and disabling every
        // `selectedTokens + deltaC > budget` feasibility check.
        const units: PrismUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
          id: `u${i}`,
          content: fill(l, 40), // verbatim cost = 10, mention/extract dominated ⇒ verbatim-only
          score: 0.9 - i * 0.1,
        }));

        const result = PrismSelector.select(units, 'query', {
          budgetTokens: 25,
          guaranteedTokens: undefined,
          maxUnits: undefined,
          now: NOW,
        });

        expect(result.stats.selectedTokens).toBeLessThanOrEqual(25);
        expect(Number.isFinite(result.stats.utilizedTokens)).toBe(true);
      });

      it('does not select every candidate when guaranteedTokens alone is explicitly undefined', () => {
        const units: PrismUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
          id: `u${i}`,
          content: fill(l, 40),
          score: 0.9 - i * 0.1,
        }));

        const result = PrismSelector.select(units, 'query', {
          budgetTokens: 25,
          guaranteedTokens: undefined,
          maxUnits: 8,
          now: NOW,
        });

        expect(result.stats.selectedTokens).toBeLessThanOrEqual(25);
      });
    });
  });

  describe('fidelity upgrade ladder', () => {
    // Single-sentence content (no internal terminators) ⇒ the extract collapses
    // to verbatim and is dropped by the dominance guard, leaving a clean
    // claims < mention < verbatim ladder to exercise the upgrade path.
    const u: PrismUnit = {
      id: 'U',
      content:
        'The quarterly revenue rose twelve percent this year after the board formally approved the ' +
        'expanded annual operating budget for the marketing and engineering teams across every region',
      score: 0.9,
      claims: ['revenue up twelve percent'],
    };
    const cClaims = counter.count(claimsRendering(u)!);
    const cMention = counter.count(mention(u, counter));
    const cVerbatim = counter.count(verbatim(u));

    it('has a strictly increasing cost ladder (claims < mention < verbatim)', () => {
      expect(cClaims).toBeLessThan(cMention);
      expect(cMention).toBeLessThan(cVerbatim);
    });

    it('picks a cheap fidelity under a tight budget and upgrades toward verbatim as budget loosens', () => {
      const rankOf: Record<Fidelity, number> = { mention: 0, claims: 1, extract: 2, verbatim: 3 };
      const budgets = [cClaims, cMention, cVerbatim];
      const results = budgets.map((b) => PrismSelector.select([u], 'revenue budget', { budgetTokens: b, now: NOW }));

      // Same unit at every budget; fidelity rank + spend are monotonically non-decreasing.
      for (const r of results) {
        expect(r.selected).toHaveLength(1);
        expect(r.selected[0]!.unit.id).toBe('U');
      }
      const ranks = results.map((r) => rankOf[r.selected[0]!.fidelity]);
      const spends = results.map((r) => r.stats.selectedTokens);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
        expect(spends[i]!).toBeGreaterThanOrEqual(spends[i - 1]!);
      }
      // Tight budget => a compressed rendering (claims); loosest => full verbatim.
      expect(results[0]!.selected[0]!.fidelity).toBe('claims');
      expect(results[results.length - 1]!.selected[0]!.fidelity).toBe('verbatim');
    });
  });

  describe('cost-dominance guard', () => {
    it('never offers a claims rendering that costs >= verbatim, even with an inflated φ', () => {
      const u: PrismUnit = {
        id: 'D',
        content: 'Alpha beta gamma delta. Epsilon zeta eta theta.',
        score: 0.9,
        // A single claim far longer than the whole memory ⇒ claims cost >= verbatim ⇒ dropped.
        claims: [
          'this one claim string is deliberately far longer than the entire memory content above it and keeps going and going',
        ],
      };
      const cVerbatim = counter.count(verbatim(u));
      const cClaims = counter.count(claimsRendering(u)!);
      expect(cClaims).toBeGreaterThanOrEqual(cVerbatim); // precondition: claims dominates

      const result = PrismSelector.select([u], 'query', {
        budgetTokens: cClaims + 50, // budget would happily fit the claims rendering if it were offered
        now: NOW,
        fidelityFactors: { claims: 100 }, // and φ would make it irresistible — the guard must still win
      });

      expect(result.stats.fidelityHistogram.claims).toBe(0);
      expect(result.selected).toHaveLength(1);
      expect(['verbatim', 'extract']).toContain(result.selected[0]!.fidelity);
    });
  });

  describe('CABAR-1 equivalence (verbatim-only ⇒ same id SET)', () => {
    // Fill units ⇒ extract collapses to verbatim (dominated) and mention is
    // costlier than verbatim (dominated) ⇒ the only surviving fidelity is
    // verbatim, so Prism reduces to CabarSelector's binary knapsack.
    const pools: PrismUnit[][] = [
      // Pool 1 — plain disjoint units, varied scores.
      ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({ id: `p1_${i}`, content: fill(l, 40), score: 0.9 - i * 0.1 })),
      // Pool 2 — a near-duplicate pair (novelty dedup) plus two singletons.
      [
        { id: 'dup1', content: fill('x', 40), score: 0.9 },
        { id: 'dup2', content: fill('x', 40), score: 0.88 },
        { id: 'solo1', content: fill('y', 40), score: 0.7 },
        { id: 'solo2', content: fill('z', 40), score: 0.6 },
      ],
      // Pool 3 — timestamps + active recency.
      [
        { id: 't_old', content: fill('o', 40), score: 0.8, timestamp: new Date('2024-01-01T00:00:00.000Z') },
        { id: 't_mid', content: fill('m', 40), score: 0.8, timestamp: new Date('2026-01-01T00:00:00.000Z') },
        { id: 't_new', content: fill('n', 40), score: 0.8, timestamp: NOW },
      ],
    ];

    it('selects the same id set as CabarSelector on 3 synthetic pools', () => {
      pools.forEach((pool, idx) => {
        const opts = { budgetTokens: 35, maxUnits: 8, recencyLambda: idx === 2 ? 0.3 : 0.3, now: NOW };
        const cabar = CabarSelector.select(pool as CabarUnit[], 'query', opts);
        const prism = PrismSelector.select(pool, 'query', { ...opts, fidelityFactors: { verbatim: 1 } });

        const cabarIds = cabar.selected.map((u) => u.id).sort();
        const prismIds = prism.selected.map((s) => s.unit.id).sort();
        expect(prismIds).toEqual(cabarIds);
      });
    });
  });

  describe('answer-lossless mention floor', () => {
    it('every unit >= tauFloor is either selected or present as a tail mention line', () => {
      // Longer content ⇒ verbatim tail block would cost more than mention lines,
      // so the tail-cost guard keeps the (cheaper) mention lines with [id@..] tags.
      const long = (tag: string) =>
        `${tag} sentence one has several words here. ${tag} sentence two also has several words here.`;
      const units: PrismUnit[] = [
        { id: 'keep1', content: long('KEEP1'), score: 0.95 },
        { id: 'keep2', content: long('KEEP2'), score: 0.9 },
        { id: 'floor1', content: long('FLOOR1'), score: 0.5 },
        { id: 'floor2', content: long('FLOOR2'), score: 0.3 },
        { id: 'floor3', content: long('FLOOR3'), score: 0.2 },
        { id: 'dropped', content: long('DROPPED'), score: 0.1 }, // below default tauFloor 0.15
      ];

      const result = PrismSelector.select(units, 'sentence words', {
        budgetTokens: counter.count(verbatim(units[0]!)) + counter.count(verbatim(units[1]!)) + 4,
        maxUnits: 8,
        tailBudgetTokens: 2000,
        now: NOW,
      });

      const selectedIds = new Set(result.selected.map((s) => s.unit.id));
      for (const u of units) {
        if (u.score < 0.15) continue; // dropped units get no floor
        const covered = selectedIds.has(u.id) || result.tailBlock.includes(`[${u.id}`);
        expect(covered).toBe(true);
      }
      // The sub-floor unit is nowhere — neither selected nor floored.
      expect(selectedIds.has('dropped')).toBe(false);
      expect(result.tailBlock).not.toContain('[dropped');
      // Tail stayed within its hard cap.
      expect(result.stats.tailTokens).toBeLessThanOrEqual(2000);
    });
  });

  describe('β-hysteresis', () => {
    // Two tied units (identical score/cost, disjoint tokens, verbatim-only).
    const A: PrismUnit = { id: 'A', content: fill('a', 40), score: 0.8 };
    const B: PrismUnit = { id: 'B', content: fill('b', 40), score: 0.8 };
    const base = { budgetTokens: 10, maxUnits: 1, now: NOW }; // room for exactly one unit

    it('β=0 breaks the tie by input order (A), and prevSelected is a no-op', () => {
      const noBonus = PrismSelector.select([A, B], 'q', base);
      expect(noBonus.selected.map((s) => s.unit.id)).toEqual(['A']);

      const zeroBetaWithPrev = PrismSelector.select([A, B], 'q', {
        ...base,
        hysteresisBonus: 0,
        prevSelected: [{ unitId: 'B', fidelity: 'verbatim' }],
      });
      expect(zeroBetaWithPrev.selected.map((s) => s.unit.id)).toEqual(['A']);
    });

    it('β>0 with prevSelected flips the otherwise-tied choice to the remembered unit', () => {
      const flipped = PrismSelector.select([A, B], 'q', {
        ...base,
        hysteresisBonus: 0.5,
        prevSelected: [{ unitId: 'B', fidelity: 'verbatim' }],
      });
      expect(flipped.selected.map((s) => s.unit.id)).toEqual(['B']);

      // β>0 but no prevSelected ⇒ nothing to reinforce ⇒ back to input-order A.
      const noPrev = PrismSelector.select([A, B], 'q', { ...base, hysteresisBonus: 0.5 });
      expect(noPrev.selected.map((s) => s.unit.id)).toEqual(['A']);
    });
  });

  describe('cache-stable output ordering', () => {
    it('orders selected units by (timestamp asc, id asc) independent of score permutation', () => {
      const ts = {
        u0: new Date('2026-03-01T00:00:00.000Z'),
        u1: new Date('2026-01-01T00:00:00.000Z'),
        u2: new Date('2026-04-01T00:00:00.000Z'),
        u3: new Date('2026-02-01T00:00:00.000Z'),
      };
      const mk = (scores: number[]): PrismUnit[] => [
        { id: 'u0', content: fill('a', 40), score: scores[0]!, timestamp: ts.u0 },
        { id: 'u1', content: fill('b', 40), score: scores[1]!, timestamp: ts.u1 },
        { id: 'u2', content: fill('c', 40), score: scores[2]!, timestamp: ts.u2 },
        { id: 'u3', content: fill('d', 40), score: scores[3]!, timestamp: ts.u3 },
      ];
      const opts = { budgetTokens: 1000, maxUnits: 8, now: NOW };

      const r1 = PrismSelector.select(mk([0.9, 0.8, 0.7, 0.6]), 'q', opts);
      const r2 = PrismSelector.select(mk([0.6, 0.7, 0.8, 0.9]), 'q', opts); // scores permuted

      const expected = ['u1', 'u3', 'u0', 'u2']; // timestamp ascending
      expect(r1.selected.map((s) => s.unit.id)).toEqual(expected);
      expect(r2.selected.map((s) => s.unit.id)).toEqual(expected);
    });
  });

  describe('MCKP >= binary (multi-fidelity dominates all-or-nothing under tight budgets)', () => {
    // Disjoint-token, multi-sentence units, no query overlap ⇒ novelty ≡ 1 and
    // ρ ≡ 1, so utility reduces to score×φ. Extracts cost ~40% of verbatim, so
    // Prism packs several extracts where Cabar affords one verbatim.
    function richUnit(i: number): PrismUnit {
      const tag = String.fromCharCode(97 + i).repeat(3); // 'aaa','bbb',...
      const content = [1, 2, 3, 4, 5].map((n) => `${tag}${n} ${tag}word${n} ${tag}extra${n}.`).join(' ');
      return { id: `r${i}`, content, score: 0.9 - i * 0.02 };
    }
    const pool: PrismUnit[] = Array.from({ length: 8 }, (_, i) => richUnit(i));

    const captured = (fidelityById: Array<{ score: number; fidelity: Fidelity }>): number =>
      fidelityById.reduce((sum, x) => sum + x.score * PHI[x.fidelity], 0);

    it('captures at least as much (here strictly more) utility than CabarSelector under a tight budget', () => {
      const opts = { budgetTokens: 40, maxUnits: 12, now: NOW };
      const cabar = CabarSelector.select(pool as CabarUnit[], '', opts);
      const prism = PrismSelector.select(pool, '', opts);

      const cabarUtility = captured(cabar.selected.map((u) => ({ score: u.score, fidelity: 'verbatim' as Fidelity })));
      const prismUtility = captured(prism.selected.map((s) => ({ score: s.unit.score, fidelity: s.fidelity })));

      expect(prismUtility).toBeGreaterThanOrEqual(cabarUtility);
      expect(prismUtility).toBeGreaterThan(cabarUtility); // strict win: cheaper fidelities pack more units
      expect(prism.selected.length).toBeGreaterThan(cabar.selected.length);
    });
  });
});
