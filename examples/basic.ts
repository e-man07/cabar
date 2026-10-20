// Run: npm run example
import { CabarSelector, PrismSelector, estimateTokens, toContext } from '../src';

// What your retriever returned for one query: 12 chunks, scores normalized to [0, 1].
// Lots of near-duplicates and weak hits, like a real agent-memory pool.
const now = new Date('2026-10-20T00:00:00Z');
const day = (d: string) => new Date(`2026-${d}T00:00:00Z`);

const chunks = [
  { id: 'm1', score: 1.0, timestamp: day('10-18'), content: 'The photo-to-3D pipeline moved from an A10G to an L40S on Modal in October. Cold starts are the main user complaint, and warm generation takes about 15 seconds.' },
  { id: 'm2', score: 0.94, timestamp: day('10-18'), content: 'Photo-to-3D now runs on an L40S on Modal after the October move from the A10G. Users complain about cold starts, while warm generation takes about 15 seconds.' },
  { id: 'm3', score: 0.81, timestamp: day('10-19'), content: 'Profiling a fresh container: loading the 15 GB of weights takes about 100 seconds and kernel compilation about 140 seconds. The model itself runs in 13 to 17 seconds.' },
  { id: 'm4', score: 0.62, timestamp: day('10-19'), content: 'An H100 saved 3 seconds on a warm run and was slower from a cold start. The decision was to keep the L40S and fix the startup path instead of upgrading.' },
  { id: 'm5', score: 0.55, timestamp: day('10-19'), content: 'Fix plan: keep the kernel tuning cache on the shared volume so new containers reuse it, and restore the loaded model from a GPU memory snapshot.' },
  { id: 'm6', score: 0.41, timestamp: day('10-02'), content: 'The user prefers TypeScript for services and Python only for model code. Web apps are deployed on Vercel and GPU workers on Modal.' },
  { id: 'm7', score: 0.33, timestamp: day('09-12'), content: 'The user asked for a weekly summary of GPU spend every Monday morning, broken down by model and by container hours.' },
  { id: 'm8', score: 0.29, timestamp: day('08-30'), content: 'Every dashboard should default to dark mode, and charts should use the same colors across the product so they read consistently.' },
  { id: 'm9', score: 0.21, timestamp: day('07-04'), content: 'The user is based in New Delhi and usually works late evenings IST, so async updates are preferred over meetings.' },
  { id: 'm10', score: 0.18, timestamp: day('06-11'), content: 'Hosting was tried on Replicate first, but the team moved off it because of pricing at their volume of requests.' },
  { id: 'm11', score: 0.12, timestamp: day('05-20'), content: 'The user has a cat named Momo who sometimes shows up in screen recordings and product demo videos.' },
  { id: 'm12', score: 0.08, timestamp: day('04-01'), content: 'The user watched a conference talk about vector databases and saved the slides for later reading.' },
];

const query = 'why is the 3D generation slow and what did we decide about the GPU?';
const sendAll = chunks.reduce((n, c) => n + estimateTokens(c.content), 0);

// CABAR, capped-adaptive (the recommended default): adaptive early stop, never more than maxUnits.
const cabar = CabarSelector.select(chunks, query, { now, adaptive: true, capToMaxUnits: true });
console.log('CABAR selected:', cabar.selected.map((u) => u.id).join(', '));
console.log('CABAR tail summary:\n' + cabar.tailSummary);
console.log(`tokens: send-all ${sendAll} → cabar ${cabar.stats.selectedTokens} selected + ${cabar.stats.tailSummaryTokens} tail\n`);

// Why each chunk was kept, tailed or dropped.
const explained = CabarSelector.select(chunks, query, { now, explain: true });
for (const d of explained.decisions!) console.log(`${d.id.padEnd(4)} ${d.status.padEnd(8)} ${d.reason}`);

// The prompt text.
console.log('\n--- context ---\n' + toContext(explained) + '\n');

// Prism: same idea, but each chunk can also be sent as an extract, its claims, or a one-line mention.
const prism = PrismSelector.select(chunks, query, { now, budgetTokens: 150 });
for (const s of prism.selected) console.log(`prism ${s.unit.id} @ ${s.fidelity}: ${s.rendered}`);
console.log(`tokens: send-all ${sendAll} → prism ${prism.stats.selectedTokens} selected (budget 150) + ${prism.stats.tailTokens} tail`);
