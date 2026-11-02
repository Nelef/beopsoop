// 의존성 없는 BM25. 한국어는 조사가 붙어 어절 그대로는 안 맞으므로 어절의 문자 bigram 으로 토큰화한다(형태소 분석기 없이도 recall 이 나온다).
export function tokenize(text) {
  const out = [];
  for (const w of String(text).toLowerCase().match(/[가-힣]+|[a-z0-9]+/g) ?? []) {
    if (w.length === 1) { out.push(w); continue; }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}

export class BM25 {
  constructor(docs, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.tf = docs.map((d) => { const m = new Map(); for (const t of tokenize(d)) m.set(t, (m.get(t) ?? 0) + 1); return m; });
    this.len = this.tf.map((m) => { let n = 0; for (const v of m.values()) n += v; return n; });
    this.avg = this.len.reduce((a, c) => a + c, 0) / docs.length;
    this.df = new Map();
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.N = docs.length;
  }
  scores(query) {
    const s = new Float64Array(this.N);
    for (const t of new Set(tokenize(query))) {
      const df = this.df.get(t); if (!df) continue;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < this.N; i++) {
        const f = this.tf[i].get(t); if (!f) continue;
        s[i] += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg));
      }
    }
    return s;
  }
}
