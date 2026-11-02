// 국가법령정보센터 Open API 에서 법령 본문(JSON)을 받아 data/raw/ 에 저장한다. 법령은 저작권 보호 대상이 아니다(저작권법 제7조).
import { writeFileSync, mkdirSync } from 'node:fs';

const OC = process.env.LAW_OC || 'test';
const LAWS = [
  '전자금융거래법', '전자금융거래법 시행령',
  '개인정보 보호법', '개인정보 보호법 시행령',
  '신용정보의 이용 및 보호에 관한 법률', '신용정보의 이용 및 보호에 관한 법률 시행령',
  // 생활 분쟁(중고거래 등): 계약 · 환불 · 사기 · 소액 분쟁 절차
  '민법', '전자상거래 등에서의 소비자보호에 관한 법률', '전자상거래 등에서의 소비자보호에 관한 법률 시행령',
  '소비자기본법', '약관의 규제에 관한 법률', '형법',
  '전기통신금융사기 피해 방지 및 피해자산 환급에 관한 특별법', '전기통신금융사기 피해 방지 및 피해자산 환급에 관한 특별법 시행령',
  '소액사건심판법', '민사조정법',
];
const api = (path, params) => `https://www.law.go.kr/DRF/${path}.do?` + new URLSearchParams({ OC, type: 'JSON', ...params });
const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

mkdirSync('data/raw', { recursive: true });
for (const name of LAWS) {
  const list = await getJSON(api('lawSearch', { target: 'law', query: name, display: '20' }));
  const hits = [].concat(list.LawSearch.law ?? []);
  const hit = hits.find((x) => x.법령명한글 === name && x.현행연혁코드 === '현행');
  if (!hit) throw new Error(`현행 법령을 못 찾음: ${name}`);
  const full = await getJSON(api('lawService', { target: 'law', MST: hit.법령일련번호 }));
  const file = `data/raw/${name.replace(/ /g, '_')}.json`;
  writeFileSync(file, JSON.stringify(full));
  console.log(`${name}  MST=${hit.법령일련번호}  시행 ${hit.시행일자}  → ${file}`);
}
writeFileSync('data/raw/.fetched.json', JSON.stringify({ fetched: new Date().toISOString().slice(0, 10).replace(/-/g, '') }));   // 화면의 '기준일'
