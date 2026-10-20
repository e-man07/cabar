# Changelog

## 0.1.0 (2026-10-20)

First release, extracted from MetaMemory.

- `CabarSelector`: picks chunks greedily by utility per token, where utility = relevance × recency × novelty. Also does a best-single swap, writes an extractive tail summary with a tail-cost guard, and supports adaptive and capped-adaptive stopping.
- `PrismSelector`: multi-fidelity selection (verbatim / extract / claims / mention) as a multiple-choice knapsack, cache-stable output order, optional hysteresis.
- `normalizeScores`: map cosine, BM25, reranker or distance scores to [0, 1].
- `tokenCounter` option on both selectors for exact token counts.
- `similarity` option plus `embeddingSimilarity` / `cosineSimilarity` to catch paraphrases.
- `costExponent` option to soften the per-token preference for short chunks.
- `explain` option: a reason for every chunk.
- `toContext` and `shadowReport` helpers.
- `@whyparabola/cabar/langchain`: `CabarCompressor` for LangChain.js.
- `recencyDecayDays` option.
- Benchmarks: LongMemEval-S evidence recall, HotpotQA multi-hop evidence.
- 100 tests, including property tests on 500 random pools.
