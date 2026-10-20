# CABAR

**Context-Budget-Aware Retrieval.** Your retriever found 24 chunks. CABAR decides which ones are actually worth the prompt tokens, sends those, and squeezes the rest into a short tail instead of dropping them.

Pure TypeScript. Zero dependencies. No LLM calls, no I/O, embeddings optional. Deterministic: same input, same output.

On LongMemEval-S it keeps **90% of the answer evidence with 79% fewer tokens**, where top-k at the same token spend keeps 79%. In a 72B-reader run on multi-session questions, accuracy went from **35% to 80%** with 84% fewer tokens, because the reader stopped drowning in context. ([Results](#results), including where it loses.)

```
npm install cabar
```

---

## The problem

Most RAG and agent-memory pipelines do this:

```ts
const chunks = await retrieve(query, { topK: 24 });
prompt += chunks.map((c) => c.content).join('\n'); // send everything
```

That costs you three ways:

1. **Tokens.** Around 20k tokens per query in our memory system, mostly redundant.
2. **Latency.** Answer time grows with prompt length. In our profile, ~80% of answer latency was the LLM reading context.
3. **Accuracy.** Past a point, more context makes answers *worse*: the one fact that matters gets lost among near-duplicates and weak hits.

Top-K truncation is not the fix. It keeps duplicates (two chunks saying the same thing both score high) and silently drops the long tail, where multi-session and temporal questions usually find their answer.

## How CABAR works

CABAR treats context as a **knapsack**: every chunk has a value and a token cost, and the prompt has a budget.

```
utility(u, S) = relevance(u) × recency(u) × novelty(u, S)
```

- **relevance**: the score from your retriever, normalized to [0, 1].
- **recency**: `λ · e^(−age/365d) + (1 − λ)`. A gentle preference for newer chunks (λ = 0.3), never a cliff.
- **novelty**: `1 − max Jaccard(u, s)` over chunks `s` already selected. Recomputed every round, so a near-duplicate of something already picked is worth almost nothing.

Then:

1. **Greedy fill by utility per token.** Each round, pick the chunk with the best marginal utility per token that still fits the budget.
2. **Best-single swap.** If one chunk alone beats the whole greedy set, take it instead. This is the classic budgeted-max-coverage trick (Khuller, Moss & Naor) that gives greedy a constant-factor guarantee.
3. **Adaptive stopping** (optional). After `minKeep` chunks, stop when the next candidate falls off a *relevance cliff* (below 40% of the top score) or adds too little novelty (< 0.2). Noisy pools stop early, and pools with a real relevant tail keep more. It doesn't look at the question type, only at the shape of the pool.
4. **Summarize the tail, never drop it.** Every unselected chunk above `tauFloor` goes into a compact extractive summary: the sentences that overlap the query most, within a hard token cap. If that summary would cost more than the raw chunks, it sends the raw chunks instead.

Selection is O(n · k²) similarity checks for n candidates and k selected: sub-millisecond for typical pools, negligible next to the LLM call it shrinks.

### Prism: multi-fidelity (CABAR-2)

CABAR's choice is binary: a chunk is sent in full or goes to the tail. **Prism** turns that into a ladder. Each chunk can be rendered at four fidelities:

| Fidelity | What gets sent | Utility kept (default) |
|---|---|---|
| `verbatim` | the full chunk | 1.00 |
| `extract` | query-relevant sentences, ≤ ~40% of the tokens | 0.85 |
| `claims` | pre-extracted facts you attach to the chunk | 0.75 |
| `mention` | a one-line pointer: `[id@date] first sentence…` | 0.30 |

Prism solves this as a **multiple-choice knapsack**. Each move either adds a chunk at some fidelity or upgrades an already-selected chunk to a richer one, always taking the densest move. Under tight budgets it beats all-or-nothing, because three extracts often carry more than one verbatim chunk.

Prism also emits selected chunks in **timestamp order, not score order**, so the same chunks land in the same prompt positions turn after turn. That keeps your provider's prompt cache warm. An optional hysteresis bonus (`hysteresisBonus`) makes it stick with last turn's choices for the same reason.

## Usage

```ts
import { CabarSelector, normalizeScores, toContext } from 'cabar';

const hits = await retrieve(query); // [{ id, content, score, timestamp? }]

const result = CabarSelector.select(normalizeScores(hits), query); // ≤ 8 chunks, ≤ 4000 tokens
const context = toContext(result); // selected chunks + "Other possibly relevant notes:" tail

console.log(`${result.stats.candidateTokens} → ${result.stats.utilizedTokens} tokens`);
```

**Normalize your scores first.** CABAR expects relevance in [0, 1] with the best hit near 1. `tauFloor` and the adaptive cliff are fractions of that scale. Raw scores rarely fit:
- Cosine similarities bunch up in 0.7–0.85, so nothing ever falls below `tauFloor`.
- BM25 and reranker logits are unbounded.
- Vector-store distances run the wrong way.

`normalizeScores(hits)` maps any of them to [0, 1] (min-max by default). For distances, pass `{ higherIsBetter: false }`.

**Start with the defaults.** In the evidence benchmarks below, fixed CABAR had the best balance of evidence kept and tokens spent.

**Capped-adaptive** (`adaptive: true, capToMaxUnits: true`) saves more tokens (87% vs 79%) by stopping at the relevance cliff. The cost: it keeps less evidence verbatim (75% vs 90%), though most of the rest still reaches the prompt through the tail. How early it stops depends on the shape of your scores. Try it in shadow mode against your own pools before switching.

### Vercel AI SDK (or any LLM call)

```ts
import { generateText } from 'ai';
import { CabarSelector, normalizeScores, toContext } from 'cabar';

const result = CabarSelector.select(normalizeScores(hits), question, { budgetTokens: 2000 });

const { text } = await generateText({
  model,
  system: `Answer from these notes:\n\n${toContext(result, { format: (t, id) => `<note id="${id}">${t}</note>` })}`,
  prompt: question,
});
```

### LangChain.js

`cabar/langchain` is a document compressor. Drop it into `ContextualCompressionRetriever`:

```ts
import { ContextualCompressionRetriever } from '@langchain/classic/retrievers/contextual_compression'; // 'langchain/retrievers/contextual_compression' on LangChain 0.3
import { CabarCompressor } from 'cabar/langchain';

const retriever = new ContextualCompressionRetriever({
  baseCompressor: new CabarCompressor({ budgetTokens: 2000 }),
  baseRetriever: vectorStore.asRetriever(24),
});
```

- **Scores:** it reads them from `metadata.relevance_score` or `metadata.score` and normalizes them. If they're missing, it falls back to the retriever's order.
- **Tail:** it comes back as one extra `Document` with `metadata.cabar = 'tail'`. Pass `includeTail: false` to skip it.

`@langchain/core` is an optional peer dependency.

### Catch paraphrases with embeddings

The default novelty check is word overlap, so it misses paraphrases. If your chunks already have embeddings, use those instead:

```ts
import { CabarSelector, embeddingSimilarity } from 'cabar';

// each chunk: { id, content, score, embedding: number[] }
const result = CabarSelector.select(chunks, query, { similarity: embeddingSimilarity });
```

Any `(a, b) => number` in [0, 1] works as `similarity`. It's available in both selectors.

### Exact token counts

```ts
import { encode } from 'gpt-tokenizer';

CabarSelector.select(chunks, query, { tokenCounter: { name: 'o200k', count: (t) => encode(t).length } });
```

### See why, and try it in shadow mode

```ts
import { CabarSelector, shadowReport } from 'cabar';

const { decisions } = CabarSelector.select(chunks, query, { explain: true });
// [{ id: 'u7', status: 'tail', reason: 'redundant with u2 (similarity 0.91)', tokens: 84, ... }, ...]

const report = shadowReport(chunks, query); // doesn't change what you send
log({ saved: report.savedFraction, dropped: report.droppedIds });
```

Shadow mode is the safe rollout:
1. Keep sending what you send today.
2. Log what CABAR would have sent.
3. Compare answers on a sample, then switch.

### Prism

```ts
import { PrismSelector, toContext } from 'cabar';

const result = PrismSelector.select(chunksWithClaims, query, { budgetTokens: 2000 });
for (const s of result.selected) console.log(s.unit.id, s.fidelity, s.rendered);
const context = toContext(result);
```

Run the example: `npm run example` (source: [`examples/basic.ts`](examples/basic.ts)).

## Options

Both selectors share these (Prism's defaults in parentheses where different):

| Option | Default | What it does |
|---|---|---|
| `budgetTokens` | 4000 | Token budget for `guaranteedTokens` + selected chunks |
| `maxUnits` | 8 (12) | Max distinct chunks selected |
| `tailBudgetTokens` | 600 | Hard cap for the tail, on top of the budget |
| `tauFloor` | 0.15 | Chunks scoring below this are dropped, not summarized |
| `recencyLambda` | 0.3 | 0 = ignore age entirely (safest for cross-session questions) |
| `recencyDecayDays` | 365 | Scale of the exponential recency decay |
| `noveltyWeight` | 1 | 0 = ignore redundancy, 1 = full MMR-style novelty |
| `guaranteedTokens` | 0 | Tokens you've already spent (system prompt, a facts block), pre-charged against the budget |
| `now` | `new Date()` | Pass a fixed date for reproducible results |
| `tokenCounter` | chars / 4 | `{ name, count(text) }`, e.g. a real BPE tokenizer |
| `similarity` | word-set Jaccard | `(a, b) => [0, 1]` for novelty, e.g. `embeddingSimilarity` |
| `adaptive` | false | Enable the relevance-cliff/novelty stopping rule |
| `minKeep` | 3 | Chunks kept before the adaptive rule can stop |
| `relFloor` | 0.4 | Adaptive: stop below this fraction of the top score |
| `novFloor` | 0.2 | Adaptive: stop below this novelty |
| `maxCeilingTokens` | 4000 | Adaptive: the hard token bound (replaces `budgetTokens`) |
| `capToMaxUnits` | false | CABAR only: adaptive also respects `maxUnits` |
| `costExponent` | 1 | CABAR only: density = utility / tokens^x. Lower it (0.5) when answers live in long chunks |
| `explain` | false | CABAR only: return `decisions`, the reason for every chunk |

Prism only: `fidelityFactors`, `hysteresisBonus`, `prevSelected`, and `claims?: string[]` on each chunk.

## Results

### 1. Evidence recall on LongMemEval-S (reproducible, no LLM)

[`bench/evidence-recall.ts`](bench/evidence-recall.ts) runs in about 10 seconds on the public [LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) dataset:
1. For each of the 500 questions, a plain BM25 retriever pulls the top 24 chat turns from the haystack.
2. Each selector picks from those 24 turns.
3. The script counts how many of the turns LongMemEval marks as answer evidence survive, and what they cost.

The 57 questions where BM25 missed all evidence are skipped, leaving 443. Full per-type tables: [`bench/longmemeval-results.md`](bench/longmemeval-results.md).

| Selector | Evidence kept verbatim | All evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved |
|---|---|---|---|---|---|
| Send all 24 | 100% | 100% | 100% | 6,756 | 0% |
| Top-8 by score | 84.6% | 79.2% | 84.6% | 2,052 | 70% |
| **CABAR (defaults)** | **90.3%** | **86.2%** | **93.6%** | **1,432** | **79%** |
| Top-k at CABAR's token spend | 78.8% | 74.3% | 78.8% | 1,728 | 74% |
| CABAR capped-adaptive | 75.1% | 66.8% | 91.6% | 890 | 87% |
| Top-k at capped-adaptive's spend | 72.6% | 66.4% | 72.6% | 1,144 | 83% |
| Prism (defaults) | 93.6% | 91.0% | 94.6% | 2,481 | 63% |

- **Multi-session questions** (118), where the answer is spread across several sessions: CABAR keeps 87.8% of the evidence, top-k at the same spend 65.9%, top-8 75.5%. Removing duplicates makes room for the second and third piece of evidence.
- **Where it loses:** on single-session-assistant questions (52), the evidence is usually one long assistant reply. CABAR ranks by utility *per token*, so it keeps 88.5% verbatim vs 94.2% for top-k (the tail still reaches 98.1%). Capped-adaptive drops to 61.5%.
- **`costExponent: 0.5` fixes that case** (94.2%, level with top-k), but overall evidence drops to 88.8% and token savings to 73%. That's why it's an option, not the default.
- BM25 plus min-max normalization is a weak, steep-scoring retriever. Your numbers will move with your retriever.

### 2. Multi-hop evidence on HotpotQA (reproducible, no LLM)

[`bench/hotpot-evidence.ts`](bench/hotpot-evidence.ts) runs in 4 seconds on all 7,405 dev questions (distractor setting):
- Each question comes with 10 paragraphs: the 2 it needs and 8 distractors chosen to look relevant.
- BM25 scores the 10 paragraphs, and each selector keeps k of them.
- The script counts how often **both** gold paragraphs survive.

Full table: [`bench/hotpot-results.md`](bench/hotpot-results.md).

| Paragraphs kept | Top-k: both gold kept | CABAR: both gold kept | CABAR tokens vs top-k |
|---|---|---|---|
| 2 | 31.5% | **32.7%** | 22% fewer |
| 3 | 48.1% | **50.6%** | 20% fewer |
| 4 | 59.4% | **62.7%** | 17% fewer |

Small but consistent: a few points more evidence on fewer tokens. The gain is much smaller than on LongMemEval because HotpotQA paragraphs come from different articles and rarely repeat each other, so there's little redundancy to remove. CABAR helps most where chunks overlap: chat logs, memory stores, tickets.

### 3. Answer accuracy with a 72B reader (from MetaMemory)

Measured inside MetaMemory, the agent-memory system CABAR was built for. Setup: LongMemEval-S, Qwen2.5-72B-Instruct-AWQ as reader and judge, tokens counted with o200k BPE.

| Test set | Send everything | CABAR | Token reduction |
|---|---|---|---|
| Mixed, all question types (24 q) | 19/24 @ 7,780 tok | 19/24 @ 2,158 tok | 72% |
| Multi-session (18 q) + abstention (2 q) | 7/20 @ 15,156 tok | **16/20** @ 2,406 tok | 84% |
| Generic answer prompt, 6 types × 10 (60 q) | 40/60 @ 8,578 tok | **45/60** @ 2,051 tok | 76% |
| Smoke test (6 q) | 6/6 @ 8,285 tok | 5/6 @ 2,064 tok | 75% |

- **Adaptive CABAR:** on a rerun of the multi-session set it scored 16/20 at 2,137 tokens. On the 60-question set it scored 43/60 at 3,544.
- **Prism:** 20/24 on the mixed set, but **13/20 on multi-session**, worse than plain CABAR there.
- **Capped-adaptive:** checked only by which chunks it picks (on concentrated pools, exactly the same as fixed CABAR). Its accuracy wasn't benchmarked on its own.

**Read these honestly:**
- The samples are small: 20 questions gives a 95% interval of roughly ±20 points.
- One reader model, one dataset.
- This harness lives in MetaMemory, not in this repo.

The direction is consistent (equal or better accuracy at a quarter of the tokens), but treat it as evidence, not a guarantee. Run CABAR in shadow mode on your own traffic first: log what it *would* send next to what you send now, and compare answers.

### 4. Correctness

[`test/properties.test.ts`](test/properties.test.ts) checks the guarantees on 500 random pools each:
- The budget, `maxUnits` and the tail cap are never exceeded.
- Output is deterministic.
- Nothing at or above `tauFloor` is silently dropped.
- An exact duplicate is never selected twice.
- Prism always emits chunks in cache-stable order.

On 30,000 random selections, this package produced byte-identical output to the original MetaMemory implementation.

## When to use it

**Good fit:**
- Agent memory and RAG pipelines that retrieve 10–50 chunks per query.
- Pools with lots of near-duplicate chunks (chat logs, memory stores, support tickets).
- Anywhere prompt tokens cost you latency or money.

**Not a fit:**
- If you already send fewer than ~5 short chunks, there's little to trim.
- Pools of distinct, non-overlapping documents gain only a little (see HotpotQA above).
- Without `similarity: embeddingSimilarity`, novelty is lexical (word-set Jaccard), so paraphrases with different wording aren't caught.

**Know the quirk:** the greedy fill ranks by utility *per token*, so it prefers short chunks. When one long chunk holds the answer (a long assistant reply, a big doc section), top-k can beat it: see single-session-assistant above. `costExponent: 0.5`, or chunking documents to similar sizes, keeps this in check.

## Design rules

- **Pure and deterministic.** No clock reads (pass `now`), no network, no randomness. The same pool always yields the same prompt, which makes it replayable and testable.
- **Provider-agnostic.** The default token cost is `chars / 4`. Inject a real tokenizer when you need exact numbers.
- **Never silently drop something relevant.** Anything above `tauFloor` that misses the budget still reaches the prompt, as a summary sentence (CABAR) or a mention line (Prism).

## Development

```
npm install
npm test          # 100 tests (unit + property)
npm run typecheck
npm run build     # ESM + CJS + types into dist/
npx tsx bench/evidence-recall.ts longmemeval_s_cleaned.json
npx tsx bench/hotpot-evidence.ts hotpot_dev_distractor_v1.json
```

## License

[MIT](LICENSE) © Aman Jha. Built for MetaMemory, extracted as a standalone library.
