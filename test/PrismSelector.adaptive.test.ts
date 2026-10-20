/**
 * PrismSelector — Adaptive Stopping Rule Tests (CABAR-2 "Prism").
 *
 * Mirrors CabarSelector.adaptive.test.ts's scenarios, applied to PrismSelector's
 * ADD-move admission gate: past `minKeep` distinct units, a unit is only newly
 * ADD-admitted if it clears both the relFrac and novelty floors. UPGRADE moves
 * and the mention-tail are never gated — only which NEW units get pulled in.
 *
 * Fixtures use single-word/disjoint-token, no-punctuation content (the same
 * `fill()` convention as PrismSelector.test.ts's CABAR-1-equivalence suite) so
 * EXTRACT/MENTION renderings collapse into (and are dropped by the cost-
 * dominance guard in favor of) verbatim — Prism reduces to CabarSelector's
 * binary knapsack shape, making the adaptive stop rule's effect on unit COUNT
 * directly comparable across the two selectors.
 */

import { describe, it, expect } from 'vitest';
import { PrismSelector, PrismUnit } from '../src/prism';

const NOW = new Date('2026-07-15T00:00:00.000Z');

/** Disjoint-token filler (single "sentence": no terminators) ⇒ verbatim-only menu. */
function fill(letter: string, len: number): string {
  return letter.repeat(len);
}

