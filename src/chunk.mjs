// 법령 JSON → 조문 → 청크.
// 평가 단위(정답 키)는 항상 "조"(articleKey)다. 청킹 전략이 달라도 같은 정답 세트로 비교할 수 있게 하려는 것.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RAW = new URL('../data/raw/', import.meta.url).pathname;

export const SHORT = {
  '전자금융거래법': '전자금융거래법',
  '전자금융거래법 시행령': '전자금융거래법 시행령',
  '개인정보 보호법': '개인정보 보호법',
  '개인정보 보호법 시행령': '개인정보 보호법 시행령',
  '신용정보의 이용 및 보호에 관한 법률': '신용정보법',
  '신용정보의 이용 및 보호에 관한 법률 시행령': '신용정보법 시행령',
  '전자상거래 등에서의 소비자보호에 관한 법률': '전자상거래법',
  '전자상거래 등에서의 소비자보호에 관한 법률 시행령': '전자상거래법 시행령',
  '전기통신금융사기 피해 방지 및 피해자산 환급에 관한 특별법': '통신사기피해방지법',
  '전기통신금융사기 피해 방지 및 피해자산 환급에 관한 특별법 시행령': '통신사기피해방지법 시행령',
};

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
// 개정 이력 표시(<개정 2013.5.22>, [본조신설 …])는 검색에 잡음이라 뺀다
const clean = (s) =>
  String(s ?? '')
    .replace(/<[^<>]*\d{4}\.\s?\d{1,2}\.\s?\d{1,2}[^<>]*>/g, '')
    .replace(/\[[^\[\]]*(?:신설|개정|전문개정|제목개정|종전)[^\[\]]*\]/g, '')
    .replace(/[ \t　]+/g, ' ')
    .trim();

// 목내용은 문자열이거나 문자열 배열이다
const lines = (x) => arr(x).flatMap((v) => (typeof v === 'string' ? v.split('\n') : []));

function hangLines(h) {
  const out = [];
  const head = clean(h.항내용);
  if (head) out.push(head);
  for (const ho of arr(h.호)) {
    const t = clean(ho.호내용);
    if (t) out.push('  ' + t);
    for (const mok of arr(ho.목)) for (const l of lines(mok.목내용)) if (clean(l)) out.push('    ' + clean(l));
  }
  return out;
}

export const articleKey = (law, no, branch) => `${law}|제${no}조${branch ? `의${branch}` : ''}`;

/** data/raw 의 모든 법령을 조 단위로 읽는다. */
export function loadArticles() {
  const out = [];
  for (const f of readdirSync(RAW).filter((x) => x.endsWith('.json') && !x.startsWith('.')).sort()) {
    const d = JSON.parse(readFileSync(join(RAW, f), 'utf8')).법령;
    const law = d.기본정보.법령명_한글;
    const lawShort = SHORT[law] ?? law;
    let chapter = '';
    for (const j of arr(d.조문.조문단위)) {
      if (j.조문여부 === '전문') {
        const c = clean(j.조문내용);
        if (/^제\d+장/.test(c)) chapter = c;
        continue;
      }
      const no = j.조문번호, branch = j.조문가지번호 || '';
      const first = clean(j.조문내용); // "제15조(개인정보의 수집·이용) ① …" 형태 — 조 머리말과 (항이 없으면) 본문이 같이 있다
      const hangs = arr(j.항);
      if (/^제\d+조(?:의\d+)?(?:\([^)]*\))?\s*삭제/.test(first) || (!hangs.length && /삭제\s*$/.test(first) && first.length < 40)) continue;
      const title = j.조문제목 || '';
      const body = [];
      const afterTitle = first.replace(/^제\d+조(?:의\d+)?(?:\([^)]*\))?\s*/, '');
      if (afterTitle) body.push(afterTitle);
      const paras = hangs.map((h) => ({ no: h.항번호 || '', lines: hangLines(h) })).filter((p) => p.lines.length);
      out.push({
        key: articleKey(law, no, branch), law, lawShort, no, branch, title, chapter,
        label: `${lawShort} 제${no}조${branch ? `의${branch}` : ''}(${title})`,
        lead: body, paras,
      });
    }
  }
  return out;
}

/**
 * 청킹 전략
 *  - article   : 조 하나 = 청크. maxChars 를 넘으면 항 경계에서 나눈다(머리말 반복).
 *  - paragraph : 항 하나 = 청크(항이 없는 조는 조 통째). 아주 짧은 항은 앞 항과 합친다(minChars).
 * 모든 청크의 indexText 에는 "법령명 제N조(제목)" 머리말을 붙인다 — 항만 떼어 놓으면 어느 법의 무슨 조인지 임베딩에 안 남는다.
 */
export function chunkArticles(articles, { strategy = 'article', maxChars = 1200, minChars = 80, withChapter = true } = {}) {
  const chunks = [];
  for (const a of articles) {
    const full = [...a.lead, ...a.paras.flatMap((p) => p.lines)].join('\n');
    const head = `${a.label}${withChapter && a.chapter ? ` · ${a.chapter}` : ''}`;
    const mk = (parts, clause) => {
      const text = parts.join('\n');
      chunks.push({ id: `${a.key}${clause ? `#${clause}` : ''}`, articleKey: a.key, label: a.label, law: a.law, lawShort: a.lawShort, clause, text, full, indexText: `${head}\n${text}` });
    };
    const units = [...(a.lead.length ? [{ no: '', lines: a.lead }] : []), ...a.paras];
    if (!units.length) continue;
    const groups = [];
    const group = (cond) => {
      let buf = [], nos = [];
      for (const u of units) {
        if (buf.length && cond(buf.join('\n').length, u.lines.join('\n').length)) { groups.push({ buf, nos }); buf = []; nos = []; }
        buf.push(...u.lines); nos.push(u.no);
      }
      if (buf.length) groups.push({ buf, nos });
    };
    // paragraph: 앞 덩어리가 minChars 를 채우면 끊는다 / article: 다음 항을 붙이면 maxChars 를 넘을 때만 끊는다
    if (strategy === 'paragraph') group((len) => len >= minChars);
    else group((len, next) => len + next > maxChars);
    for (const g of groups) mk(g.buf, groups.length > 1 ? g.nos.filter(Boolean).join('+') || null : null);
  }
  return chunks;
}
