// 답변 평가(엔드투엔드): 최종 설정으로 검색 → 질의 재작성 → 답변 생성 후 채점한다.
//  - cite_hit   : 답이 인용한 조문 중 정답 조문이 하나라도 있는가
//  - cite_prec  : 인용한 조문 중 정답 조문 비율(정답 외 관련 조문을 인용해도 깎이므로 보수적 지표)
//  - judge      : 별도 Claude 호출이 정답 조문 원문을 보고 판정 — faithful(원문에 없는 주장 · 모순 없음), correct(질문의 핵심에 답함)
//  - oos 거절률 : 범위 밖 질문에서 answerable=false 로 거절한 비율(환각 방지)
// 판정 모델이 답변 모델과 같은 계열이라 관대할 수 있다 — 숫자는 상대 비교 · 점검용으로 본다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildIndex, search, DEFAULTS } from '../src/index.mjs';
import { answer } from '../src/answer.mjs';
import { rewrite, expand } from '../src/rewrite.mjs';
import { claudeJSON } from '../src/llm.mjs';
import { loadArticles } from '../src/chunk.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const split = arg('split', 'test'), LLM = arg('llm', 'sonnet'), out = arg('out', '');
const qa = readFileSync(new URL('./qa.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((q) => split === 'all' || q.split === split);
const oos = readFileSync(new URL('./oos.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const arts = new Map(loadArticles().map((a) => [a.key, `${a.label}\n${[...a.lead, ...a.paras.flatMap((p) => p.lines)].join('\n')}`]));
const idx = await buildIndex({ model: DEFAULTS.model, strategy: DEFAULTS.strategy });

const JUDGE_SYS = '너는 법령 Q&A 채점관이다. 두 기준으로 [답변]을 채점한다. (1) faithful 은 오직 [답변 모델이 받은 근거]를 기준으로 본다 — 답변의 주장 · 숫자가 그 근거에 있거나 근거에서 곧바로 따라 나오면 충실하다(근거에 없는 사실을 지어냈거나 근거와 모순되면 불충실). (2) correct 는 오직 [정답 조문 원문]을 기준으로 본다 — 질문의 핵심 결론 · 숫자 · 주체가 정답 조문과 일치하는가. 네가 아는 지식으로 보충해 판단하지 않는다.';
const JSCHEMA = { type: 'object', properties: { faithful: { type: 'boolean', description: '답변의 모든 주장이 받은 근거에 있거나 근거에서 따라 나온다(지어낸 사실 · 숫자 · 근거와의 모순 없음)' }, correct: { type: 'boolean', description: '답변이 질문의 핵심(결론 · 숫자 · 주체)을 정답 조문과 일치하게 말했다' }, reason: { type: 'string' } }, required: ['faithful', 'correct', 'reason'] };

async function run(items, fn, conc = 3) { const res = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const n = i++; try { res[n] = await fn(items[n]); } catch (e) { res[n] = { error: e.message }; } } })); return res; }
const ask = async (q) => { const rw = await rewrite(q); const hits = await search(idx, expand(q, rw), { mode: 'hybrid', k: 5, w: DEFAULTS.w }); return answer(idx, q, { hits, model: LLM }); };

console.log(`답변 평가: 질문 ${qa.length}개(${split}) + 범위 밖 ${oos.length}개, 답변 모델 ${LLM}`);
const main = await run(qa, async (q) => {
  const a = await ask(q.q);
  const cited = a.cited.map((c) => c.key), gold = new Set(q.gold);
  const j = await claudeJSON({ system: JUDGE_SYS, model: LLM, schema: JSCHEMA, prompt: `[질문]\n${q.q}\n\n[답변 모델이 받은 근거]\n${a.context}\n\n[정답 조문 원문]\n${q.gold.map((g) => arts.get(g)).join('\n\n')}\n\n[답변]\n${a.answer}` });
  return { id: q.id, type: q.type, q: q.q, answerable: a.answerable, cited, gold: q.gold, cite_hit: cited.some((c) => gold.has(c)) ? 1 : 0, cite_prec: cited.length ? cited.filter((c) => gold.has(c)).length / cited.length : 0, faithful: j.data?.faithful ? 1 : 0, correct: j.data?.correct ? 1 : 0, reason: j.data?.reason, answer: a.answer };
});
const refuse = await run(oos, async (q) => { const a = await ask(q.q); return { id: q.id, q: q.q, refused: a.answerable === false ? 1 : 0, answer: a.answer }; });

const ok = main.filter((r) => !r.error), mean = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / (rs.length || 1);
const sum = { n: ok.length, answerable_rate: mean(ok.map((r) => ({ v: r.answerable ? 1 : 0 })), 'v'), cite_hit: mean(ok, 'cite_hit'), cite_prec: mean(ok, 'cite_prec'), faithful: mean(ok, 'faithful'), correct: mean(ok, 'correct'), oos_n: refuse.length, oos_refused: mean(refuse.filter((r) => !r.error), 'refused'), errors: main.filter((r) => r.error).length + refuse.filter((r) => r.error).length };
console.log(JSON.stringify(sum, null, 1));
for (const r of ok.filter((r) => !r.correct || !r.faithful || !r.cite_hit)) console.log(`\n✗ ${r.id} ${r.q}\n  인용 ${r.cited.join(', ') || '-'} / 정답 ${r.gold.join(', ')}\n  판정: ${r.reason}`);
for (const r of refuse.filter((r) => !r.refused)) console.log(`\n⚠ 거절 못함 ${r.id} ${r.q}\n  → ${r.answer}`);
if (out) { mkdirSync(new URL('./results/', import.meta.url).pathname, { recursive: true }); writeFileSync(new URL(`./results/${out}`, import.meta.url), JSON.stringify({ split, llm: LLM, date: new Date().toISOString().slice(0, 10), summary: sum, main, refuse }, null, 1)); }
