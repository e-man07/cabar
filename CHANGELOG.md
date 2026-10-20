# Changelog

## 0.1.0 (2026-10-20)

First standalone release, extracted from MetaMemory.

- `CabarSelector`: utility-per-token greedy selection (relevance × recency × novelty), best-single swap, extractive tail summary with a tail-cost guard, adaptive and capped-adaptive stopping.
- `PrismSelector`: multi-fidelity selection (verbatim / extract / claims / mention) as a multiple-choice knapsack, cache-stable output order, optional hysteresis.
- New option `recencyDecayDays` (default 365, same behavior as before).
- 73 tests: unit tests plus property tests on 500 random pools.
- `bench/evidence-recall.ts`: offline evidence-recall benchmark on LongMemEval-S.
