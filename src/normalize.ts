/**
 * Score normalization. The selectors expect relevance in [0, 1] with the top
 * candidate at (or near) 1.0: `tauFloor` and the adaptive relevance cliff are
 * fractions of that scale. Raw retriever scores rarely are: cosine
 * similarities bunch up in 0.7–0.85, BM25 and reranker logits are unbounded,
 * and vector-store distances run the wrong way.
 */

export interface NormalizeOptions {
  /**
   * - `minmax` (default): best → 1, worst → 0. Spreads bunched-up scores
   *   (cosine similarities) across the full range.
   * - `max`: divide by the best score. Keeps ratios between scores; only for
   *   non-negative scores.
   */
  method?: 'minmax' | 'max';
  /** Set to false for distances (lower = more relevant). Default true. */
  higherIsBetter?: boolean;
}

/** Returns copies of the units with `score` mapped to [0, 1]. Input order is kept. */
export function normalizeScores<T extends { score: number }>(units: T[], opts: NormalizeOptions = {}): T[] {
  if (units.length === 0) return [];
  const method = opts.method ?? 'minmax';
  const raw = units.map((u) => (opts.higherIsBetter === false ? -u.score : u.score));
  for (const s of raw) {
    if (!Number.isFinite(s)) throw new RangeError('normalizeScores: every score must be a finite number');
  }
  const hi = Math.max(...raw);
  const lo = Math.min(...raw);

  let map: (s: number) => number;
  if (method === 'max') {
    if (lo < 0) throw new RangeError("normalizeScores: method 'max' needs non-negative scores, use 'minmax'");
    map = (s) => (hi === 0 ? 1 : s / hi);
  } else {
    map = (s) => (hi === lo ? 1 : (s - lo) / (hi - lo));
  }
  return units.map((u, i) => ({ ...u, score: map(raw[i]!) }));
}
