/**
 * CabarSelector — Adaptive Stopping Rule Tests (CABAR-2 "Prism").
 *
 * The fixed budgetTokens=4000/maxUnits=8 caps are arbitrary — they don't know
 * whether the retrieved pool is big/noisy (many low-relevance candidates,
 * where aggressive compression helps accuracy by dropping distractors) or
 * small/concentrated (where compression should be a no-op). `adaptive: true`
 * replaces those caps with a stop rule driven ONLY by observable query-time
 * signals — the pool's own relevance-score shape (relFrac vs the top
 * candidate) and novelty vs what's already selected — never question type
 * (there is no type at inference).
 *
 * Every fixture uses disjoint-token content (see `fill`/`word`) so novelty is
 * pinned to 1 except where a test deliberately manufactures near-duplicates
 * (the REDUNDANCY suite), and omits `timestamp` so recency ρ≡1 for everyone —
 * isolating the stop rule to relFrac/novelty exactly as motivated. Candidates
 * are always constructed pre-sorted by score desc, matching the documented
 * "top = candidates[0].score" contract.
 */

import { describe, it, expect } from 'vitest';
import { CabarSelector, CabarUnit } from '../src/cabar';
import { estimateTokens } from '../src/shared';

const NOW = new Date('2026-07-15T00:00:00.000Z');

/** Disjoint-token filler so units never share a word — isolates novelty effects to tests that want them. */
function fill(letter: string, len: number): string {
  return letter.repeat(len);
}

