// 실험 A — 벡터 DB 비교: 메모리 전수 스캔(현재) vs Qdrant vs pgvector, 정확 검색 vs HNSW, 법령 메타데이터 필터 유무.
// 같은 bge-m3 벡터 · 같은 질문 126개(재작성 캐시 사용) · 같은 BM25 + RRF 로 맞추고, 바꾸는 것은 "임베딩 상위 50개를 어디서 어떻게 찾나"뿐이다.
//   docker run -d --name finlaw-qdrant -p 6333:6333 qdrant/qdrant:v1.15.4
//   docker run -d --name finlaw-pg -e POSTGRES_PASSWORD=finlaw -e POSTGRES_DB=finlaw -p 5433:5432 pgvector/pgvector:pg16
//   node eval/exp_vectordb.mjs [--out exp_vectordb.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { QdrantClient } from '@qdrant/js-client-rest';
import pg from 'pg';
import { buildIndex, DEFAULTS } from '../src/index.mjs';
import { embedQueries } from '../src/embed.mjs';
import { rewriteAll, expand } from '../src/rewrite.mjs';
import { scoreQuery, mean } from './metrics.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const OUT = arg('out', '');
const POOL = 50, K = 10, RRF = 60;
const qa = readFileSync(new URL('./qa.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const idx = await buildIndex({ model: DEFAULTS.model, strategy: DEFAULTS.strategy });
const N = idx.chunks.length, D = idx.dim;
const rws = await rewriteAll(qa.map((q) => q.q));
const texts = qa.map((q, i) => expand(q.q, rws[i]));
const qv = await embedQueries(DEFAULTS.model, texts);
const qvec = (i) => Array.from(qv.vecs.subarray(i * qv.dim, (i + 1) * qv.dim));
const vec = (i) => Array.from(idx.vecs.subarray(i * D, (i + 1) * D));

// 재작성이 고른 법령 이름 → 청크의 law 값(시행령 포함). 띄어쓰기 차이("개인정보보호법")는 정규화
const norm = (s) => s.replace(/\s+/g, '');
const LAWS = [...new Set(idx.chunks.map((c) => c.law))];
const lawsOf = (i) => { const want = rws[i].laws.map(norm); return LAWS.filter((l) => want.some((w) => norm(l) === w || norm(l) === w + '시행령')); };

// ── 백엔드: dense(i, filterLaws) → 청크 번호 상위 POOL 개 ──
const order = (s) => Array.from(s.keys()).sort((a, b) => s[b] - s[a]).slice(0, POOL);
const scan = {
  name: 'memory-scan(현재)', setup: async () => {}, footprint: async () => `${(idx.vecs.byteLength / 1048576).toFixed(1)}MB 행렬(프로세스 메모리)`,
  dense: async (i, laws) => {
    const q = qv.vecs.subarray(i * qv.dim, (i + 1) * qv.dim), s = new Float64Array(N).fill(-Infinity);
    for (let c = 0; c < N; c++) { if (laws && !laws.includes(idx.chunks[c].law)) continue; let x = 0; const o = c * D; for (let j = 0; j < D; j++) x += idx.vecs[o + j] * q[j]; s[c] = x; }
    return order(s).filter((c) => s[c] > -Infinity);
  },
};

const qd = new QdrantClient({ url: 'http://localhost:6333' });
const COL = 'finlaw';
const qdrant = (exact) => ({
  name: exact ? 'qdrant(exact)' : 'qdrant(HNSW m16 ef128)',
  setup: async () => {
    if (!exact) return; // 두 번째 백엔드는 같은 컬렉션을 쓴다
  },
  footprint: async () => { const info = await qd.getCollection(COL); const mem = execSync("docker stats --no-stream --format '{{.MemUsage}}' finlaw-qdrant").toString().trim(); return `points ${info.points_count} · indexed ${info.indexed_vectors_count} · 컨테이너 메모리 ${mem}`; },
  dense: async (i, laws) => {
    const r = await qd.search(COL, { vector: qvec(i), limit: POOL, with_payload: false, params: exact ? { exact: true } : { hnsw_ef: 128 }, ...(laws ? { filter: { must: [{ key: 'law', match: { any: laws } }] } } : {}) });
    return r.map((p) => p.id);
  },
});

const db = new pg.Client({ host: 'localhost', port: 5433, user: 'postgres', password: 'finlaw', database: 'finlaw' });
const pgv = (exact) => ({
  name: exact ? 'pgvector(exact)' : 'pgvector(HNSW m16 ef_search128)',
  setup: async () => { await db.query(`SET enable_indexscan = ${exact ? 'off' : 'on'}`); await db.query('SET hnsw.ef_search = 128'); },
  footprint: async () => { const r = await db.query("select pg_size_pretty(pg_total_relation_size('chunks')) t, pg_size_pretty(pg_relation_size('chunks_emb_hnsw')) i"); const mem = execSync("docker stats --no-stream --format '{{.MemUsage}}' finlaw-pg").toString().trim(); return `테이블+인덱스 ${r.rows[0].t}(HNSW ${r.rows[0].i}) · 컨테이너 메모리 ${mem}`; },
  dense: async (i, laws) => {
    const v = `[${qvec(i).join(',')}]`;
    const r = laws ? await db.query('select id from chunks where law = any($2) order by emb <#> $1 limit $3', [v, laws, POOL])
      : await db.query('select id from chunks order by emb <#> $1 limit $2', [v, POOL]);
    return r.rows.map((x) => x.id);
  },
});

// ── 적재(시간 측정) ──
const load = {};
{
  let t = Date.now();
  try { await qd.deleteCollection(COL); } catch {}
  await qd.createCollection(COL, { vectors: { size: D, distance: 'Dot' }, hnsw_config: { m: 16, ef_construct: 128 }, optimizers_config: { indexing_threshold: 1000 } });
  await qd.createPayloadIndex(COL, { field_name: 'law', field_schema: 'keyword' });
  for (let s = 0; s < N; s += 256) await qd.upsert(COL, { wait: true, points: idx.chunks.slice(s, s + 256).map((c, j) => ({ id: s + j, vector: vec(s + j), payload: { law: c.law, key: c.articleKey } })) });
  for (let k = 0; k < 120; k++) { const info = await qd.getCollection(COL); if (info.status === 'green' && info.indexed_vectors_count >= N) break; await new Promise((r) => setTimeout(r, 500)); }
  load.qdrant = Date.now() - t;
  t = Date.now();
  await db.connect();
  await db.query('create extension if not exists vector');
  await db.query('drop table if exists chunks');
  await db.query(`create table chunks (id int primary key, law text, key text, emb vector(${D}))`);
  for (let s = 0; s < N; s += 200) {
    const rows = idx.chunks.slice(s, s + 200), vals = [], params = [];
    rows.forEach((c, j) => { const b = j * 4; vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`); params.push(s + j, c.law, c.articleKey, `[${vec(s + j).join(',')}]`); });
    await db.query(`insert into chunks values ${vals.join(',')}`, params);
  }
  await db.query('create index chunks_emb_hnsw on chunks using hnsw (emb vector_ip_ops) with (m = 16, ef_construction = 128)');
  await db.query('create index on chunks(law)');
  await db.query('analyze chunks');
  load.pgvector = Date.now() - t;
}

// ── 평가 ──
function fuse(lists) { // lists: [[청크번호...], 가중]
  const f = new Map();
  for (const [ids, w] of lists) ids.forEach((c, r) => f.set(c, (f.get(c) ?? 0) + w / (RRF + r + 1)));
  const seen = new Set(), keys = [];
  for (const c of [...f.keys()].sort((a, b) => f.get(b) - f.get(a))) { const k = idx.chunks[c].articleKey; if (seen.has(k)) continue; seen.add(k); keys.push(k); if (keys.length >= K) break; }
  return keys;
}
const bm = qa.map((_, i) => order(idx.bm25.scores(texts[i])));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f3 = (x) => x.toFixed(3);
const results = [];
const backends = [scan, qdrant(false), qdrant(true), pgv(false), pgv(true)];
for (const b of backends) {
  await b.setup();
  for (const variant of ['hybrid', 'hybrid+law-filter']) {
    const per = [], lat = [];
    for (let i = 0; i < qa.length; i++) {
      const t0 = performance.now();
      const dense = await b.dense(i, null);
      lat.push(performance.now() - t0);
      const lists = [[bm[i], 1], [dense, 1]];
      if (variant !== 'hybrid') { const laws = lawsOf(i); if (laws.length) lists.push([await b.dense(i, laws), 1]); }
      per.push({ q: qa[i], s: scoreQuery(fuse(lists), qa[i].gold) });
    }
    const by = (sp) => mean(per.filter((p) => p.q.split === sp).map((p) => p.s));
    const grp = (q) => (['전자금융', '개인정보', '신용정보'].includes(q.law) ? '금융' : '생활');
    const life = mean(per.filter((p) => grp(p.q) === '생활').map((p) => p.s));
    const row = { backend: b.name, variant, dev: by('dev'), test: by('test'), life_all: life, dense_ms: { p50: pct(lat, 0.5), p95: pct(lat, 0.95) } };
    results.push(row);
    console.log(`${b.name.padEnd(32)} ${variant.padEnd(18)} dev hit@5 ${f3(row.dev['hit@5'])} MRR ${f3(row.dev.mrr)} | test hit@5 ${f3(row.test['hit@5'])} rec@10 ${f3(row.test['recall@10'])} MRR ${f3(row.test.mrr)} | 생활 hit@5 ${f3(life['hit@5'])} | dense p50 ${row.dense_ms.p50.toFixed(2)}ms p95 ${row.dense_ms.p95.toFixed(2)}ms`);
  }
}
const foot = {}; for (const b of [scan, qdrant(false), pgv(false)]) foot[b.name] = await b.footprint();
console.log('\n적재 시간(ms)', load); console.log('용량', foot);
// HNSW 와 정확 검색의 top-50 이 얼마나 같은가(근사 오차)
const overlap = {};
for (const [a, e] of [[qdrant(false), qdrant(true)], [pgv(false), pgv(true)]]) {
  let same = 0;
  await a.setup(); const A = []; for (let i = 0; i < qa.length; i++) A.push(await a.dense(i, null));
  await e.setup(); for (let i = 0; i < qa.length; i++) { const E = new Set((await e.dense(i, null)).slice(0, 10)); same += A[i].slice(0, 10).filter((x) => E.has(x)).length / 10; }
  overlap[a.name] = +(same / qa.length).toFixed(4);
}
console.log('HNSW top-10 이 정확 검색 top-10 과 겹치는 비율', overlap);
await db.end();
if (OUT) writeFileSync(new URL(`./results/${OUT}`, import.meta.url), JSON.stringify({ date: new Date().toISOString().slice(0, 10), n: qa.length, chunks: N, dim: D, load_ms: load, footprint: foot, hnsw_overlap_top10: overlap, results }, null, 1));
