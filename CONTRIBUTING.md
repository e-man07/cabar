# Contributing

Issues and PRs are welcome.

- Keep the selectors **pure and deterministic**: no clock reads, network, randomness or LLM calls inside `select()`.
- Every behavior change needs a test in `test/`. Defaults are part of the contract: changing one is a breaking change.
- New options must be opt-in and leave the default output byte-identical.
- Before opening a PR: `npm test && npm run typecheck`.

Good first contributions: a Python port, adapters for other frameworks (LlamaIndex.TS, Mastra), a benchmark on another dataset (LoCoMo, your own traffic), an LLM-accuracy harness that runs from this repo.
