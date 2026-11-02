// 검색 평가: 설정(모델 · 청킹 · 검색 방식)별로 같은 질문 세트에 돌려 비교한다.
//   node eval/run.mjs [--split dev|test|all] [--models e5-small,e5-base] [--strategies article,paragraph] [--modes bm25,dense,hybrid] [--out results/x.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildIndex, search } from '../src/index.mjs';
import { embedQueries } from '../src/embed.mjs';
import { scoreQuery, mean } from './metrics.mjs';
import { rewriteAll, expand } from '../src/rewrite.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const split = arg('split', 'dev');
const models = arg('models', 'e5-small').split(',');
const strategies = arg('strategies', 'article').split(',');
const modes = arg('modes', 'bm25,dense,hybrid').split(',');
const out = arg('out', '');
const W = arg('w', '1,1').split(',').map(Number);
const useRewrite = process.argv.includes('--rewrite');

const qa = readFileSync(new URL('./qa.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((q) => split === 'all' || q.split === split);
console.log(`질문 ${qa.length}개 (split=${split})${useRewrite ? ' + 질의 재작성' : ''}\n`);
// 재작성은 검색에 쓰는 문장만 바꾼다. 정답 · 지표는 그대로.
const texts = useRewrite ? (await rewriteAll(qa.map((q) => q.q))).map((r, i) => expand(qa[i].q, r)) : qa.map((q) => q.q);

const f = (x) => x.toFixed(3);
const rows = [];
for (const model of models) {
  const qvecs = modes.some((m) => m !== 'bm25') ? await embedQueries(model, texts) : null;
  for (const strategy of strategies) {
    const idx = await buildIndex({ model, strategy, dense: !!qvecs, log: () => {} });
    for (const mode of modes) {
      const per = [];
      for (let i = 0; i < qa.length; i++) {
        const q = qa[i];
        const qvec = qvecs && qvecs.vecs.subarray(i * qvecs.dim, (i + 1) * qvecs.dim);
        const hits = await search(idx, texts[i], { mode, k: 10, qvec, w: W });
        per.push({ q, s: scoreQuery(hits.map((h) => h.chunk.articleKey), q.gold), top: hits.slice(0, 3).map((h) => h.chunk.label) });
      }
      const m = mean(per.map((p) => p.s));
      const grp = (q) => (['전자금융', '개인정보', '신용정보'].includes(q.law) ? '금융' : '생활');
      const byGroup = {};
      for (const g of ['금융', '생활']) { const ps = per.filter((p) => grp(p.q) === g); if (ps.length) byGroup[g] = { n: ps.length, ...mean(ps.map((p) => p.s)) }; }
      const byType = {};
      for (const t of new Set(qa.map((q) => q.type))) byType[t] = mean(per.filter((p) => p.q.type === t).map((p) => p.s));
      rows.push({ model: mode === 'bm25' ? '-' : model, strategy, mode: (useRewrite ? mode + '+rw' : mode) + (mode === 'hybrid' && W.join() !== '1,1' ? `(w${W.join(':')})` : ''), chunks: idx.chunks.length, ...m, byType, byGroup, misses: per.filter((p) => p.s['hit@5'] === 0).map((p) => ({ id: p.q.id, q: p.q.q, gold: p.q.gold, top: p.top })) });
    }
  }
}
const uniq = new Map(); for (const r of rows) uniq.set(`${r.model}|${r.strategy}|${r.mode}`, r);
console.log('model      strategy   mode    chunks  hit@1  hit@3  hit@5  rec@5  rec@10  MRR   | 금융 hit@5/MRR  생활 hit@5/MRR');
for (const r of uniq.values())
  console.log(`${r.model.padEnd(10)} ${r.strategy.padEnd(10)} ${r.mode.padEnd(7)} ${String(r.chunks).padStart(6)}  ${f(r['hit@1'])}  ${f(r['hit@3'])}  ${f(r['hit@5'])}  ${f(r['recall@5'])}  ${f(r['recall@10'])}  ${f(r.mrr)}   | ${r.byGroup['금융'] ? f(r.byGroup['금융']['hit@5']) + '/' + f(r.byGroup['금융'].mrr) : '-'}  ${r.byGroup['생활'] ? f(r.byGroup['생활']['hit@5']) + '/' + f(r.byGroup['생활'].mrr) : '-'}`);
if (out) { mkdirSync(new URL('./results/', import.meta.url).pathname, { recursive: true }); writeFileSync(new URL(`./results/${out}`, import.meta.url), JSON.stringify({ split, n: qa.length, date: new Date().toISOString().slice(0, 10), rows: [...uniq.values()] }, null, 1)); }
