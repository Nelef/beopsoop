// 질의 재작성: 일상어 질문 → 법령 용어 검색어. 질문은 "광고 문자 보내도 되나요", 조문은 "목적 외 이용 · 제공" 이라 단어가 안 겹치는 문제(어휘 격차)를 줄인다.
// 재작성 모델은 조문 본문을 보지 않는다(법령 이름만 안다) — 정답을 엿볼 수 없다. 결과는 디스크에 캐시해 평가를 재현 가능하게 한다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { claudeJSON } from './llm.mjs';

const FILE = new URL('../data/cache/rewrites.json', import.meta.url).pathname;
const cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const SYSTEM = `너는 한국 법령 검색용 질의 변환기다. 검색 대상은 전자금융거래법, 개인정보 보호법, 신용정보의 이용 및 보호에 관한 법률(각 시행령 포함)과 민법, 전자상거래 등에서의 소비자보호에 관한 법률(시행령 포함), 소비자기본법, 약관의 규제에 관한 법률, 형법, 전기통신금융사기 피해 방지 및 피해자산 환급에 관한 특별법(시행령 포함), 소액사건심판법, 민사조정법이다. 금융 · 개인정보뿐 아니라 중고거래 · 온라인 구매 · 사기 같은 일상 분쟁 질문도 온다.
사용자의 일상어 질문을 읽고, 조문 본문에 실제로 나올 법한 **법령 용어**로 다시 쓴 검색어를 만든다.
- 질문에 없는 사실을 지어내지 않는다. 질문의 상황에 해당하는 법적 개념 · 행위 · 주체 · 용어(예: 목적 외 이용, 제3자 제공, 정보주체, 접근매체, 개인신용정보, 동의 철회, 통지 의무)를 3~8개 뽑는다.
- 관련될 가능성이 큰 법령 이름을 1~2개 고른다(없으면 빈 배열).
- 조 번호는 쓰지 않는다.`;
const SCHEMA = { type: 'object', properties: { terms: { type: 'string', description: '법령 용어 검색어(공백 구분 한 줄)' }, laws: { type: 'array', items: { type: 'string' } } }, required: ['terms', 'laws'] };

export async function rewrite(q, { model = process.env.FINLAW_RW_MODEL || 'sonnet' } = {}) {
  const key = createHash('sha1').update(`${model}\n${SYSTEM}\n${q}`)  // 프롬프트가 바뀌면 옛 캐시를 쓰지 않는다
   .digest('hex').slice(0, 16);
  if (cache[key]) return cache[key];
  const { data } = await claudeJSON({ system: SYSTEM, prompt: q, schema: SCHEMA, model, timeoutMs: 60000 });
  const r = { terms: String(data?.terms ?? ''), laws: data?.laws ?? [] };
  cache[key] = r;
  mkdirSync(new URL('../data/cache/', import.meta.url).pathname, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cache));
  return r;
}

/** 원 질문 + 재작성 검색어를 이어 붙인 검색 문장. 원 질문을 남겨 두어 재작성이 틀려도 기본 검색이 살아 있게 한다. */
export const expand = (q, r) => `${q} ${r.laws.join(' ')} ${r.terms}`.trim();

export async function rewriteAll(qs, { concurrency = 4, model } = {}) {
  const out = new Array(qs.length); let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (i < qs.length) { const n = i++; out[n] = await rewrite(qs[n], { model }); } }));
  return out;
}
