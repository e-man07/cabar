# Contributing

Issues and PRs are welcome.

- Keep the selectors **pure and deterministic**: no clock reads, network, randomness or LLM calls inside `select()`.
- Every behavior change needs a test in `test/`. Defaults are part of the contract: changing one is a breaking change.
- New options must be opt-in and leave the default output byte-identical.
- Before opening a PR: `npm test && npm run typecheck`.

Good first contributions: cosine-similarity novelty over caller-supplied embeddings, a Python port, a benchmark on another dataset (LoCoMo, your own traffic).
