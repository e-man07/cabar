/**
 * LangChain.js adapter: CABAR as a document compressor.
 *
 *   import { ContextualCompressionRetriever } from '@langchain/classic/retrievers/contextual_compression';
 *   import { CabarCompressor } from 'cabar/langchain';
 *
 *   const retriever = new ContextualCompressionRetriever({
 *     baseCompressor: new CabarCompressor({ budgetTokens: 2000 }),
 *     baseRetriever: vectorStore.asRetriever(24),
 *   });
 */
import { BaseDocumentCompressor } from '@langchain/core/retrievers/document_compressors';
import { Document, type DocumentInterface } from '@langchain/core/documents';
import { CabarSelector, type CabarSelectOptions, type CabarUnit } from './cabar';
import { normalizeScores } from './normalize';

export interface CabarCompressorOptions extends CabarSelectOptions {
  /**
   * Metadata keys holding a relevance score, tried in order. Default:
   * `relevance_score` (rerankers), `relevanceScore`, `score`. Documents without
   * any of them are scored by their position in the retriever's order.
   */
  scoreKeys?: string[];
  /** Metadata key holding a date (Date, ISO string or epoch ms) for recency. Default: `timestamp`. */
  timestampKey?: string;
  /** Append the tail summary as one extra Document (metadata `{ cabar: 'tail' }`). Default true. */
  includeTail?: boolean;
}

const DEFAULT_SCORE_KEYS = ['relevance_score', 'relevanceScore', 'score'];

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export class CabarCompressor extends BaseDocumentCompressor {
  private readonly opts: CabarCompressorOptions;

  constructor(opts: CabarCompressorOptions = {}) {
    super();
    this.opts = opts;
  }

  async compressDocuments(documents: DocumentInterface[], query: string): Promise<DocumentInterface[]> {
    if (documents.length === 0) return [];
    const { scoreKeys = DEFAULT_SCORE_KEYS, timestampKey = 'timestamp', includeTail = true, ...selectOpts } = this.opts;

    const scored = documents.map((doc) => {
      const key = scoreKeys.find((k) => typeof doc.metadata?.[k] === 'number' && Number.isFinite(doc.metadata[k]));
      return key ? (doc.metadata[key] as number) : null;
    });
    // Mixed or missing scores: fall back to the retriever's order (first = most relevant).
    const useRank = scored.some((s) => s === null);
    const units: CabarUnit[] = normalizeScores(
      documents.map((doc, i) => ({
        id: String(i),
        content: doc.pageContent,
        score: useRank ? documents.length - i : (scored[i] as number),
        timestamp: toDate(doc.metadata?.[timestampKey]),
      })),
    );

    const result = CabarSelector.select(units, query, selectOpts);
    const out: DocumentInterface[] = result.selected.map((u) => documents[Number(u.id)]!);
    if (includeTail && result.tailSummary) {
      out.push(new Document({ pageContent: result.tailSummary, metadata: { cabar: 'tail', units: result.tail.map((u) => Number(u.id)) } }));
    }
    return out;
  }
}
