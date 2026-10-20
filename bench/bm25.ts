/** Plain BM25 over lowercase word tokens: the deliberately simple retriever both benchmarks use. */
export const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export function bm25(docs: string[], query: string, k1 = 1.2, b = 0.75): number[] {
  const toks = docs.map(words);
  const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(1, toks.length);
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(words(query))];
  return toks.map((t) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const n = df.get(w)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg)));
    }
    return s;
  });
}
