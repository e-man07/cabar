/**
 * Property tests: the guarantees the README makes, checked on 500 random pools each.
 */
import { describe, it, expect } from 'vitest';
import { CabarSelector, CabarUnit } from '../src/cabar';
import { PrismSelector } from '../src/prism';
import { estimateTokens } from '../src/shared';
import { jaccard, tokenize } from '../src/renderings';

// Small deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ('deploy modal gpu kernel cache weights container latency budget token memory agent claim user prefers ' +
  'typescript python vercel snapshot cold start warm upgrade decision pricing replicate dashboard summary weekly ' +
  'session timezone delhi meeting async invoice client refund policy schema prompt model release rollback').split(' ');

function sentence(r: () => number): string {
  const n = 6 + Math.floor(r() * 14);
  const w = Array.from({ length: n }, () => VOCAB[Math.floor(r() * VOCAB.length)]);
  return w.join(' ') + '.';
}

function pool(seed: number): { units: CabarUnit[]; query: string; now: Date } {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 40);
  const now = new Date('2026-10-20T00:00:00Z');
  const units: CabarUnit[] = [];
  for (let i = 0; i < n; i++) {
    // ~25% near-duplicates of an earlier unit
    const dupOf = i > 0 && r() < 0.25 ? units[Math.floor(r() * i)] : null;
    const content = dupOf
      ? dupOf.content
      : Array.from({ length: 1 + Math.floor(r() * 5) }, () => sentence(r)).join(' ');
    units.push({
      id: `u${i}`,
      content,
      score: Math.round(r() * 1000) / 1000,
      timestamp: r() < 0.8 ? new Date(now.getTime() - Math.floor(r() * 400) * 86_400_000) : undefined,
    });
  }
  return { units, query: sentence(r), now };
}

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);

describe('CabarSelector properties (500 random pools)', () => {
  it('never exceeds the budget, maxUnits or the tail cap', () => {
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const budgetTokens = 50 + (seed % 7) * 150;
      const maxUnits = 1 + (seed % 10);
      const guaranteedTokens = seed % 3 === 0 ? 40 : 0;
      const r = CabarSelector.select(units, query, { now, budgetTokens, maxUnits, guaranteedTokens });
      const sel = r.selected.reduce((n, u) => n + estimateTokens(u.content), 0);
      expect(sel).toBe(r.stats.selectedTokens);
      expect(sel + guaranteedTokens).toBeLessThanOrEqual(Math.max(budgetTokens, guaranteedTokens));
      expect(r.selected.length).toBeLessThanOrEqual(maxUnits);
      expect(r.stats.tailSummaryTokens).toBeLessThanOrEqual(600);
    }
  });

  it('is deterministic: same input, identical output', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const { units, query, now } = pool(seed);
      const a = CabarSelector.select(units, query, { now, adaptive: true, capToMaxUnits: true });
      const b = CabarSelector.select(units, query, { now, adaptive: true, capToMaxUnits: true });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('never silently drops a unit at or above tauFloor: it is selected or in the tail', () => {
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const r = CabarSelector.select(units, query, { now, budgetTokens: 300, maxUnits: 4 });
      const kept = new Set([...r.selected, ...r.tail].map((u) => u.id));
      for (const u of units) if (u.score >= 0.15) expect(kept.has(u.id)).toBe(true);
      for (const u of r.tail) expect(u.score).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('never selects an exact duplicate of an already-selected unit (novelty = 0)', () => {
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const r = CabarSelector.select(units, query, { now, budgetTokens: 4000, maxUnits: 40 });
      const contents = r.selected.map((u) => u.content);
      expect(new Set(contents).size).toBe(contents.length);
    }
  });

  it('capped-adaptive never keeps more than maxUnits and never more than uncapped adaptive', () => {
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const capped = CabarSelector.select(units, query, { now, adaptive: true, capToMaxUnits: true, maxUnits: 8 });
      const uncapped = CabarSelector.select(units, query, { now, adaptive: true });
      expect(capped.selected.length).toBeLessThanOrEqual(8);
      expect(capped.selected.length).toBeLessThanOrEqual(uncapped.selected.length);
      expect(capped.stats.selectedTokens).toBeLessThanOrEqual(4000);
    }
  });

  it('adaptive stops early on a noisy pool (one strong hit, many weak ones)', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const units: CabarUnit[] = [{ id: 'hit', content: 'The deploy target for gpu workers is modal with an L40S.', score: 1 }];
    for (let i = 0; i < 30; i++) units.push({ id: `n${i}`, content: `${sentence(rng(i + 99))}`, score: 0.2 + (i % 5) * 0.03 });
    const fixed = CabarSelector.select(units, 'where do gpu workers deploy', { now });
    const adaptive = CabarSelector.select(units, 'where do gpu workers deploy', { now, adaptive: true, capToMaxUnits: true });
    expect(fixed.selected.length).toBe(8);
    expect(adaptive.selected.length).toBe(3); // minKeep, then the relevance cliff stops it
    expect(adaptive.selected.map((u) => u.id)).toContain('hit');
  });
});

describe('PrismSelector properties (500 random pools)', () => {
  it('never exceeds the budget or maxUnits; output is in (timestamp, id) order', () => {
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const budgetTokens = 50 + (seed % 7) * 150;
      const maxUnits = 1 + (seed % 12);
      const r = PrismSelector.select(units, query, { now, budgetTokens, maxUnits });
      const sel = r.selected.reduce((n, s) => n + estimateTokens(s.rendered), 0);
      expect(sel).toBe(r.stats.selectedTokens);
      expect(sel).toBeLessThanOrEqual(budgetTokens);
      expect(r.selected.length).toBeLessThanOrEqual(maxUnits);
      expect(r.stats.tailTokens).toBeLessThanOrEqual(600);
      const key = (s: (typeof r.selected)[number]) => s.unit.timestamp?.getTime() ?? 0;
      for (let i = 1; i < r.selected.length; i++) {
        const a = r.selected[i - 1]!, b = r.selected[i]!;
        expect(key(a) < key(b) || (key(a) === key(b) && a.unit.id.localeCompare(b.unit.id) < 0)).toBe(true);
      }
    }
  });

  it('a non-verbatim rendering is always cheaper than the verbatim chunk', () => {
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const r = PrismSelector.select(units, query, { now, budgetTokens: 200 });
      for (const s of r.selected) {
        if (s.fidelity !== 'verbatim') expect(s.tokens).toBeLessThan(estimateTokens(s.unit.content));
      }
    }
  });

  it('under tight budgets, Prism covers at least as many relevant units as all-or-nothing CABAR', () => {
    let prismWins = 0, cabarWins = 0;
    for (const seed of SEEDS) {
      const { units, query, now } = pool(seed);
      const opts = { now, budgetTokens: 120, maxUnits: 12, noveltyWeight: 0 };
      const c = CabarSelector.select(units, query, opts).selected.length;
      const p = PrismSelector.select(units, query, opts).selected.length;
      if (p > c) prismWins++;
      if (c > p) cabarWins++;
    }
    expect(prismWins).toBeGreaterThan(cabarWins);
  });
});

describe('novelty helper', () => {
  it('jaccard over 3+ char word sets', () => {
    expect(jaccard(tokenize('the gpu cache'), tokenize('the gpu cache'))).toBe(1);
    expect(jaccard(tokenize('gpu cache'), tokenize('modal pricing'))).toBe(0);
    expect(jaccard(tokenize('a b c'), tokenize('gpu'))).toBe(0); // short words are ignored
  });
});
