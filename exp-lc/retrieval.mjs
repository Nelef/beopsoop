// 실험 B1 — LangChain 표준 검색 부품을 그대로 쓰면? (같은 청크 · 같은 bge-m3 벡터 · 같은 재작성 질의)
//   우리 BM25(어절 문자 bigram) vs LangChain BM25Retriever(기본: 띄어쓰기 토큰 · 부분 문자열 매칭 · 길이는 /\w+/ 로 셈)
//   우리 하이브리드(RRF 1:1) vs LangChain EnsembleRetriever(BM25Retriever + MemoryVectorStore, 가중 RRF)
//   cd exp-lc && node retrieval.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Document } from '@langchain/core/documents';
import { Embeddings } from '@langchain/core/embeddings';
import { BM25Retriever } from '@langchain/community/retrievers/bm25';
import { EnsembleRetriever } from '@langchain/classic/retrievers/ensemble';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { buildIndex, search, DEFAULTS } from '../src/index.mjs';
import { embedQueries } from '../src/embed.mjs';
import { tokenize } from '../src/bm25.mjs';
import { rewriteAll, expand } from '../src/rewrite.mjs';
import { scoreQuery, mean } from '../eval/metrics.mjs';

const qa = readFileSync(new URL('../eval/qa.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const idx = await buildIndex({ model: DEFAULTS.model, strategy: DEFAULTS.strategy });
const rws = await rewriteAll(qa.map((q) => q.q));
const texts = qa.map((q, i) => expand(q.q, rws[i]));
const qv = await embedQueries(DEFAULTS.model, texts);
const qvecOf = new Map(texts.map((t, i) => [t, Array.from(qv.vecs.subarray(i * qv.dim, (i + 1) * qv.dim))]));

// 쿼리 임베딩은 미리 계산해 둔 같은 벡터를 돌려준다(모델 차이를 없애고 검색 부품만 비교)
class Precomputed extends Embeddings { async embedQuery(t) { return qvecOf.get(t); } async embedDocuments() { throw new Error('미리 계산된 벡터만 씀'); } }
const docs = idx.chunks.map((c) => new Document({ pageContent: c.indexText, metadata: { key: c.articleKey } }));
const vs = new MemoryVectorStore(new Precomputed({}));
await vs.addVectors(idx.chunks.map((_, i) => Array.from(idx.vecs.subarray(i * idx.dim, (i + 1) * idx.dim))), docs);

const lcBM25 = BM25Retriever.fromDocuments(docs, { k: 50 });
const lcBM25bigram = BM25Retriever.fromDocuments(docs, { k: 50 });
lcBM25bigram.preprocessFunc = (t) => tokenize(t); // 토크나이저만 우리 것으로 바꿔 끼움
const lcVec = vs.asRetriever({ k: 50 });
const ens = (bm) => new EnsembleRetriever({ retrievers: [bm, lcVec], weights: [0.5, 0.5] });

const keys10 = (docsOut) => { const seen = []; for (const d of docsOut) { const k = d.metadata.key; if (!seen.includes(k)) seen.push(k); if (seen.length >= 10) break; } return seen; };
const ours = (mode) => async (i) => (await search(idx, texts[i], { mode, k: 10, w: DEFAULTS.w, qvec: qv.vecs.subarray(i * qv.dim, (i + 1) * qv.dim) })).map((h) => h.chunk.articleKey);
const lc = (r) => async (i) => keys10(await r.invoke(texts[i]));

const systems = [
  ['ours BM25(문자 bigram)', ours('bm25')],
  ['LangChain BM25Retriever(기본)', lc(lcBM25)],
  ['LangChain BM25Retriever(+우리 bigram 토크나이저)', lc(lcBM25bigram)],
  ['ours dense(bge-m3)', ours('dense')],
  ['LangChain MemoryVectorStore', lc(lcVec)],
  ['ours hybrid RRF 1:1(서비스)', ours('hybrid')],
  ['LangChain Ensemble(BM25 기본 + 벡터)', lc(ens(lcBM25))],
  ['LangChain Ensemble(BM25 bigram + 벡터)', lc(ens(lcBM25bigram))],
];
const f3 = (x) => x.toFixed(3), pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
const rows = [];
for (const [name, fn] of systems) {
  const per = [], lat = [];
  for (let i = 0; i < qa.length; i++) { const t0 = performance.now(); const keys = await fn(i); lat.push(performance.now() - t0); per.push({ q: qa[i], s: scoreQuery(keys, qa[i].gold) }); }
  const by = (sp) => mean(per.filter((p) => p.q.split === sp).map((p) => p.s));
  const r = { name, dev: by('dev'), test: by('test'), ms: { p50: pct(lat, 0.5), p95: pct(lat, 0.95) } };
  rows.push(r);
  console.log(`${name.padEnd(46)} dev hit@5 ${f3(r.dev['hit@5'])} MRR ${f3(r.dev.mrr)} | test hit@5 ${f3(r.test['hit@5'])} rec@10 ${f3(r.test['recall@10'])} MRR ${f3(r.test.mrr)} | p50 ${r.ms.p50.toFixed(1)}ms p95 ${r.ms.p95.toFixed(1)}ms`);
}
writeFileSync(new URL('../eval/results/exp_langchain_retrieval.json', import.meta.url), JSON.stringify({ date: new Date().toISOString().slice(0, 10), n: qa.length, rows }, null, 1));
