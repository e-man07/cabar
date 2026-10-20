/**
 * Offline evidence benchmark on HotpotQA (distractor setting). No LLM, runs in seconds.
 *
 * Every HotpotQA question comes with 10 Wikipedia paragraphs: the 2 it needs (gold) and
 * 8 distractors picked to look relevant. Answering needs BOTH gold paragraphs (multi-hop).
 * BM25 scores the 10 paragraphs; each selector picks from them under the same limits.
 * We count how often both gold paragraphs survive, and what it costs.
 *
 * Usage:
 *   curl -LO http://curtis.ml.cmu.edu/datasets/hotpot/hotpot_dev_distractor_v1.json
 *   npx tsx bench/hotpot-evidence.ts hotpot_dev_distractor_v1.json
 */
import { readFileSync } from 'node:fs';
import { CabarSelector, estimateTokens, normalizeScores, type CabarUnit } from '../src';
import { bm25 } from './bm25';

interface Question {
  _id: string;
  question: string;
  type: string; // bridge | comparison
  supporting_facts: [string, number][];
  context: [string, string[]][];
}

const data: Question[] = JSON.parse(readFileSync(process.argv[2] ?? 'hotpot_dev_distractor_v1.json', 'utf8'));

interface Acc { q: number; both: number; gold: number; tokens: number }
const arms = new Map<string, Acc>();
const add = (arm: string, both: boolean, gold: number, tokens: number) => {
  const a = arms.get(arm) ?? { q: 0, both: 0, gold: 0, tokens: 0 };
  a.q++;
  if (both) a.both++;
  a.gold += gold;
  a.tokens += tokens;
  arms.set(arm, a);
};

for (const q of data) {
  const goldTitles = new Set(q.supporting_facts.map(([t]) => t));
  const raw = q.context.map(([title, sents], i) => ({ id: String(i), title, content: `${title}: ${sents.join(' ')}` }));
  const scores = bm25(raw.map((p) => p.content), q.question);
  const pool: (CabarUnit & { title: string })[] = normalizeScores(raw.map((p, i) => ({ ...p, score: scores[i]! })))
    .sort((a, b) => b.score - a.score);
  const goldIds = new Set(pool.filter((p) => goldTitles.has(p.title)).map((p) => p.id));
  const cost = (ids: string[]) => ids.reduce((n, id) => n + estimateTokens(pool.find((p) => p.id === id)!.content), 0);
  const score = (arm: string, ids: string[], tokens = cost(ids)) => {
    const gold = ids.filter((id) => goldIds.has(id)).length;
    add(arm, gold === goldIds.size, gold, tokens);
  };

  score('send all 10', pool.map((p) => p.id));
  for (const k of [2, 3, 4]) {
    score(`top-${k}`, pool.slice(0, k).map((p) => p.id));
    const r = CabarSelector.select(pool, q.question, { maxUnits: k, tauFloor: 1.1, recencyLambda: 0 });
    score(`cabar, ${k} units`, r.selected.map((u) => u.id));
    // Top-k filled to the same token spend as CABAR's pick: the fair baseline.
    const ids: string[] = [];
    for (const p of pool) {
      if (cost(ids) >= r.stats.selectedTokens) break;
      ids.push(p.id);
    }
    score(`top-k at cabar-${k} tokens`, ids);
    const r5 = CabarSelector.select(pool, q.question, { maxUnits: k, tauFloor: 1.1, recencyLambda: 0, costExponent: 0.5 });
    score(`cabar, ${k} units, costExponent 0.5`, r5.selected.map((u) => u.id));
  }
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const base = arms.get('send all 10')!;
console.log(`HotpotQA distractor dev, ${base.q} questions, BM25 over the 10 paragraphs (tail disabled: verbatim picks only)\n`);
console.log('| Arm | Both gold paragraphs kept | Gold paragraphs kept | Avg tokens | Tokens saved vs send-all |\n|---|---|---|---|---|');
for (const [arm, a] of arms) {
  console.log(`| ${arm} | ${pct(a.both, a.q)} | ${pct(a.gold, a.q * 2)} | ${Math.round(a.tokens / a.q)} | ${pct(base.tokens - a.tokens, base.tokens)} |`);
}
