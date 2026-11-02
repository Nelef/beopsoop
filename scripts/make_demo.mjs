// demo 모드용 예시 질문 답변을 실제 파이프라인(재작성 → 검색 → Claude 답변)으로 미리 만들어 data/demo.json 에 저장한다.
// 데모 방문자는 Claude 를 호출하지 않고 이 결과만 본다(구독 한도 보호). 답을 손으로 쓰지 않는다 — 서비스와 같은 코드가 만든다.
import { writeFileSync } from 'node:fs';
import { buildIndex, search, DEFAULTS } from '../src/index.mjs';
import { answer, contextOf } from '../src/answer.mjs';
import { rewrite, expand } from '../src/rewrite.mjs';

const QUESTIONS = [
  '접근매체를 분실했을 때 금융회사는 누가 책임지나요?',
  '개인정보가 유출되면 정보주체에게 언제까지 알려야 하나요?',
  '신용정보회사가 내 정보를 제3자에게 주려면 동의가 필요한가요?',
  '대출 심사를 AI가 자동으로 해서 탈락했는데 사람이 다시 봐 달라고 요구할 수 있나요?',
  '신용정보 처리 업무를 외부에 맡기려는 금융회사는 계약을 맺기 며칠 전까지 금융위원회에 알려야 하나요?',
  // 일상 분쟁(중고거래)
  '중고거래로 산 노트북이 일주일 만에 고장 났어요. 판매자한테 환불받을 수 있나요?',
  '당근에서 산 물건이 마음에 안 드는데 7일 안에 환불받을 수 있나요?',
  '중고거래 사기를 당해 입금했는데, 은행에 계좌 지급정지를 요청할 수 있나요?',
  '종합소득세 신고 기한이 언제인가요?', // 범위 밖 — "근거 없음" 거절을 보여 준다
];
const LLM = process.env.FINLAW_LLM || DEFAULTS.llm;
const idx = await buildIndex({ model: DEFAULTS.model, strategy: DEFAULTS.strategy });
const out = {};
for (const q of QUESTIONS) {
  const t0 = Date.now();
  const rw = await rewrite(q);
  const hits = await search(idx, expand(q, rw), { mode: 'hybrid', k: 5, w: DEFAULTS.w });
  const a = await answer(idx, q, { hits, model: LLM });
  out[q] = { answerable: a.answerable, answer: a.answer, cited: a.cited.map((c) => c.key), rewritten: { terms: rw.terms, laws: rw.laws },
    sources: [...hits.map((h) => ({ key: h.chunk.articleKey, label: h.chunk.label, text: contextOf(h.chunk).replace(/^[^\n]*\n/, ''), rank: h.rank })), ...a.refs.map((r, i) => ({ key: r.key, label: r.label, text: r.text, rank: hits.length + i + 1, ref: true }))], searchMs: 0, llmMs: a.ms };
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  answerable=${a.answerable}  인용 ${a.cited.length}  ${q}`);
}
writeFileSync(new URL('../data/demo.json', import.meta.url), JSON.stringify(out));
console.log('data/demo.json 저장');
