/**
 * Small shared helpers: the default token estimator and the recency decay curve.
 */

/**
 * Token-count heuristic: ~4 characters per token.
 *
 * Not a real tokenizer. Deliberately cheap and provider-agnostic (no
 * dependency on any one model's BPE vocabulary): good enough for budget
 * heuristics, not for exact billing. Pass your own `TokenCounter` to either
 * selector when you need exact counts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A pluggable token counter. Defaults to the char/4 estimator; inject a real
 * BPE tokenizer (e.g. `gpt-tokenizer`, tiktoken) for exact costs.
 */
export interface TokenCounter {
  name: string;
  count(text: string): number;
}

/** Provider-agnostic default counter: the char/4 heuristic. */
export const CHAR4_COUNTER: TokenCounter = { name: 'char4', count: estimateTokens };

/**
 * Similarity between two units in [0, 1], used for the novelty term in place
 * of the built-in word-set Jaccard. 1 = same content, 0 = unrelated.
 */
export type Similarity<T> = (a: T, b: T) => number;

/** Cosine similarity of two equal-length vectors, clamped to [0, 1]. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError('cosineSimilarity: vectors must have the same length');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(na * nb)));
}

/**
 * Ready-made `similarity` option: cosine over each unit's `embedding`.
 * Catches paraphrases that word overlap misses. Throws if a unit has no embedding.
 */
export function embeddingSimilarity<T extends { id: string; embedding?: ArrayLike<number> }>(a: T, b: T): number {
  if (!a.embedding || !b.embedding) throw new Error(`embeddingSimilarity: unit ${!a.embedding ? a.id : b.id} has no embedding`);
  return cosineSimilarity(a.embedding, b.embedding);
}

/** Default recency scale in days: score = e^(-age / 365). */
export const DEFAULT_RECENCY_DECAY_DAYS = 365;

/**
 * Exponential recency decay in [0, 1]: 1 = brand new, → 0 as the unit ages.
 * score = e^(-ageInDays / decayDays)
 */
export function recencyDecay(ageInDays: number, decayDays: number = DEFAULT_RECENCY_DECAY_DAYS): number {
  if (ageInDays < 0) throw new RangeError('ageInDays must be >= 0');
  if (decayDays <= 0) throw new RangeError('decayDays must be > 0');
  return Math.exp(-ageInDays / decayDays);
}

/**
 * Strips explicitly-`undefined`-valued keys from an options object before it
 * gets spread over defaults. `{ ...DEFAULTS, ...opts }` alone is not enough:
 * a caller that merges option layers can produce a key that IS present with
 * value `undefined` rather than omitting it, and object spread lets that
 * `undefined` win over the default, turning `budgetTokens - guaranteedTokens`
 * into NaN and silently disabling every budget check (NaN comparisons are
 * always false). Only present keys with a defined value override a default.
 */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
