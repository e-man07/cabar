import { describe, it, expect } from 'vitest';
import { normalizeScores } from '../src/normalize';

const u = (score: number, id = String(score)) => ({ id, content: id, score });

describe('normalizeScores', () => {
  it('minmax spreads bunched cosine scores to [0, 1]', () => {
    const out = normalizeScores([u(0.83), u(0.77), u(0.71)]);
    expect(out[0]!.score).toBe(1);
    expect(out[1]!.score).toBeCloseTo(0.5, 10);
    expect(out[2]!.score).toBe(0);
  });

  it('max keeps ratios', () => {
    expect(normalizeScores([u(8), u(4), u(2)], { method: 'max' }).map((x) => x.score)).toEqual([1, 0.5, 0.25]);
  });

  it('flips distances when higherIsBetter is false', () => {
    const out = normalizeScores([u(0.1, 'near'), u(0.9, 'far')], { higherIsBetter: false });
    expect(out.find((x) => x.id === 'near')!.score).toBe(1);
    expect(out.find((x) => x.id === 'far')!.score).toBe(0);
  });

  it('all-equal pools map to 1, empty stays empty, input is not mutated', () => {
    const input = [u(3), u(3)];
    expect(normalizeScores(input).map((x) => x.score)).toEqual([1, 1]);
    expect(input[0]!.score).toBe(3);
    expect(normalizeScores([])).toEqual([]);
  });

  it('rejects non-finite scores and negative scores with max', () => {
    expect(() => normalizeScores([u(NaN)])).toThrow(RangeError);
    expect(() => normalizeScores([u(-1), u(2)], { method: 'max' })).toThrow(RangeError);
  });
});