describe('CabarSelector.select — adaptive stopping rule', () => {
  describe('NOISY pool (1 strong + many weak)', () => {
    it('adaptive keeps ~minKeep(3); fixed mode would keep 8 (maxUnits)', () => {
      const units: CabarUnit[] = [
        { id: 'top', content: fill('a', 40), score: 1.0 },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `weak${i}`,
          content: fill(String.fromCharCode(98 + i), 40), // 'b','c',... distinct tokens
          score: 0.1,
        })),
      ];

      const adaptiveResult = CabarSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(adaptiveResult.selected.length).toBe(3);
      expect(adaptiveResult.selected[0]!.id).toBe('top');

      const fixedResult = CabarSelector.select(units, 'query', { now: NOW });
      expect(fixedResult.selected.length).toBe(8); // default maxUnits
      expect(fixedResult.selected.length).toBeGreaterThan(adaptiveResult.selected.length);
    });
  });

  describe('CONCENTRATED pool (3 strong, cliff to noise)', () => {
    it('keeps exactly 3 — the 4th candidate falls below relFloor', () => {
      const units: CabarUnit[] = [
        { id: 's1', content: fill('a', 40), score: 1.0 },
        { id: 's2', content: fill('b', 40), score: 0.9 },
        { id: 's3', content: fill('c', 40), score: 0.85 },
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `noise${i}`,
          content: fill(String.fromCharCode(100 + i), 40),
          score: 0.1,
        })),
      ];

      const result = CabarSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(result.selected.map((u) => u.id)).toEqual(['s1', 's2', 's3']);
    });
  });

  describe('SPREAD pool (long relevant tail)', () => {
    it('keeps more units than the noisy case — self-scales with relevance shape', () => {
      const scores = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.2, 0.1, 0.05];
      const units: CabarUnit[] = scores.map((score, i) => ({
        id: `u${i}`,
        content: fill(String.fromCharCode(97 + i), 40),
        score,
      }));

      const result = CabarSelector.select(units, 'query', { adaptive: true, now: NOW });
      // Every unit with score >= relFloor(0.4) * top(1.0): 1.0..0.45 = 7 units.
      expect(result.selected.length).toBe(7);
      expect(result.selected.map((u) => u.id)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);

      const noisyUnits: CabarUnit[] = [
        { id: 'top', content: fill('z', 40), score: 1.0 },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `weak${i}`,
          content: fill(String.fromCharCode(121 - i), 40),
          score: 0.1,
        })),
      ];
      const noisyResult = CabarSelector.select(noisyUnits, 'query', { adaptive: true, now: NOW });
      expect(result.selected.length).toBeGreaterThan(noisyResult.selected.length);
    });
  });

  describe('REDUNDANCY (high-relevance near-duplicates)', () => {
    // Fixed 10-word base shared verbatim by every unit, plus one unique
    // trailing marker word: any pair shares 10 tokens out of an 11-token
    // union ⇒ Jaccard 10/12 ≈ 0.833 ⇒ novelty ≈ 0.167, just under
    // novFloor(0.2) — while every score stays well above relFloor, isolating
    // novFloor (not relFloor, not the pre-existing utility<=0 dedup that
    // fires only on EXACT duplicates) as the mechanism that stops the fill.
    const BASE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const units: CabarUnit[] = [1.0, 0.95, 0.9, 0.85, 0.8].map((score, i) => ({
      id: `d${i}`,
      content: `${BASE} marker${i}`,
      score,
    }));

    it('adaptive stops early via novFloor (keeps 3, not 5)', () => {
      const result = CabarSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(result.selected.length).toBe(3);
    });

    it('fixed mode (same pool, maxUnits=5) keeps all 5 — contrast proving novFloor is the adaptive-only mechanism', () => {
      const result = CabarSelector.select(units, 'query', { maxUnits: 5, budgetTokens: 1000, now: NOW });
      expect(result.selected.length).toBe(5);
    });
  });

  describe('minKeep floor', () => {
    it('is honored even when unit 2/3 fall below relFloor', () => {
      const units: CabarUnit[] = [
        { id: 'a', content: fill('a', 40), score: 1.0 },
        { id: 'b', content: fill('b', 40), score: 0.1 },
        { id: 'c', content: fill('c', 40), score: 0.05 },
      ];

      const result = CabarSelector.select(units, 'query', { adaptive: true, now: NOW });
      expect(result.selected.length).toBe(3);
      expect(result.selected.map((u) => u.id).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('maxCeilingTokens hard cap', () => {
    it('is never exceeded even when relFloor/novFloor would otherwise allow more', () => {
      const units: CabarUnit[] = Array.from({ length: 10 }, (_, i) => ({
        id: `u${i}`,
        content: fill(String.fromCharCode(97 + i), 40), // cost 10 tokens each
        score: 1.0 - i * 0.01, // all well above relFloor of each other
      }));

      const result = CabarSelector.select(units, 'query', {
        adaptive: true,
        maxCeilingTokens: 25,
        now: NOW,
      });

      expect(result.stats.selectedTokens).toBeLessThanOrEqual(25);
      expect(result.stats.budgetTokens).toBe(25);
      expect(result.selected.length).toBe(2); // 2 units of cost 10 fit in 25
    });
  });

  describe('capToMaxUnits — unifies cabar1 ceiling with adaptive early-stop', () => {
    // Concentrated/uniform pool: 10 units all near score 1.0, disjoint tokens
    // (novelty≡1) — nothing trips relFloor/novFloor, so UNCAPPED adaptive keeps
    // all 10. This is the regime where uncapped adaptive over-keeps.
    const uniform: CabarUnit[] = Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`,
      content: fill(String.fromCharCode(97 + i), 40), // 10 tokens each, disjoint
      score: 1.0 - i * 0.005, // all far above relFloor of the top
    }));

    it('cap binds on a concentrated pool: keeps exactly maxUnits, identical to cabar1', () => {
      const budget = { budgetTokens: 1000, maxUnits: 5, now: NOW };

      const uncapped = CabarSelector.select(uniform, 'query', {
        ...budget, adaptive: true, maxCeilingTokens: 1000,
      });
      expect(uncapped.selected.length).toBe(10); // over-keeps — no cliff to stop it

      const capped = CabarSelector.select(uniform, 'query', {
        ...budget, adaptive: true, capToMaxUnits: true, maxCeilingTokens: 1000,
      });
      const fixed = CabarSelector.select(uniform, 'query', budget); // cabar1

      expect(capped.selected.length).toBe(5); // cap binds
      // capped-adaptive ≡ cabar1 on a concentrated pool (same greedy picks)
      expect(capped.selected.map((u) => u.id)).toEqual(fixed.selected.map((u) => u.id));
    });

    it('early-stop still fires on a noisy pool: cap does NOT inflate to maxUnits', () => {
      const noisy: CabarUnit[] = [
        { id: 'top', content: fill('a', 40), score: 1.0 },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `weak${i}`,
          content: fill(String.fromCharCode(98 + i), 40),
          score: 0.1, // below relFloor
        })),
      ];
      const budget = { budgetTokens: 1000, maxUnits: 8, now: NOW };

      const uncapped = CabarSelector.select(noisy, 'query', { ...budget, adaptive: true, maxCeilingTokens: 1000 });
      const capped = CabarSelector.select(noisy, 'query', { ...budget, adaptive: true, capToMaxUnits: true, maxCeilingTokens: 1000 });

      // Both stop at minKeep(3) via relFloor — the cap (8) never engages.
      expect(uncapped.selected.length).toBe(3);
      expect(capped.selected.length).toBe(3);
      expect(capped.selected.map((u) => u.id)).toEqual(uncapped.selected.map((u) => u.id));
    });
  });

  describe('determinism', () => {
    it('produces deep-equal output for identical inputs (incl. now), run twice', () => {
      const units: CabarUnit[] = [
        { id: 'a', content: fill('a', 40), score: 1.0 },
        { id: 'b', content: fill('b', 40), score: 0.6 },
        { id: 'c', content: fill('c', 40), score: 0.3, timestamp: new Date('2026-06-01T00:00:00.000Z') },
      ];
      const opts = { adaptive: true, now: NOW };
      const r1 = CabarSelector.select(units, 'query', opts);
      const r2 = CabarSelector.select(units, 'query', opts);
      expect(r1).toEqual(r2);
    });
  });

  describe('adaptive=false byte-identical to current (fixed-budget) behavior', () => {
    it('passing adaptive:false plus unused adaptive-only opts changes nothing', () => {
      const units: CabarUnit[] = ['a', 'b', 'c', 'd', 'e'].map((l, i) => ({
        id: `u${i}`,
        content: fill(l, 40),
        score: 0.9 - i * 0.1,
      }));

      const plain = CabarSelector.select(units, 'query', { budgetTokens: 25, maxUnits: 8, now: NOW });
      const withUnusedAdaptiveOpts = CabarSelector.select(units, 'query', {
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
      expect(estimateTokens(fill('a', 40))).toBe(10); // sanity: fixture cost assumption
    });
  });
});
