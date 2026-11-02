// RAG 답변: 검색 → 근거 조문을 번호 붙여 넣기 → Claude 가 JSON 으로 답 + 인용 번호. 근거 밖이면 "찾을 수 없음".
import { search } from './index.mjs';
import { claudeJSON } from './llm.mjs';
import { loadArticles } from './chunk.mjs';

const SYSTEM = `너는 한국 생활 · 금융 법령(전자금융거래법, 개인정보 보호법, 신용정보의 이용 및 보호에 관한 법률(각 시행령 포함)과 민법, 전자상거래 등에서의 소비자보호에 관한 법률(시행령 포함), 소비자기본법, 약관의 규제에 관한 법률, 형법, 전기통신금융사기 피해 방지 및 피해자산 환급에 관한 특별법(시행령 포함), 소액사건심판법, 민사조정법) 안내 도우미다.
규칙:
1. 아래 [근거] 조문에 적힌 내용만으로 답한다. 기억이나 상식으로 보충하지 않는다.
2. 근거에 답이 없거나 질문이 이 법령들의 범위 밖이면 answerable=false 로 하고 answer 에 "제공된 법령 조문에서 근거를 찾을 수 없습니다"라고 쓴다.
3. 답에 쓴 모든 주장은 근거 번호로 뒷받침한다. 답 문장 끝에 [1], [2] 처럼 번호를 단다. 근거에 없는 번호는 쓰지 않는다.
4. 숫자(기한 · 금액 · 비율)는 조문에 적힌 그대로 옮긴다. 조 · 항 번호는 근거 머리말에 있는 것만 말한다.
5. 근거 중 "(참조)" 표시가 붙은 조문은 검색된 조문이 가리키는(준용 · 인용하는) 조문이다. 같은 근거로 쓰고 번호로 인용한다. 단 근거 조문이 "제N조제1항을 준용" 처럼 특정 항을 가리키면 **그 항만** 적용하고, 참조 조문의 다른 항(기간 · 예외 등)을 끌어다 쓰지 않는다. 기간 · 숫자는 그 규정을 직접 정한 조문에 있을 때만 말하고, 없으면 "근거에서 확인할 수 없다"고 한다.
6. 한국어, 3~6문장. 법률 자문이 아니라 조문 안내임을 길게 덧붙이지 않는다.`;

const SCHEMA = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    answer: { type: 'string' },
    citations: { type: 'array', items: { type: 'integer' }, description: '답에 실제로 쓴 근거 번호' },
  },
  required: ['answerable', 'answer', 'citations'],
};

// 항 단위로 찾고(정밀), 답변 근거로는 그 조 전체를 준다(맥락). 아주 긴 조(정의 조항 등)는 찾은 항만 준다.
export const contextOf = (c) => (c.full.length <= 3500 ? `${c.label}\n${c.full}` : c.indexText);

// ── 조문 간 참조 확장 ──
// "제575조제1항을 준용한다" 처럼 근거 조문이 같은 법의 다른 조문을 가리키면, 그 조문을 근거에 덧붙인다(상위 3개 조문에서 최대 3개).
// 시행령의 "법 제N조" · 타법 인용(「…법」 제N조)은 가리키는 곳이 다른 법이라 건너뛴다.
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
let ARTS;
export function refsOf(hits, { max = 3, top = 3 } = {}) {
  ARTS ??= new Map(loadArticles().map((a) => [a.key, a]));
  const have = new Set(hits.map((h) => h.chunk.articleKey)), out = [];
  for (const h of hits.slice(0, top)) {
    const c = h.chunk;
    for (const m of c.full.matchAll(/제(\d+)조(?:의(\d+))?(?:제(\d+)항)?/g)) {
      const before = c.full.slice(Math.max(0, m.index - 12), m.index);
      if (/법\s*$|」\s*$|령\s*$|규칙\s*$/.test(before)) continue; // 다른 법령 인용
      const key = `${c.law}|제${m[1]}조${m[2] ? `의${m[2]}` : ''}`;
      const a = ARTS.get(key);
      if (!a || have.has(key) || a.key === c.articleKey) continue;
      // "제575조제1항" 처럼 항을 지정한 참조는 그 항만 붙인다 — 조 전체를 붙이면 준용되지 않는 다른 항(기간 · 예외)을 모델이 끌어다 쓴다(실제로 그랬다)
      const para = m[3] ? a.paras.find((p) => p.no === CIRCLED[+m[3] - 1]) : null;
      const text = para ? para.lines.join('\n') : [...a.lead, ...a.paras.flatMap((p) => p.lines)].join('\n');
      have.add(key); out.push({ key, label: para ? `${a.label} 제${m[3]}항` : a.label, text });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function buildPrompt(question, hits, refs = []) {
  const ctx = [...hits.map((h, i) => `[${i + 1}] ${contextOf(h.chunk)}`), ...refs.map((r, i) => `[${hits.length + i + 1}] (참조) ${r.label}\n${r.text.slice(0, 2500)}`)].join('\n\n');
  return `[근거]\n${ctx}\n\n[질문]\n${question}`;
}

export async function answer(idx, question, { k = 5, mode = 'hybrid', model = 'sonnet', hits, expandRefs = true } = {}) {
  hits ??= await search(idx, question, { mode, k });
  const refs = expandRefs ? refsOf(hits) : [];
  const r = await claudeJSON({ system: SYSTEM, prompt: buildPrompt(question, hits, refs), schema: SCHEMA, model });
  const d = r.data ?? { answerable: false, answer: r.text, citations: [] };
  const pool = [...hits.map((h) => ({ key: h.chunk.articleKey, label: h.chunk.label })), ...refs.map((r) => ({ key: r.key, label: r.label }))];
  const cited = [...new Set((d.citations ?? []).filter((n) => n >= 1 && n <= pool.length))].map((n) => pool[n - 1]);
  return { ...d, context: buildPrompt(question, hits, refs), cited, hits: pool.slice(0, hits.length), refs, usage: r.usage, ms: r.ms };
}
