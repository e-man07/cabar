import { describe, it, expect } from 'vitest';
import { CabarSelector, CabarUnit } from '../src/cabar';

const units: CabarUnit[] = [
  { id: 'a', content: 'The deploy target for gpu workers is modal with an L40S card.', score: 1 },
  { id: 'a2', content: 'The deploy target for gpu workers is modal with an L40S card.', score: 0.9 },
  { id: 'b', content: 'Invoices are sent on the first Monday of each month.', score: 0.7 },
  { id: 'c', content: 'Dark mode is the default theme in every dashboard view.', score: 0.6 },
  { id: 'z', content: 'The user watched a talk about vector databases.', score: 0.05 },
];

describe('explain', () => {
  it('is off by default', () => {
    expect(CabarSelector.select(units, 'deploy').decisions).toBeUndefined();
  });

  it('gives one decision per unit with a reason', () => {
    const r = CabarSelector.select(units, 'where do gpu workers deploy', { explain: true, maxUnits: 2 });
    const d = Object.fromEntries(r.decisions!.map((x) => [x.id, x]));
    expect(r.decisions!.map((x) => x.id)).toEqual(units.map((u) => u.id));
    expect(d.a!.status).toBe('selected');
    expect(d.a2!.status).toBe('tail');
    expect(d.a2!.reason).toMatch(/redundant with a/);
    expect(d.a2!.redundantWith).toBe('a');
    expect(d.z!.status).toBe('dropped');
    expect(d.z!.reason).toMatch(/tauFloor/);
    const selectedIds = r.selected.map((u) => u.id).sort();
    expect(r.decisions!.filter((x) => x.status === 'selected').map((x) => x.id).sort()).toEqual(selectedIds);
  });

  it('reports maxUnits and budget limits', () => {
    const r = CabarSelector.select(units.slice(2, 4).concat(units[0]!), 'x', { explain: true, maxUnits: 1 });
    expect(r.decisions!.some((x) => /maxUnits \(1\) reached/.test(x.reason))).toBe(true);
    const tight = CabarSelector.select(units, 'x', { explain: true, budgetTokens: 16 });
    expect(tight.decisions!.some((x) => /doesn't fit/.test(x.reason))).toBe(true);
  });

  it('does not change the selection', () => {
    const plain = CabarSelector.select(units, 'deploy', { adaptive: true });
    const { decisions, ...explained } = CabarSelector.select(units, 'deploy', { adaptive: true, explain: true });
    expect(decisions).toBeDefined();
    expect(JSON.stringify(explained)).toBe(JSON.stringify(plain));
  });
});
