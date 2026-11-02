// 실험 A2 — 규모가 커지면 언제 벡터 DB 가 이기나: 실제 청크 2,551개에 "방해 벡터"(실제 벡터에 잡음을 섞어 정규화한 가짜 조문)를 붙여
// 1x · 10x · 40x · 100x 로 늘리고, 메모리 전수 스캔 vs Qdrant HNSW 의 임베딩 검색 지연과 HNSW 정확도(정확 검색 top-10 과 겹침)를 잰다.
//   node eval/exp_scale.mjs [--scales 1,10,40,100]
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { QdrantClient } from '@qdrant/js-client-rest';
import { buildIndex, DEFAULTS } from '../src/index.mjs';
import { embedQueries } from '../src/embed.mjs';
import { rewriteAll, expand } from '../src/rewrite.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const SCALES = arg('scales', '1,10,40,100').split(',').map(Number);
const qa = readFileSync(new URL('./qa.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const idx = await buildIndex({ model: DEFAULTS.model, strategy: DEFAULTS.strategy });
const N0 = idx.chunks.length, D = idx.dim;
const rws = await rewriteAll(qa.map((q) => q.q));
const qv = await embedQueries(DEFAULTS.model, qa.map((q, i) => expand(q.q, rws[i])));
const Q = qa.length;

let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
function grow(scale) { // 원본 + (scale-1)배의 방해 벡터
  const n = N0 * scale, v = new Float32Array(n * D); v.set(idx.vecs);
  for (let i = N0; i < n; i++) { const src = (i % N0) * D, o = i * D; let s = 0; for (let j = 0; j < D; j++) { const x = idx.vecs[src + j] + 0.06 * rnd(); v[o + j] = x; s += x * x; } s = 1 / Math.sqrt(s); for (let j = 0; j < D; j++) v[o + j] *= s; }
  return { n, v };
}
function scanTop(v, n, qi, k = 10) {
  const q = qv.vecs.subarray(qi * D, (qi + 1) * D), best = new Float64Array(k).fill(-Infinity), id = new Int32Array(k).fill(-1);
  for (let c = 0; c < n; c++) { let x = 0; const o = c * D; for (let j = 0; j < D; j++) x += v[o + j] * q[j]; if (x > best[k - 1]) { let p = k - 1; while (p > 0 && best[p - 1] < x) { best[p] = best[p - 1]; id[p] = id[p - 1]; p--; } best[p] = x; id[p] = c; } }
  return [...id];
}
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
const qd = new QdrantClient({ url: 'http://localhost:6333', checkCompatibility: false });
const rows = [];
for (const scale of SCALES) {
  const { n, v } = grow(scale);
  // 메모리 스캔
  const scanLat = [], exact = [];
  for (let i = 0; i < Q; i++) { const t0 = performance.now(); exact.push(scanTop(v, n, i)); scanLat.push(performance.now() - t0); }
  // Qdrant 적재 + HNSW
  const COL = `scale_${scale}`;
  try { await qd.deleteCollection(COL); } catch {}
  await qd.createCollection(COL, { vectors: { size: D, distance: 'Dot', on_disk: false }, hnsw_config: { m: 16, ef_construct: 128 }, optimizers_config: { indexing_threshold: 1000 } });
  const t0 = Date.now();
  for (let s = 0; s < n; s += 512) { const pts = []; for (let i = s; i < Math.min(n, s + 512); i++) pts.push({ id: i, vector: Array.from(v.subarray(i * D, (i + 1) * D)) }); await qd.upsert(COL, { wait: false, points: pts }); }
  for (let k = 0; k < 1200; k++) { const info = await qd.getCollection(COL); if (info.status === 'green' && info.points_count >= n) break; await new Promise((r) => setTimeout(r, 1000)); }
  const loadS = (Date.now() - t0) / 1000;
  const qLat = []; let overlap = 0;
  for (let i = 0; i < Q; i++) {
    const t1 = performance.now();
    const r = await qd.search(COL, { vector: Array.from(qv.vecs.subarray(i * D, (i + 1) * D)), limit: 10, with_payload: false, params: { hnsw_ef: 128 } });
    qLat.push(performance.now() - t1);
    const E = new Set(exact[i]); overlap += r.filter((p) => E.has(p.id)).length / 10;
  }
  const info = await qd.getCollection(COL);
  const row = { scale, chunks: n, matrixMB: +(n * D * 4 / 1048576).toFixed(1), scan_ms: { p50: +pct(scanLat, 0.5).toFixed(2), p95: +pct(scanLat, 0.95).toFixed(2) }, qdrant_ms: { p50: +pct(qLat, 0.5).toFixed(2), p95: +pct(qLat, 0.95).toFixed(2) }, hnsw_recall_at10: +(overlap / Q).toFixed(4), qdrant_load_s: +loadS.toFixed(1), indexed: info.indexed_vectors_count };
  rows.push(row); console.log(JSON.stringify(row));
  await qd.deleteCollection(COL);
}
writeFileSync(new URL('./results/exp_scale.json', import.meta.url), JSON.stringify({ date: new Date().toISOString().slice(0, 10), queries: Q, note: '방해 벡터 = 실제 청크 벡터 + 잡음(σ≈0.017/차원) 후 정규화. 실제 법령이 아니라 지연 · 근사 오차 측정용', rows }, null, 1));
