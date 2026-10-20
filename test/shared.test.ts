import { describe, it, expect } from 'vitest';
import { estimateTokens, recencyDecay, DEFAULT_RECENCY_DECAY_DAYS } from '../src/shared';
import { CabarSelector } from '../src/cabar';

describe('shared helpers', () => {
  it('estimateTokens is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('recencyDecay is e^(-age/days), 1 at age 0', () => {
    expect(recencyDecay(0)).toBe(1);
    expect(recencyDecay(DEFAULT_RECENCY_DECAY_DAYS)).toBeCloseTo(Math.exp(-1), 10);
    expect(recencyDecay(30, 30)).toBeCloseTo(Math.exp(-1), 10);
    expect(() => recencyDecay(-1)).toThrow(RangeError);
    expect(() => recencyDecay(1, 0)).toThrow(RangeError);
  });

  it('recencyDecayDays: a shorter scale favors the newer of two equal units', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const units = [
      { id: 'old', content: 'deploy target is fly.io for the api service', score: 1, timestamp: new Date('2026-04-01T00:00:00Z') },
      { id: 'new', content: 'deploy target moved to modal for gpu workers', score: 1, timestamp: new Date('2026-09-30T00:00:00Z') },
    ];
    const r = CabarSelector.select(units, 'where do we deploy', { now, maxUnits: 1, recencyLambda: 1, recencyDecayDays: 30 });
    expect(r.selected.map((u) => u.id)).toEqual(['new']);
  });
});
