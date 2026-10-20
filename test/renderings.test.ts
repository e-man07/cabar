/**
 * Prism renderings — Unit Tests.
 *
 * Pure-function tests for the four deterministic fidelities: verbatim, extract
 * (query-aware, narrative-order, ≤~40% target), claims bullets (+UNAVAILABLE
 * signal), and the mention pointer line (id@date + ≤25-token snippet). Costs
 * are measured through an explicit char/4 TokenCounter so every assertion is
 * exact and provider-agnostic.
 */

import { describe, it, expect } from 'vitest';
import {
  verbatim,
  extract,
  claimsRendering,
  mention,
  EXTRACT_TARGET_RATIO,
  MENTION_MAX_TOKENS,
} from '../src/renderings';
import type { PrismUnit, TokenCounter } from '../src/prism';
import { estimateTokens } from '../src/shared';

const counter: TokenCounter = { name: 'char4', count: estimateTokens };

describe('renderings.verbatim', () => {
  it('returns the content unchanged', () => {
    const u: PrismUnit = { id: 'v1', content: 'Hello world, this is verbatim.', score: 0.5 };
    expect(verbatim(u)).toBe('Hello world, this is verbatim.');
  });
});

describe('renderings.extract', () => {
  // s0: long, order-0 (positional bonus only). s1: "keyword now." (1 hit, order 1).
  // s2: "keyword here extra more." (3 hits, order 2). s3: long, no hits.
  const content =
    'Intro filler padding padding padding padding padding padding padding. ' +
    'keyword now. ' +
    'keyword here extra more. ' +
    'Trailing filler padding padding padding padding padding padding padding.';
  const u: PrismUnit = { id: 'e1', content, score: 0.7 };

  it('compresses toward the ~40% token target and drops off-target sentences', () => {
    const result = extract(u, 'keyword here extra', counter);
    // Target is floor(0.4 × verbatim). The two big filler sentences don't fit.
    const target = Math.floor(counter.count(content) * EXTRACT_TARGET_RATIO);
    expect(counter.count(result)).toBeLessThan(counter.count(content));
    // Greedy stays at/under target (single-sentence forced-pick is the only over-target case; not hit here).
    expect(counter.count(result)).toBeLessThanOrEqual(target);
    expect(result).not.toContain('Intro filler');
    expect(result).not.toContain('Trailing filler');
  });

  it('keeps the query-relevant sentences and emits them in ORIGINAL narrative order', () => {
    const result = extract(u, 'keyword here extra', counter);
    expect(result).toContain('keyword now');
    expect(result).toContain('keyword here extra more');
    // s1 ("keyword now", order 1) precedes s2 ("keyword here extra more", order 2)
    // in the output even though s2 outscores s1 — proving original-order, not score-order.
    expect(result.indexOf('keyword now')).toBeLessThan(result.indexOf('keyword here extra more'));
  });

  it('returns the whole content (trimmed) for single-sentence input (dominance is handled by the selector)', () => {
    const single: PrismUnit = { id: 'e2', content: 'Just one sentence with no terminators inside', score: 0.4 };
    expect(extract(single, 'anything', counter)).toBe('Just one sentence with no terminators inside');
  });

  it('is deterministic across runs', () => {
    const a = extract(u, 'keyword here extra', counter);
    const b = extract(u, 'keyword here extra', counter);
    expect(a).toBe(b);
  });
});

describe('renderings.claimsRendering', () => {
  it('returns UNAVAILABLE (null) when the unit carries no claims', () => {
    expect(claimsRendering({ id: 'c1', content: 'x', score: 0.5 })).toBeNull();
    expect(claimsRendering({ id: 'c1', content: 'x', score: 0.5, claims: [] })).toBeNull();
  });

  it('joins claims as "- <claim>" bullet lines', () => {
    const u: PrismUnit = { id: 'c2', content: 'x', score: 0.5, claims: ['revenue rose 12%', 'board approved budget'] };
    expect(claimsRendering(u)).toBe('- revenue rose 12%\n- board approved budget');
  });
});

describe('renderings.mention', () => {
  it('formats [id@yyyy-mm-dd] when a timestamp is present', () => {
    const u: PrismUnit = {
      id: 'm1',
      content: 'Ship it Monday.',
      score: 0.6,
      timestamp: new Date('2026-07-02T10:00:00.000Z'),
    };
    expect(mention(u, counter)).toBe('[m1@2026-07-02] Ship it Monday.');
  });

  it('formats [id] with no date when there is no timestamp', () => {
    const u: PrismUnit = { id: 'm2', content: 'No date here.', score: 0.6 };
    expect(mention(u, counter)).toBe('[m2] No date here.');
  });

  it('uses only the FIRST sentence', () => {
    const u: PrismUnit = { id: 'm3', content: 'Short one. Second sentence unused here.', score: 0.6 };
    const line = mention(u, counter);
    expect(line).toContain('Short one');
    expect(line).not.toContain('unused');
  });

  it('truncates a long first sentence to <=25 tokens with an ellipsis', () => {
    const longFirst =
      'This first sentence is deliberately very long so that it clearly exceeds twenty five tokens ' +
      'when counted by the character based estimator that is being used right here for sure indeed.';
    const u: PrismUnit = { id: 'm4', content: longFirst, score: 0.6 };
    const line = mention(u, counter);
    expect(line.startsWith('[m4] ')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    // The snippet (line minus the "[m4] " prefix) stays within the token cap.
    const snippet = line.slice('[m4] '.length);
    expect(counter.count(snippet)).toBeLessThanOrEqual(MENTION_MAX_TOKENS);
  });

  it('does not add an ellipsis when the first sentence already fits', () => {
    const u: PrismUnit = { id: 'm5', content: 'Tiny.', score: 0.6 };
    expect(mention(u, counter)).toBe('[m5] Tiny.');
  });
});
