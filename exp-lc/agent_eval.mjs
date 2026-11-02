// 실험 B2 — LangGraph 에이전트형 RAG(Corrective RAG) vs 현재 한 번 검색 RAG. 같은 답변 프롬프트 · 같은 채점관 · 같은 질문(test 31 + 범위 밖 10).
//   에이전트: 재작성 → 검색 → [근거 판정 LLM: 답할 수 있나? 부족하면 새 검색어] → (부족하면 다시 검색, 최대 2번) → 답변
//   LLM 호출은 기존 claude -p 래퍼(개인 토큰 필수). LangGraph 는 흐름(상태 · 분기 · 반복)만 맡는다.
//   cd exp-lc && node agent_eval.mjs [--split test] [--systems baseline,agent] [--out x.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { buildIndex, search, DEFAULTS } from '../src/index.mjs';
import { answer, buildPrompt, refsOf } from '../src/answer.mjs';
import { rewrite, expand } from '../src/rewrite.mjs';
import { claudeJSON } from '../src/llm.mjs';
import { loadArticles } from '../src/chunk.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const split = arg('split', 'test'), SYSTEMS = arg('systems', 'baseline,agent').split(','), OUT = arg('out', 'exp_agent.json'), LLM = 'sonnet';
const qa = readFileSync(new URL('../eval/qa.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((q) => split === 'all' || q.split === split);
const oos = readFileSync(new URL('../eval/oos.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const arts = new Map(loadArticles().map((a) => [a.key, `${a.label}\n${[...a.lead, ...a.paras.flatMap((p) => p.lines)].join('\n')}`]));
const idx = await buildIndex({ model: DEFAULTS.model, strategy: DEFAULTS.strategy });

// ── 기준: 현재 서비스(재작성 → 하이브리드 k=5 → 참조 확장 → 답변) ──
async function baseline(q) {
  let calls = 0; const rw = await rewrite(q); // 재작성은 캐시(평가 재현성) — 두 시스템 동일 조건
  const hits = await search(idx, expand(q, rw), { mode: 'hybrid', k: 5, w: DEFAULTS.w });
  const a = await answer(idx, q, { hits, model: LLM }); calls++;
  return { ...a, calls };
}

// ── 에이전트: LangGraph StateGraph ──
const GRADE_SYS = `너는 법령 검색 결과 점검관이다. [근거] 조문만으로 [질문]의 핵심(결론 · 기간 · 금액 · 주체)에 답할 수 있는지 판정한다. 네 지식으로 답을 만들지 않는다.
- 답할 수 있으면 sufficient=true.
- 부족하면 sufficient=false, missing 에 빠진 정보를 한 줄로, new_query 에 그 정보를 담은 조문을 찾기 위한 **법령 용어 검색어**(조 번호 없이, 관련 법령 이름 포함 가능)를 쓴다.
- 질문이 생활 · 금융 법령 범위 밖(세금 · 노동 · 부동산 등)이면 sufficient=true(더 찾지 않음)로 둔다 — 답변 단계가 거절한다.`;
const GRADE_SCHEMA = { type: 'object', properties: { sufficient: { type: 'boolean' }, missing: { type: 'string' }, new_query: { type: 'string' } }, required: ['sufficient', 'missing', 'new_query'] };
const S = Annotation.Root({
  q: Annotation(), hits: Annotation({ reducer: (a, b) => b, default: () => [] }), queries: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  loops: Annotation({ reducer: (a, b) => b, default: () => 0 }), calls: Annotation({ reducer: (a, b) => a + b, default: () => 0 }),
  verdict: Annotation(), result: Annotation(),
});
const mergeHits = (old, add, max = 8) => { const seen = new Set(old.map((h) => h.chunk.articleKey)); const out = [...old]; for (const h of add) { if (out.length >= max) break; if (!seen.has(h.chunk.articleKey)) { seen.add(h.chunk.articleKey); out.push(h); } } return out.map((h, i) => ({ ...h, rank: i + 1 })); };
const graph = new StateGraph(S)
  .addNode('retrieve', async (s) => {
    if (s.loops === 0) { const rw = await rewrite(s.q); const hits = await search(idx, expand(s.q, rw), { mode: 'hybrid', k: 5, w: DEFAULTS.w }); return { hits, queries: [expand(s.q, rw)] }; }
    const nq = `${s.q} ${s.verdict.new_query}`; const more = await search(idx, nq, { mode: 'hybrid', k: 5, w: DEFAULTS.w });
    return { hits: mergeHits(s.hits, more), queries: [nq] };
  })
  .addNode('grade', async (s) => {
    const r = await claudeJSON({ system: GRADE_SYS, prompt: buildPrompt(s.q, s.hits, refsOf(s.hits)), schema: GRADE_SCHEMA, model: LLM, timeoutMs: 90000 });
    return { verdict: r.data ?? { sufficient: true }, calls: 1, loops: s.loops + 1 };
  })
  .addNode('generate', async (s) => { const a = await answer(idx, s.q, { hits: s.hits, model: LLM }); return { result: a, calls: 1 }; })
  .addEdge(START, 'retrieve').addEdge('retrieve', 'grade')
  .addConditionalEdges('grade', (s) => (s.verdict.sufficient || s.loops >= 2 ? 'generate' : 'retrieve'), { generate: 'generate', retrieve: 'retrieve' })
  .addEdge('generate', END)
  .compile();
async function agent(q) { const s = await graph.invoke({ q }); return { ...s.result, calls: s.calls, loops: s.loops, queries: s.queries }; }

const GRADE2_SYS = GRADE_SYS + '\n- out_of_scope: 질문이 이 법령들(생활 · 금융 법령 15개)이 다루는 범위 밖이면 true(세금 · 노동 · 부동산 · 의료 등). true 면 더 찾지 않는다.';
const GRADE2_SCHEMA = { type: 'object', properties: { out_of_scope: { type: 'boolean' }, ...GRADE_SCHEMA.properties }, required: ['out_of_scope', ...GRADE_SCHEMA.required] };
// ── 적응형: 먼저 한 번 검색해 답하고, 답이 "근거 없음"(answerable=false)일 때만 근거 점검 → 다시 찾기 → 다시 답변(최대 2번) ──
const adaptiveGraph = new StateGraph(S)
  .addNode('retrieve', async (s) => {
    if (s.loops === 0 && !s.hits.length) { const rw = await rewrite(s.q); const hits = await search(idx, expand(s.q, rw), { mode: 'hybrid', k: 5, w: DEFAULTS.w }); return { hits, queries: [expand(s.q, rw)] }; }
    const nq = `${s.q} ${s.verdict.new_query}`; const more = await search(idx, nq, { mode: 'hybrid', k: 5, w: DEFAULTS.w });
    return { hits: mergeHits(s.hits, more), queries: [nq] };
  })
  .addNode('generate', async (s) => { const a = await answer(idx, s.q, { hits: s.hits, model: LLM }); return { result: a, calls: 1 }; })
  .addNode('grade', async (s) => {
    const r = await claudeJSON({ system: GRADE2_SYS, prompt: buildPrompt(s.q, s.hits, refsOf(s.hits)), schema: GRADE2_SCHEMA, model: LLM, timeoutMs: 90000 });
    return { verdict: r.data ?? { sufficient: true, out_of_scope: true }, calls: 1, loops: s.loops + 1 };
  })
  .addEdge(START, 'retrieve').addEdge('retrieve', 'generate')
  .addConditionalEdges('generate', (s) => (s.result.answerable === false && s.loops < 1 ? 'grade' : END), { grade: 'grade', [END]: END })
  .addConditionalEdges('grade', (s) => (s.verdict.sufficient || s.verdict.out_of_scope ? END : 'retrieve'), { retrieve: 'retrieve', [END]: END })
  .compile();
async function adaptive(q) { const s = await adaptiveGraph.invoke({ q }); return { ...s.result, calls: s.calls, loops: s.loops, queries: s.queries }; }

// ── 채점(answer_eval.mjs 와 같은 기준) ──
const JUDGE_SYS = '너는 법령 Q&A 채점관이다. 두 기준으로 [답변]을 채점한다. (1) faithful 은 오직 [답변 모델이 받은 근거]를 기준으로 본다 — 답변의 주장 · 숫자가 그 근거에 있거나 근거에서 곧바로 따라 나오면 충실하다(근거에 없는 사실을 지어냈거나 근거와 모순되면 불충실). (2) correct 는 오직 [정답 조문 원문]을 기준으로 본다 — 질문의 핵심 결론 · 숫자 · 주체가 정답 조문과 일치하는가. 네가 아는 지식으로 보충해 판단하지 않는다.';
const JSCHEMA = { type: 'object', properties: { faithful: { type: 'boolean' }, correct: { type: 'boolean' }, reason: { type: 'string' } }, required: ['faithful', 'correct', 'reason'] };
async function pool(items, fn, conc = 3) { const res = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const n = i++; try { res[n] = await fn(items[n]); } catch (e) { res[n] = { error: e.message }; } } })); return res; }
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
const out = { date: new Date().toISOString().slice(0, 10), split, llm: LLM, systems: {} };
for (const name of SYSTEMS) {
  const ask = name === 'agent' ? agent : name === 'adaptive' ? adaptive : baseline;
  const main = await pool(qa, async (q) => {
    const t0 = Date.now(); const a = await ask(q.q); const ms = Date.now() - t0;
    const cited = a.cited.map((c) => c.key), gold = new Set(q.gold);
    const j = await claudeJSON({ system: JUDGE_SYS, model: LLM, schema: JSCHEMA, prompt: `[질문]\n${q.q}\n\n[답변 모델이 받은 근거]\n${a.context}\n\n[정답 조문 원문]\n${q.gold.map((g) => arts.get(g)).join('\n\n')}\n\n[답변]\n${a.answer}` });
    return { id: q.id, q: q.q, ms, calls: a.calls, loops: a.loops ?? 0, answerable: a.answerable, cite_hit: cited.some((c) => gold.has(c)) ? 1 : 0, faithful: j.data?.faithful ? 1 : 0, correct: j.data?.correct ? 1 : 0, reason: j.data?.reason, answer: a.answer, queries: a.queries };
  });
  const refuse = await pool(oos, async (q) => { const t0 = Date.now(); const a = await ask(q.q); return { id: q.id, q: q.q, ms: Date.now() - t0, calls: a.calls, refused: a.answerable === false ? 1 : 0, answer: a.answer }; });
  const ok = main.filter((r) => !r.error), m = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / (rs.length || 1);
  const sum = { n: ok.length, correct: m(ok, 'correct'), faithful: m(ok, 'faithful'), cite_hit: m(ok, 'cite_hit'), oos_refused: m(refuse.filter((r) => !r.error), 'refused'), llm_calls_avg: m([...ok, ...refuse.filter((r) => !r.error)], 'calls'), re_search_rate: m(ok.map((r) => ({ v: r.loops > 1 ? 1 : 0 })), 'v'), ms_p50: pct(ok.map((r) => r.ms), 0.5), ms_p95: pct(ok.map((r) => r.ms), 0.95), errors: main.filter((r) => r.error).length + refuse.filter((r) => r.error).length };
  out.systems[name] = { summary: sum, main, refuse };
  console.log(name, JSON.stringify(sum));
  for (const r of ok.filter((r) => !r.correct || !r.faithful)) console.log(`  ✗ ${r.id} ${r.q.slice(0, 40)} — ${r.reason?.slice(0, 120)}`);
  writeFileSync(new URL(`../eval/results/${OUT}`, import.meta.url), JSON.stringify(out, null, 1));
}
