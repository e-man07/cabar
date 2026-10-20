import { describe, it, expect } from 'vitest';
import { CabarSelector, CabarUnit } from '../src/cabar';
import { PrismSelector } from '../src/prism';
import { toContext, shadowReport } from '../src/context';
import { estimateTokens } from '../src/shared';

const units: CabarUnit[] = [
  { id: 'a', content: 'The deploy target for gpu workers is modal.', score: 1 },
  { id: 'b', content: 'Invoices are sent on the first Monday of each month.', score: 0.7 },
  { id: 'c', content: 'Dark mode is the default theme in every dashboard.', score: 0.4 },
  { id: 'z', content: 'The user watched a talk about vector databases.', score: 0.05 },
];

describe('toContext', () => {
  it('joins selected units and puts the tail under a heading', () => {
    const r = CabarSelector.select(units, 'deploy', { maxUnits: 2 });
    const text = toContext(r);
    for (const u of r.selected) expect(text).toContain(u.content);
    expect(text).toContain('Other possibly relevant notes:\n' + r.tailSummary);
  });

  it('supports a custom format and no heading', () => {
    const r = CabarSelector.select(units, 'deploy', { maxUnits: 1 });
    const text = toContext(r, { format: (t, id) => `<memory id="${id}">${t}</memory>`, tailHeading: '' });
    expect(text.startsWith(`<memory id="${r.selected[0]!.id}">`)).toBe(true);
    expect(text).not.toContain('Other possibly relevant notes');
  });

  it('uses the rendered text for Prism results', () => {
    const r = PrismSelector.select(units, 'deploy', { budgetTokens: 30 });
    const text = toContext(r);
    for (const s of r.selected) expect(text).toContain(s.rendered);
  });

  it('returns an empty string for an empty pool', () => {
    expect(toContext(CabarSelector.select([], 'q'))).toBe('');
  });
});

describe('shadowReport', () => {
  it('compares send-all with what CABAR would send', () => {
    const rep = shadowReport(units, 'deploy', { maxUnits: 2 });
    expect(rep.sendAllTokens).toBe(units.reduce((n, u) => n + estimateTokens(u.content), 0));
    expect(rep.cabarTokens).toBe(rep.result.stats.selectedTokens + rep.result.stats.tailSummaryTokens);
    expect(rep.savedFraction).toBeCloseTo(1 - rep.cabarTokens / rep.sendAllTokens, 10);
    expect(rep.droppedIds).toEqual(['z']);
    expect([...rep.selectedIds, ...rep.tailIds, ...rep.droppedIds].sort()).toEqual(['a', 'b', 'c', 'z']);
  });
});
