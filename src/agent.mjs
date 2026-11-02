// 적응형 답변(LangGraph) — 평소엔 한 번 검색 → 답변. 답이 "근거 없음"(answerable=false)일 때만
// 근거 점검 LLM 이 "범위 밖인가 / 정보가 빠졌나"를 판정하고, 빠졌으면 새 검색어로 한 번 더 찾아 근거를 합친 뒤 다시 답한다.
// 실험(eval/EXPERIMENTS.md B2): 항상 점검하는 에이전트는 호출 2.3배 · 지연 1.5배에 정확성 차이가 없었고,
// 적응형은 범위 안 질문 호출 1.19배 · 지연 거의 같게 유지하면서 "검색이 빗나가 근거 없음으로 답하던" 문항(ef-09 · mj-05)을 구제했다.
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { search, DEFAULTS } from './index.mjs';
import { answer, buildPrompt, refsOf } from './answer.mjs';
import { claudeJSON } from './llm.mjs';

const GRADE_SYS = `너는 법령 검색 결과 점검관이다. [근거] 조문만으로 [질문]의 핵심(결론 · 기간 · 금액 · 주체)에 답할 수 있는지 판정한다. 네 지식으로 답을 만들지 않는다.
- 답할 수 있으면 sufficient=true.
- 부족하면 sufficient=false, missing 에 빠진 정보를 한 줄로, new_query 에 그 정보를 담은 조문을 찾기 위한 **법령 용어 검색어**(조 번호 없이, 관련 법령 이름 포함 가능)를 쓴다.
- out_of_scope: 질문이 이 법령들(생활 · 금융 법령 16개)이 다루는 범위 밖이면 true(세금 · 노동 · 부동산 · 의료 등). true 면 더 찾지 않는다.`;
const GRADE_SCHEMA = { type: 'object', properties: { out_of_scope: { type: 'boolean' }, sufficient: { type: 'boolean' }, missing: { type: 'string' }, new_query: { type: 'string' } }, required: ['out_of_scope', 'sufficient', 'missing', 'new_query'] };

const State = Annotation.Root({
  q: Annotation(), model: Annotation(), w: Annotation(), k: Annotation(),
  hits: Annotation({ reducer: (_, b) => b, default: () => [] }),
  queries: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  loops: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  calls: Annotation({ reducer: (a, b) => a + b, default: () => 0 }),
  verdict: Annotation(), result: Annotation(),
});

const mergeHits = (old, add, max = 8) => {
  const seen = new Set(old.map((h) => h.chunk.articleKey)), out = [...old];
  for (const h of add) { if (out.length >= max) break; if (!seen.has(h.chunk.articleKey)) { seen.add(h.chunk.articleKey); out.push(h); } }
  return out.map((h, i) => ({ ...h, rank: i + 1 }));
};

export function makeAdaptive(idx) {
  return new StateGraph(State)
    .addNode('research', async (s) => { // 두 번째 검색: 점검관이 준 검색어로 더 찾아 기존 근거에 합친다
      const nq = `${s.q} ${s.verdict.new_query}`;
      const more = await search(idx, nq, { mode: 'hybrid', k: s.k, w: s.w });
      return { hits: mergeHits(s.hits, more), queries: [nq] };
    })
    .addNode('generate', async (s) => ({ result: await answer(idx, s.q, { hits: s.hits, model: s.model }), calls: 1 }))
    .addNode('grade', async (s) => {
      const r = await claudeJSON({ system: GRADE_SYS, prompt: buildPrompt(s.q, s.hits, refsOf(s.hits)), schema: GRADE_SCHEMA, model: s.model, timeoutMs: 90000 });
      return { verdict: r.data ?? { out_of_scope: true, sufficient: true }, calls: 1, loops: s.loops + 1 };
    })
    .addEdge(START, 'generate')
    .addConditionalEdges('generate', (s) => (s.result.answerable === false && s.loops < 1 ? 'grade' : END), { grade: 'grade', [END]: END })
    .addConditionalEdges('grade', (s) => (s.verdict.sufficient || s.verdict.out_of_scope ? END : 'research'), { research: 'research', [END]: END })
    .addEdge('research', 'generate')
    .compile();
}

/** 첫 검색 결과(hits)를 받아 적응형으로 답한다. 반환: answer() 결과 + { calls, researched, queries, verdict }
 *  onStep(node, update) 를 주면 노드(generate · grade · research)가 끝날 때마다 불러 준다 — 화면의 단계 표시용 */
export async function adaptiveAnswer(graph, q, { hits, query, model = DEFAULTS.llm, w = DEFAULTS.w, k = 5, onStep } = {}) {
  const input = { q, model, w, k, hits, queries: [query ?? q] };
  let s;
  if (!onStep) s = await graph.invoke(input);
  else {
    for await (const [mode, chunk] of await graph.stream(input, { streamMode: ['updates', 'values'] })) {
      if (mode === 'values') s = chunk;
      else for (const [node, update] of Object.entries(chunk)) { try { onStep(node, update ?? {}); } catch {} }
    }
  }
  return { ...s.result, calls: s.calls, researched: s.queries.length > 1, queries: s.queries, verdict: s.verdict ?? null, searchHits: s.hits };
}
