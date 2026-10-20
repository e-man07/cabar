/**
 * Offline evidence-recall benchmark on LongMemEval-S. No LLM, no embeddings, runs in seconds.
 *
 * For each of the 500 questions:
 *   1. Every chat turn in the question's haystack is a unit (timestamped with its session date).
 *   2. A plain BM25 retriever scores the turns against the question; the top 24 form the pool
 *      (roughly what an agent-memory system would "send all" of).
 *   3. Each selector picks from that pool. We count how many of the turns LongMemEval marks as
 *      evidence (`has_answer`) survive, and how many tokens it costs.
 *
 * This measures selection quality (does the evidence survive compression?), not answer accuracy.
 *
 * Usage:
 *   curl -LO https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
 *   npx tsx bench/evidence-recall.ts longmemeval_s_cleaned.json
 */
import { readFileSync } from 'node:fs';
import { CabarSelector, PrismSelector, estimateTokens, type CabarUnit } from '../src';
import { bm25 } from './bm25';

interface Turn { role: string; content: string; has_answer?: boolean }
interface Question {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: Turn[][];
}

const POOL = 24;

// "2023/05/20 (Sat) 02:21" → Date
const parseDate = (s: string) => new Date(s.replace(/\s*\(\w+\)\s*/, ' ').replace(/\//g, '-') + ':00Z');

type Arm = 'send-all' | 'top-8' | 'cabar' | 'top-k @ cabar tokens' | 'cabar capped-adaptive' | 'top-k @ capped tokens' | 'prism';
const ARMS: Arm[] = ['send-all', 'top-8', 'cabar', 'top-k @ cabar tokens', 'cabar capped-adaptive', 'top-k @ capped tokens', 'prism'];

interface Acc { evidence: number; kept: number; keptOrTail: number; tokens: number; q: number; full: number }
const blank = (): Acc => ({ evidence: 0, kept: 0, keptOrTail: 0, tokens: 0, q: 0, full: 0 });
const total = new Map<Arm, Acc>(ARMS.map((a) => [a, blank()]));
const byType = new Map<string, Map<Arm, Acc>>();

const data: Question[] = JSON.parse(readFileSync(process.argv[2] ?? 'longmemeval_s_cleaned.json', 'utf8'));
let skipped = 0;

for (const q of data) {
  const units: (CabarUnit & { evidence: boolean })[] = [];
  q.haystack_sessions.forEach((session, si) => {
    session.forEach((turn, ti) => {
      if (!turn.content?.trim()) return;
      units.push({
        id: `s${si}t${ti}`,
        content: `${turn.role}: ${turn.content}`,
        score: 0,
        timestamp: parseDate(q.haystack_dates[si]!),
        evidence: !!turn.has_answer,
      });
    });
  });
  const scores = bm25(units.map((u) => u.content), q.question);
  const ranked = units.map((u, i) => ({ ...u, score: scores[i]! })).sort((a, b) => b.score - a.score).slice(0, POOL);
  const top = ranked[0]?.score || 1;
  const min = ranked[ranked.length - 1]?.score ?? 0;
  const pool = ranked.map((u) => ({ ...u, score: top === min ? 1 : (u.score - min) / (top - min) }));
  const evidenceIds = new Set(pool.filter((u) => u.evidence).map((u) => u.id));
  if (evidenceIds.size === 0) { skipped++; continue; } // retriever missed all evidence: nothing to measure

  const now = parseDate(q.question_date);
  const cost = (ids: string[]) => ids.reduce((n, id) => n + estimateTokens(pool.find((u) => u.id === id)!.content), 0);

  const fixed = CabarSelector.select(pool, q.question, { now });
  const capped = CabarSelector.select(pool, q.question, { now, adaptive: true, capToMaxUnits: true });
  const prism = PrismSelector.select(pool, q.question, { now });
  // Top-k by score, filled to the same token spend (selected + tail) as a CABAR arm: the fair baseline.
  const topAt = (budget: number) => {
    const ids: string[] = [];
    for (const u of pool) {
      if (cost(ids) >= budget) break;
      ids.push(u.id);
    }
    return ids;
  };
  const topCabar = topAt(fixed.stats.selectedTokens + fixed.stats.tailSummaryTokens);
  const topCapped = topAt(capped.stats.selectedTokens + capped.stats.tailSummaryTokens);

  const results: Record<Arm, { sel: string[]; tail: string[]; tokens: number }> = {
    'send-all': { sel: pool.map((u) => u.id), tail: [], tokens: cost(pool.map((u) => u.id)) },
    'top-8': { sel: pool.slice(0, 8).map((u) => u.id), tail: [], tokens: cost(pool.slice(0, 8).map((u) => u.id)) },
    'top-k @ cabar tokens': { sel: topCabar, tail: [], tokens: cost(topCabar) },
    'top-k @ capped tokens': { sel: topCapped, tail: [], tokens: cost(topCapped) },
    cabar: { sel: fixed.selected.map((u) => u.id), tail: fixed.tail.map((u) => u.id), tokens: fixed.stats.selectedTokens + fixed.stats.tailSummaryTokens },
    'cabar capped-adaptive': { sel: capped.selected.map((u) => u.id), tail: capped.tail.map((u) => u.id), tokens: capped.stats.selectedTokens + capped.stats.tailSummaryTokens },
    prism: { sel: prism.selected.map((s) => s.unit.id), tail: prism.tail.map((u) => u.id), tokens: prism.stats.selectedTokens + prism.stats.tailTokens },
  };

  if (!byType.has(q.question_type)) byType.set(q.question_type, new Map(ARMS.map((a) => [a, blank()])));
  for (const arm of ARMS) {
    const r = results[arm];
    const kept = r.sel.filter((id) => evidenceIds.has(id)).length;
    const keptOrTail = new Set([...r.sel, ...r.tail].filter((id) => evidenceIds.has(id))).size;
    for (const acc of [total.get(arm)!, byType.get(q.question_type)!.get(arm)!]) {
      acc.evidence += evidenceIds.size;
      acc.kept += kept;
      acc.keptOrTail += keptOrTail;
      acc.tokens += r.tokens;
      acc.q++;
      if (kept === evidenceIds.size) acc.full++;
    }
  }
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const row = (arm: Arm, a: Acc, base: Acc) =>
  `| ${arm} | ${pct(a.kept, a.evidence)} | ${pct(a.full, a.q)} | ${pct(a.keptOrTail, a.evidence)} | ${Math.round(a.tokens / a.q)} | ${pct(base.tokens - a.tokens, base.tokens)} |`;
const header = '| Arm | Evidence kept verbatim | Questions with all evidence kept | Evidence kept or in tail | Avg tokens | Tokens saved vs send-all |\n|---|---|---|---|---|---|';

const n = total.get('send-all')!.q;
console.log(`LongMemEval-S, BM25 top-${POOL} pool, ${n} questions with evidence in the pool (${skipped} skipped: retriever missed all evidence)\n`);
console.log(header);
for (const arm of ARMS) console.log(row(arm, total.get(arm)!, total.get('send-all')!));
for (const [type, m] of [...byType].sort()) {
  console.log(`\n${type} (${m.get('send-all')!.q} q)\n\n${header}`);
  for (const arm of ARMS) console.log(row(arm, m.get(arm)!, m.get('send-all')!));
}
