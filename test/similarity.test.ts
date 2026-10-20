import { describe, it, expect } from 'vitest';
import { CabarSelector } from '../src/cabar';
import { PrismSelector } from '../src/prism';
import { cosineSimilarity, embeddingSimilarity } from '../src/shared';

// Two paraphrases with no word overlap, plus an unrelated unit. Embeddings say the paraphrases match.
const units = [
  { id: 'a', content: 'The deploy moved to Modal last week.', score: 1, embedding: [1, 0, 0] },
  { id: 'b', content: 'Hosting switched providers seven days ago.', score: 0.95, embedding: [0.99, 0.05, 0] },
  { id: 'c', content: 'Invoices go out on the first Monday.', score: 0.6, embedding: [0, 0, 1] },
];

describe('cosineSimilarity', () => {
  it('is 1 for parallel vectors, 0 for orthogonal, clamps negatives to 0', () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(RangeError);
  });

  it('embeddingSimilarity throws on a unit without an embedding', () => {
    expect(() => embeddingSimilarity({ id: 'x' }, { id: 'y', embedding: [1] })).toThrow(/x/);
  });
});

describe('similarity option', () => {
  it('lexical novelty keeps both paraphrases; embedding novelty keeps one', () => {
    const lexical = CabarSelector.select(units, 'where do we deploy', { maxUnits: 2 });
    expect(lexical.selected.map((u) => u.id).sort()).toEqual(['a', 'b']);
    const semantic = CabarSelector.select(units, 'where do we deploy', { maxUnits: 2, similarity: embeddingSimilarity });
    expect(semantic.selected.map((u) => u.id).sort()).toEqual(['a', 'c']);
  });

  it('works in Prism too', () => {
    const r = PrismSelector.select(units, 'where do we deploy', { maxUnits: 2, similarity: embeddingSimilarity });
    expect(r.selected.map((s) => s.unit.id).sort()).toEqual(['a', 'c']);
  });
});
