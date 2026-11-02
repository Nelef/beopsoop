// 인덱스 = 청크 + BM25 + 임베딩 행렬. 임베딩은 (모델, 청킹 설정, 청크 내용 해시)로 디스크에 캐시한다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadArticles, chunkArticles } from './chunk.mjs';
import { BM25 } from './bm25.mjs';
import { embedPassages, embedQueries } from './embed.mjs';

// 평가(dev 65문항)로 정한 기본 설정 — eval/README 참고
export const DEFAULTS = { model: 'bge-m3', strategy: 'article', w: [1, 1], llm: 'sonnet' }; // w = [BM25, 임베딩]. e5-small 시절엔 [3, 1] 이 최적이었다 — 모델이 바뀌면 가중도 다시 잰다
const CACHE = new URL('../data/cache/', import.meta.url).pathname;

export async function buildIndex({ model = 'e5-small', strategy = 'article', maxChars = 1200, minChars = 80, withChapter = true, dense = true, log = () => {} } = {}) {
  const chunks = chunkArticles(loadArticles(), { strategy, maxChars, minChars, withChapter });
  const idx = { model, strategy, chunks, bm25: new BM25(chunks.map((c) => c.indexText)), vecs: null, dim: 0 };
  if (!dense) return idx;
  const hash = createHash('sha1').update(chunks.map((c) => c.indexText).join('\u0001')).digest('hex').slice(0, 10);
  const f = `${CACHE}${model}-${hash}.bin`;
  idx.cacheFile = f;
  if (existsSync(f)) {
    const buf = readFileSync(f);
    idx.vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    idx.dim = idx.vecs.length / chunks.length;
    log(`임베딩 캐시 사용 ${f}`);
  } else {
    const t0 = Date.now();
    const { vecs, dim } = await embedPassages(model, chunks.map((c) => c.indexText), (d, n) => d % 160 === 0 && log(`임베딩 ${d}/${n}`));
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(f, Buffer.from(vecs.buffer));
    idx.vecs = vecs; idx.dim = dim;
    log(`임베딩 ${chunks.length}개 ${((Date.now() - t0) / 1000).toFixed(0)}초 → ${f}`);
  }
  return idx;
}

const topK = (scores, k) => Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, k);

function denseScores(idx, qvec) {
  const s = new Float64Array(idx.chunks.length), d = idx.dim;
  for (let i = 0; i < s.length; i++) { let x = 0; const o = i * d; for (let j = 0; j < d; j++) x += idx.vecs[o + j] * qvec[j]; s[i] = x; }
  return s;
}

/**
 * mode: bm25 | dense | hybrid(RRF). 반환: [{chunk, score, rank}] — 같은 조의 청크는 가장 높은 것 하나만(dedupe).
 * hybrid 는 두 순위를 Reciprocal Rank Fusion(k=rrfK)으로 합친다. w 는 [bm25 가중, dense 가중].
 */
export async function search(idx, query, { mode = 'hybrid', k = 5, pool = 50, rrfK = 60, w = [1, 1], qvec } = {}) {
  let order, score;
  const getQ = async () => qvec ?? (await embedQueries(idx.model, [query])).vecs;
  if (mode === 'bm25') { const s = idx.bm25.scores(query); order = topK(s, pool); score = (i) => s[i]; }
  else if (mode === 'dense') { const s = denseScores(idx, await getQ()); order = topK(s, pool); score = (i) => s[i]; }
  else {
    const sb = idx.bm25.scores(query), sd = denseScores(idx, await getQ());
    const fused = new Map();
    topK(sb, pool).forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + w[0] / (rrfK + r + 1)));
    topK(sd, pool).forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + w[1] / (rrfK + r + 1)));
    order = [...fused.keys()].sort((a, b) => fused.get(b) - fused.get(a)); score = (i) => fused.get(i);
  }
  const seen = new Set(), hits = [];
  for (const i of order) {
    const c = idx.chunks[i];
    if (seen.has(c.articleKey)) continue;
    seen.add(c.articleKey);
    hits.push({ chunk: c, score: score(i), rank: hits.length + 1 });
    if (hits.length >= k) break;
  }
  return hits;
}
