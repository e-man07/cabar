import { describe, it, expect } from 'vitest';
import { Document } from '@langchain/core/documents';
import { BaseDocumentCompressor } from '@langchain/core/retrievers/document_compressors';
import { CabarCompressor } from '../src/langchain';

const docs = [
  new Document({ pageContent: 'The deploy target for gpu workers is modal with an L40S card.', metadata: { score: 0.83 } }),
  new Document({ pageContent: 'The deploy target for gpu workers is modal with an L40S card.', metadata: { score: 0.82 } }),
  new Document({ pageContent: 'Invoices are sent on the first Monday of each month.', metadata: { score: 0.76 } }),
  new Document({ pageContent: 'Dark mode is the default theme in every dashboard.', metadata: { score: 0.74 } }),
  new Document({ pageContent: 'The user watched a talk about vector databases.', metadata: { score: 0.71 } }),
];

describe('CabarCompressor', () => {
  it('is a LangChain document compressor', () => {
    expect(BaseDocumentCompressor.isBaseDocumentCompressor(new CabarCompressor())).toBe(true);
  });

  it('returns the original Document objects for selected units, plus a tail document', async () => {
    const out = await new CabarCompressor({ maxUnits: 2 }).compressDocuments(docs, 'where do gpu workers deploy');
    expect(out[0]).toBe(docs[0]);
    expect(out.filter((d) => d === docs[1])).toHaveLength(0); // exact duplicate dropped
    const tail = out.find((d) => d.metadata.cabar === 'tail');
    expect(tail).toBeDefined();
  });

  it('normalizes raw scores (cosine 0.71–0.83) so tauFloor drops the weakest', async () => {
    const out = await new CabarCompressor({ maxUnits: 2, includeTail: true }).compressDocuments(docs, 'deploy');
    const tail = out.find((d) => d.metadata.cabar === 'tail')!;
    expect(tail.metadata.units).not.toContain(4); // normalized to 0, below tauFloor
  });

  it('falls back to retriever order when scores are missing, and can skip the tail', async () => {
    const plain = docs.map((d) => new Document({ pageContent: d.pageContent }));
    const out = await new CabarCompressor({ maxUnits: 1, includeTail: false }).compressDocuments(plain, 'deploy');
    expect(out).toEqual([plain[0]]);
  });

  it('handles an empty list', async () => {
    expect(await new CabarCompressor().compressDocuments([], 'q')).toEqual([]);
  });
});
