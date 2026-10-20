/**
 * Helpers around a selection result: turn it into prompt text, and compare it
 * with what you send today (shadow mode).
 */
import { CabarSelector, type CabarSelectOptions, type CabarSelectResult, type CabarUnit } from './cabar';
import type { PrismSelectResult } from './prism';
import { CHAR4_COUNTER } from './shared';

export interface ToContextOptions {
  /** Separator between selected units. Default: a blank line. */
  separator?: string;
  /** Heading put above the tail. Default: "Other possibly relevant notes:". Pass '' for none. */
  tailHeading?: string;
  /** Wraps each selected unit, e.g. to add ids or XML tags. Default: the text as is. */
  format?: (text: string, id: string) => string;
}

function isPrism(r: CabarSelectResult | PrismSelectResult): r is PrismSelectResult {
  return 'tailBlock' in r;
}

/** Joins a CABAR or Prism result into one string to put in the prompt. */
export function toContext(result: CabarSelectResult | PrismSelectResult, opts: ToContextOptions = {}): string {
  const separator = opts.separator ?? '\n\n';
  const heading = opts.tailHeading ?? 'Other possibly relevant notes:';
  const format = opts.format ?? ((text: string) => text);
  const parts = isPrism(result)
    ? result.selected.map((s) => format(s.rendered, s.unit.id))
    : result.selected.map((u) => format(u.content, u.id));
  const tail = isPrism(result) ? result.tailBlock : result.tailSummary;
  if (tail) parts.push(heading ? `${heading}\n${tail}` : tail);
  return parts.join(separator);
}

export interface ShadowReport {
  /** Tokens of every unit you passed in (what "send everything" costs). */
  sendAllTokens: number;
  /** Tokens CABAR would send: selected + tail. */
  cabarTokens: number;
  /** 1 − cabarTokens / sendAllTokens. */
  savedFraction: number;
  selectedIds: string[];
  tailIds: string[];
  droppedIds: string[];
  result: CabarSelectResult;
}

/**
 * Shadow mode: run CABAR next to your current pipeline without changing what
 * you send. Log the report, compare answers, then switch when you trust it.
 */
export function shadowReport(units: CabarUnit[], query: string, opts: CabarSelectOptions = {}): ShadowReport {
  const counter = opts.tokenCounter ?? CHAR4_COUNTER;
  const result = CabarSelector.select(units, query, opts);
  const sendAllTokens = units.reduce((n, u) => n + counter.count(u.content), 0);
  const cabarTokens = result.stats.selectedTokens + result.stats.tailSummaryTokens;
  const kept = new Set([...result.selected, ...result.tail].map((u) => u.id));
  return {
    sendAllTokens,
    cabarTokens,
    savedFraction: sendAllTokens === 0 ? 0 : 1 - cabarTokens / sendAllTokens,
    selectedIds: result.selected.map((u) => u.id),
    tailIds: result.tail.map((u) => u.id),
    droppedIds: units.filter((u) => !kept.has(u.id)).map((u) => u.id),
    result,
  };
}