describe('PrismSelector.select — adaptive stopping rule', () => {
  describe('NOISY pool (1 strong + many weak)', () => {
    it('adaptive keeps ~minKeep(3); fixed mode would keep 12 (default maxUnits)', () => {
      const units: PrismUnit[] = [
        { id: 'top', content: fill('a', 40), score: 1.0 },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `weak${i}`,
          content: fill(String.fromCharCode(98 + i), 40),
          score: 0.1,
        })),
      ];

      const adaptiveResult = PrismSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(adaptiveResult.selected.length).toBe(3);
      expect(adaptiveResult.selected.some((s) => s.unit.id === 'top')).toBe(true);

      const fixedResult = PrismSelector.select(units, 'query', { now: NOW, budgetTokens: 1000 });
      expect(fixedResult.selected.length).toBe(12); // default maxUnits
      expect(fixedResult.selected.length).toBeGreaterThan(adaptiveResult.selected.length);
    });
  });

  describe('CONCENTRATED pool (3 strong, cliff to noise)', () => {
    it('keeps exactly 3 — the 4th candidate falls below relFloor', () => {
      const units: PrismUnit[] = [
        { id: 's1', content: fill('a', 40), score: 1.0 },
        { id: 's2', content: fill('b', 40), score: 0.9 },
        { id: 's3', content: fill('c', 40), score: 0.85 },
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `noise${i}`,
          content: fill(String.fromCharCode(100 + i), 40),
          score: 0.1,
        })),
      ];

      const result = PrismSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(result.selected.map((s) => s.unit.id).sort()).toEqual(['s1', 's2', 's3']);
    });
  });

  describe('SPREAD pool (long relevant tail)', () => {
    it('keeps more units than the noisy case — self-scales with relevance shape', () => {
      const scores = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.2, 0.1, 0.05];
      const units: PrismUnit[] = scores.map((score, i) => ({
        id: `u${i}`,
        content: fill(String.fromCharCode(97 + i), 40),
        score,
      }));

      const result = PrismSelector.select(units, 'query', { adaptive: true, now: NOW });
      // Every unit with score >= relFloor(0.4) * top(1.0): 1.0..0.45 = 7 units.
      expect(result.selected.length).toBe(7);

      const noisyUnits: PrismUnit[] = [
        { id: 'top', content: fill('z', 40), score: 1.0 },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `weak${i}`,
          content: fill(String.fromCharCode(121 - i), 40),
          score: 0.1,
        })),
      ];
      const noisyResult = PrismSelector.select(noisyUnits, 'query', { adaptive: true, now: NOW });
      expect(result.selected.length).toBeGreaterThan(noisyResult.selected.length);
    });
  });

  describe('REDUNDANCY (high-relevance near-duplicates)', () => {
    // Same construction as CabarSelector's redundancy fixture: a fixed
    // 10-word base shared verbatim + one unique trailing marker ⇒ Jaccard
    // 10/12 ≈ 0.833 ⇒ novelty ≈ 0.167, just under novFloor(0.2), with every
    // score well above relFloor — isolating novFloor as the stop mechanism.
    const BASE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const units: PrismUnit[] = [1.0, 0.95, 0.9, 0.85, 0.8].map((score, i) => ({
      id: `d${i}`,
      content: `${BASE} marker${i}`,
      score,
    }));

    it('adaptive stops early via novFloor (keeps 3, not 5)', () => {
      const result = PrismSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(result.selected.length).toBe(3);
    });

    it('fixed mode (same pool, maxUnits=5) keeps all 5 — contrast proving novFloor is the adaptive-only mechanism', () => {
      const result = PrismSelector.select(units, 'query', { maxUnits: 5, budgetTokens: 1000, now: NOW });
      expect(result.selected.length).toBe(5);
    });
  });

  describe('minKeep floor', () => {
    it('is honored even when unit 2/3 fall below relFloor', () => {
      const units: PrismUnit[] = [
        { id: 'a', content: fill('a', 40), score: 1.0 },
        { id: 'b', content: fill('b', 40), score: 0.1 },
        { id: 'c', content: fill('c', 40), score: 0.05 },
      ];

      const result = PrismSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(result.selected.length).toBe(3);
      expect(result.selected.map((s) => s.unit.id).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('maxCeilingTokens hard cap', () => {
    it('is never exceeded even when relFloor/novFloor would otherwise allow more', () => {
      const units: PrismUnit[] = Array.from({ length: 10 }, (_, i) => ({
        id: `u${i}`,
        content: fill(String.fromCharCode(97 + i), 40), // verbatim cost 10 tokens each
        score: 1.0 - i * 0.01,
      }));

      const result = PrismSelector.select(units, 'query', {
        adaptive: true,
        maxCeilingTokens: 25,
        now: NOW,
      });

      expect(result.stats.selectedTokens).toBeLessThanOrEqual(25);
      expect(result.stats.budgetTokens).toBe(25);
      expect(result.selected.length).toBe(2); // 2 units of cost 10 fit in 25
    });
  });

  describe('determinism', () => {
    it('produces deep-equal output for identical inputs (incl. now), run twice', () => {
      const units: PrismUnit[] = [
        { id: 'a', content: fill('a', 40), score: 1.0 },
        { id: 'b', content: fill('b', 40), score: 0.6 },
        { id: 'c', content: fill('c', 40), score: 0.3, timestamp: new Date('2026-06-01T00:00:00.000Z') },
      ];
      const opts = { adaptive: true, now: NOW };
      const r1 = PrismSelector.select(units, 'query', opts);
      const r2 = PrismSelector.select(units, 'query', opts);
      expect(r1).toEqual(r2);
    });
  });

  describe('adaptive=false byte-identical to current (fixed-budget) behavior', () => {
    it('passing adaptive:false plus unused adaptive-only opts changes nothing', () => {
      const units: PrismUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40),
        score: 0.9 - i * 0.1,
      }));

      const plain = PrismSelector.select(units, 'query', { budgetTokens: 25, maxUnits: 8, now: NOW });
      const withUnusedAdaptiveOpts = PrismSelector.select(units, 'query', {
        budgetTokens: 25,
        maxUnits: 8,
        adaptive: false,
        minKeep: 1,
        relFloor: 0.99,
        novFloor: 0.99,
        maxCeilingTokens: 5,
        now: NOW,
      });

      expect(withUnusedAdaptiveOpts).toEqual(plain);
    });
  });

  describe('UPGRADE moves are never gated by the adaptive floors', () => {
    it('a single already-ADD-admitted unit can still upgrade fidelity toward verbatim as budget loosens', () => {
      // Multi-sentence content ⇒ a real claims/extract/mention ladder exists,
      // so an UPGRADE move (not just ADD) is exercised. Single unit ⇒ trivially
      // past minKeep semantics don't matter (only ever 1 unit to admit).
      const u: PrismUnit = {
        id: 'U',
        content:
          'The quarterly revenue rose twelve percent this year after the board formally approved the ' +
          'expanded annual operating budget for the marketing and engineering teams across every region',
        score: 0.9,
        claims: ['revenue up twelve percent'],
      };
      const tight = PrismSelector.select([u], 'revenue budget', { adaptive: true, maxCeilingTokens: 10, now: NOW });
      const loose = PrismSelector.select([u], 'revenue budget', { adaptive: true, maxCeilingTokens: 4000, now: NOW });

      expect(tight.selected).toHaveLength(1);
      expect(loose.selected).toHaveLength(1);
      const rankOf = { mention: 0, claims: 1, extract: 2, verbatim: 3 } as const;
      expect(rankOf[loose.selected[0]!.fidelity]).toBeGreaterThanOrEqual(rankOf[tight.selected[0]!.fidelity]);
      expect(loose.selected[0]!.fidelity).toBe('verbatim');
    });
  });
});
