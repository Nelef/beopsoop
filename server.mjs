// 법숲 웹 서버(Node 내장 http).
//  - 로그인: 아이디/비밀번호 폼 → 서명된 세션 쿠키(HttpOnly). 역할 user = 전체 기능, demo = 비밀번호 없이 체험(Claude 호출 없음 · 미리 만든 예시 답변 + 로컬 검색만).
//  - /api/ask = 질의 재작성 + 검색 + Claude 답변, /api/search = 검색만. curl 점검용으로 Basic 인증도 user 로 받는다.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { buildIndex, search, DEFAULTS } from './src/index.mjs';
import { answer, contextOf } from './src/answer.mjs';
import { rewrite, expand } from './src/rewrite.mjs';
import { embedQueries } from './src/embed.mjs';
import { makeAdaptive, adaptiveAnswer } from './src/agent.mjs';
import { usageCtx, notify } from './src/notify.mjs';

const PORT = +process.env.PORT || 8000;
const MODEL = process.env.FINLAW_EMBED || DEFAULTS.model;
const AUTH_USER = process.env.AUTH_USER || 'admin', AUTH_PASS = process.env.AUTH_PASS || '';
const LLM_MODEL = process.env.FINLAW_LLM || DEFAULTS.llm;
const W = (process.env.FINLAW_RRF_W || DEFAULTS.w.join()).split(',').map(Number);
const SECRET = process.env.SESSION_SECRET || `beopsoop:${AUTH_PASS}`;
const SESSION_SEC = 7 * 24 * 3600, DEMO_SEC = 3 * 3600;
if (!AUTH_PASS) console.warn('AUTH_PASS 가 없어 로그인이 비활성입니다(누구나 user 로 입장) — 로컬 개발용');

const idx = await buildIndex({ model: MODEL, strategy: DEFAULTS.strategy, log: (m) => console.log(m) });
const adaptive = makeAdaptive(idx); // 근거 없음일 때만 다시 찾는 LangGraph 흐름(src/agent.mjs)
await embedQueries(MODEL, ['워밍업']); // 첫 질의가 모델 로드로 7초 걸리지 않게 기동 때 한 번 돌린다
const readJSON = (rel) => { const f = new URL(rel, import.meta.url).pathname; return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
const evalSummary = readJSON('./eval/results/final.json');
const demoCache = readJSON('./data/demo.json') ?? {}; // { 질문: {answerable, answer, cited, sources, rewritten} } — scripts/make_demo.mjs 가 만든다
// 색인한 법령의 공포 · 시행일(국가법령정보센터 현행본 기본정보) — 화면에 기준일로 보인다
const FETCHED = readJSON('./data/raw/.fetched.json')?.fetched ?? '';   // scripts/fetch.mjs 가 받은 날을 적는다
const LAWS = readdirSync(new URL('./data/raw/', import.meta.url).pathname).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => {
  const b = JSON.parse(readFileSync(new URL(`./data/raw/${f}`, import.meta.url), 'utf8')).법령.기본정보;
  return { fetched: FETCHED, name: b.법령명_한글, kind: b.법종구분?.content ?? b.법종구분 ?? '', promulgated: b.공포일자, effective: b.시행일자 };
}).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
const page = (n) => readFileSync(new URL(`./web/${n}.html`, import.meta.url));
const HTML = { index: page('index'), login: page('login') };

const send = (res, code, body, type = 'application/json; charset=utf-8', headers = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 20000) { req.destroy(); no(new Error('too large')); } }); req.on('end', () => ok(b)); });
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// ── 세션: "역할.만료(초).서명" ──
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = (role, sec) => { const body = `${role}.${Math.floor(Date.now() / 1000) + sec}`; return `${body}.${sign(body)}`; };
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
// 앞단 관문 서버(선택)가 로그인을 확인하고 역할을 헤더로 넘길 수 있다 — GATEWAY_KEY 비밀 값이 맞을 때만 믿는다
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
const REDIRECT_URL = process.env.REDIRECT_URL || '';   // 예: https://example.com/ — 경로와 상관없이 이 주소(첫 화면)로 보낸다
function roleOf(req) {
  if (GATEWAY_KEY && safeEq(req.headers['x-uyai-key'] || '', GATEWAY_KEY) && ['user', 'demo'].includes(req.headers['x-uyai-role'])) return req.headers['x-uyai-role'];
  if (!AUTH_PASS) return 'user';
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ') && safeEq(Buffer.from(h.slice(6), 'base64').toString(), `${AUTH_USER}:${AUTH_PASS}`)) return 'user';
  const t = cookieOf(req, 'bs_session'); if (!t) return null;
  const [role, exp, sig] = t.split('.');
  if (!sig || !safeEq(sig, sign(`${role}.${exp}`)) || +exp < Date.now() / 1000 || !['user', 'demo'].includes(role)) return null;
  return role;
}
const setCookie = (req, token, sec) => `bs_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sec}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

// ── 남용 방지: 로그인 실패 · 데모 검색 횟수 제한(IP 별, 1분) ──
const hits = new Map();
// 최근 windowMs 안의 허용된 횟수로 막는다(막힌 시도는 세지 않는다 — 계속 눌러도 막히는 시간이 늘지 않게)
const recent = (key, windowMs) => { const now = Date.now(); const a = (hits.get(key) ?? []).filter((t) => now - t < windowMs); hits.set(key, a); return a; };
const limited = (key, max, windowMs = 60000) => { const a = recent(key, windowMs); if (a.length >= max) return true; a.push(Date.now()); return false; };
// demo 실시간 답변은 운영자의 Claude 호출을 쓰므로 IP 당 시간당 · 서버 전체 하루 상한을 둔다(환경변수로 조정)
const DEMO_DAILY_CAP = +process.env.DEMO_DAILY_CAP || 100;   // IP 제한은 두지 않는다(사용자 지시 2026-10-16) — 사이트 전체 하루 상한만
const CONTACT = process.env.CONTACT || '';   // 한도에 걸리면 시연 요청 연락처로 안내
const LIVE = !!(process.env.FINLAW_CLAUDE_TOKEN || process.env.FINLAW_CLAUDE_TOKEN_2 || (process.env.ALT_LLM_URL && process.env.ALT_LLM_KEY)); // Claude 토큰 또는 대체 엔진(ALT_LLM_URL)이 있어야 답을 만든다
let dayKey = '', dayCount = 0;
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 하루 = 한국 시간 0시 기준
const dailyTaken = () => { const d = kstDay(); if (d !== dayKey) { dayKey = d; dayCount = 0; } return dayCount >= DEMO_DAILY_CAP ? false : (dayCount++, true); };
const dailyUsed = () => (dayKey === kstDay() ? dayCount : 0);
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const src = (h) => ({ key: h.chunk.articleKey, label: h.chunk.label, text: contextOf(h.chunk).replace(/^[^\n]*\n/, ''), rank: h.rank });
const norm = (q) => q.replace(/\s+/g, ' ').trim();

let busy = 0; // Claude 동시 호출 제한(구독 한도 보호)
createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/health') return send(res, 200, { ok: true, chunks: idx.chunks.length });
    // REDIRECT_URL 이 있으면 직접 들어온 요청을 그 주소로 보낸다. 관문이 보낸 요청은 그대로 받는다
    if (REDIRECT_URL && !(GATEWAY_KEY && safeEq(req.headers['x-uyai-key'] || '', GATEWAY_KEY))) {
      res.writeHead(301, { location: REDIRECT_URL, 'cache-control': 'no-store' }); return res.end();
    }
    if (req.method === 'POST' && url === '/api/login') {
      const ip = ipOf(req);
      if (limited(`login:${ip}`, 8)) return send(res, 429, { error: '시도가 너무 많습니다. 1분 뒤 다시 해 주세요' });
      const { user = '', pass = '' } = JSON.parse((await readBody(req)) || '{}');
      if (!AUTH_PASS || (safeEq(user, AUTH_USER) && safeEq(pass, AUTH_PASS))) return send(res, 200, { ok: true }, undefined, { 'set-cookie': setCookie(req, makeToken('user', SESSION_SEC), SESSION_SEC) });
      return send(res, 401, { error: '아이디 또는 비밀번호가 맞지 않습니다' });
    }
    if (req.method === 'POST' && url === '/api/demo') return send(res, 200, { ok: true }, undefined, { 'set-cookie': setCookie(req, makeToken('demo', DEMO_SEC), DEMO_SEC) });
    if (req.method === 'POST' && url === '/api/logout') return send(res, 200, { ok: true }, undefined, { 'set-cookie': 'bs_session=; Path=/; HttpOnly; Max-Age=0' });

    const role = roleOf(req);
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(res, 200, role ? HTML.index : HTML.login, 'text/html; charset=utf-8');
    if (!role) return send(res, 401, { error: '로그인이 필요합니다' });

    if (url === '/api/quota') {   // 데모 한도 — 화면 오른쪽 아래 위젯용. 조회만 하고 횟수를 쓰지 않는다
      if (role !== 'demo') return send(res, 200, { role });
      return send(res, 200, { role, live: LIVE, day: { used: dailyUsed(), max: DEMO_DAILY_CAP }, contact: CONTACT });
    }
    if (url === '/api/meta') return send(res, 200, { role, live: LIVE, w: W, model: MODEL, chunks: idx.chunks.length, llm: LLM_MODEL, demoQuestions: Object.keys(demoCache), laws: LAWS, eval: evalSummary && { n: evalSummary.n, split: evalSummary.split, rows: evalSummary.rows.map(({ misses, byType, ...r }) => r) } });

    if (req.method === 'POST' && (url === '/api/ask' || url === '/api/search')) {
      const { q: rawQ, mode = 'hybrid', k = 5, rw = true, stream: wantStream = false } = JSON.parse((await readBody(req)) || '{}');
      if (!rawQ || typeof rawQ !== 'string' || rawQ.length > 500) return send(res, 400, { error: '질문은 1~500자로 입력해 주세요' });
      const q = norm(rawQ), kk = Math.min(Math.max(+k || 5, 1), 8);
      const searchMode = ['bm25', 'dense', 'hybrid'].includes(mode) ? mode : 'hybrid';
      // 단계 스트리밍(화면의 단계 카드) — 줄마다 JSON 하나: {step, …}. 마지막 줄은 {step:'done', …결과}
      const streaming = wantStream && url === '/api/ask';
      let opened = false;
      const open = () => { if (streaming && !opened) { opened = true; res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); } };
      const emit = (o) => { if (streaming) { open(); res.write(JSON.stringify(o) + '\n'); } };
      const finish = (code, body) => { if (!streaming) return send(res, code, body); open(); res.end(JSON.stringify({ step: 'done', status: code, ...body }) + '\n'); };
      const hitList = (hs) => hs.map((h) => ({ rank: h.rank, key: h.chunk.articleKey, label: h.chunk.label }));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      let notice;
      if (role === 'demo') {
        const cached = url === '/api/ask' && demoCache[q];
        if (cached) {   // 미리 만든 답변 — 저장된 실제 값으로 단계를 다시 보여 준다(replay 표시)
          if (streaming) {
            emit({ step: 'rewrite', replay: true, ...(cached.rewritten ? { terms: cached.rewritten.terms, laws: cached.rewritten.laws } : { skipped: true }) }); await wait(450);
            emit({ step: 'search', replay: true, mode: searchMode, ms: cached.searchMs, hits: cached.sources.filter((x) => !x.ref).map((x, i) => ({ rank: i + 1, key: x.key, label: x.label })) }); await wait(550);
            emit({ step: 'generate', replay: true, answerable: cached.answerable }); await wait(250);
          }
          return finish(200, { ...cached, demo: true, replay: true });
        }
        // 자유 질문: 토큰이 있고 한도 안이면 실시간 답변, 아니면 검색 결과만
        const live = url === '/api/ask' && LIVE && (dailyTaken() ? true : ((notice = `오늘 데모 실시간 답변 한도에 도달했습니다. 시연을 원하시면 ${CONTACT} 으로 연락 주세요. 이번 질문은 근거 조문만 보여 드립니다.`), false));
        if (!live) {
          if (url === '/api/ask' && !LIVE) notify(`[법숲] Claude 실행 못 함: 데모 방문자\n질문: ${q.slice(0, 80)}\n까닭: FINLAW_CLAUDE_TOKEN 이 없어 검색 결과만 보여 줌(beopsoop-data/claude.env 확인)`);
          const t0 = Date.now();
          emit({ step: 'rewrite', skipped: true });
          const hs = await search(idx, q, { mode: searchMode, k: kk, w: W });
          emit({ step: 'search', mode: searchMode, ms: Date.now() - t0, hits: hitList(hs) });
          return finish(200, { answer: null, notice: url === '/api/ask' ? (notice || '이 서버에는 아직 Claude 가 연결되지 않아 검색된 근거 조문만 보입니다.') : undefined, sources: hs.map(src), searchMs: Date.now() - t0, demo: true });
        }
      }

      const t0 = Date.now();
      // 운영자의 Claude 호출이 남에게 쓰이면 텔레그램으로 알린다(선택) — 데모 방문자, 관문을 거친 관리자가 아닌 계정만. 직접 로그인(운영자)은 뺀다
      const viaGate = GATEWAY_KEY && safeEq(req.headers['x-uyai-key'] || '', GATEWAY_KEY);
      const who = url !== '/api/ask' ? null : role === 'demo' ? '데모 방문자' : viaGate && req.headers['x-uyai-admin'] !== '1' ? `uyai 계정 ${String(req.headers['x-uyai-user'] || '?').slice(0, 32)}` : null;
      const st = { calls: 0, inTok: 0, cacheTok: 0, outTok: 0, cost: 0 };
      if (who) usageCtx.enterWith(st);
      // 실패해도 보낸다(사용자 질문 2026-10-27 "토큰 없어서 실패해도 오는거지?") - 인증 실패는 Claude 응답이 없어 calls 가 0 일 수 있다
      const report = (status, why = '') => {
        if (!who) return;
        notify([`[법숲] Claude 사용: ${who}`, `질문: ${q.slice(0, 80)}`, `결과: ${status}, ${Math.round((Date.now() - t0) / 1000)}초, Claude ${st.calls}번`,
          ...(why ? [`까닭: ${String(why).replace(/\s+/g, ' ').slice(0, 160)}`] : []),
          `토큰: 입력 ${st.inTok.toLocaleString()}(캐시 ${st.cacheTok.toLocaleString()}) / 출력 ${st.outTok.toLocaleString()}, 약 $${st.cost.toFixed(3)}`,
          ...(role === 'demo' ? [`오늘 데모 실시간 답변 ${dailyUsed()}/${DEMO_DAILY_CAP}`] : [])].join('\n'));
      };
      // 질의 재작성(Claude) — 실패해도 원 질문으로 검색한다. 검색만 모드에서는 쓰지 않는다
      let query = q, rewritten = null;
      if (rw && url === '/api/ask') {
        emit({ step: 'rewrite', status: 'start' });
        try { rewritten = await rewrite(q); query = expand(q, rewritten); } catch (e) { console.error('rewrite 실패:', e.message); }
        emit({ step: 'rewrite', ms: Date.now() - t0, ...(rewritten ? { terms: rewritten.terms, laws: rewritten.laws } : { failed: true }) });
      } else emit({ step: 'rewrite', skipped: true });
      const ts = Date.now();
      emit({ step: 'search', status: 'start', mode: searchMode });
      const hs = await search(idx, query, { mode: searchMode, k: kk, w: W });
      const searchMs = Date.now() - t0;
      emit({ step: 'search', mode: searchMode, ms: Date.now() - ts, hits: hitList(hs) });
      if (url === '/api/search') return send(res, 200, { sources: hs.map(src), searchMs });
      if (busy >= 2) { report('혼잡으로 답변 못 함'); return finish(429, { error: '지금 답변 중인 요청이 많습니다. 잠시 후 다시 시도해 주세요', sources: hs.map(src), searchMs }); }
      busy++;
      try {
        const t1 = Date.now(); let tn = t1;
        emit({ step: 'generate', status: 'start' });
        const onStep = streaming ? (node, u) => {
          const ms = Date.now() - tn; tn = Date.now();
          if (node === 'generate') emit({ step: 'generate', ms, answerable: u.result?.answerable });
          else if (node === 'grade') emit({ step: 'grade', ms, verdict: u.verdict });
          else if (node === 'research') emit({ step: 'research', ms, query: u.queries?.at(-1), hits: hitList(u.hits ?? []) });
        } : undefined;
        const a = await adaptiveAnswer(adaptive, q, { hits: hs, query, model: LLM_MODEL, w: W, k: kk, onStep });
        const used = a.searchHits ?? hs; // 다시 찾았으면 합쳐진 근거
        report(a.answerable === false ? '답변 불가로 판단' : '답변 완료');
        const agent = { calls: a.calls, researched: a.researched, ...(a.researched ? { query: a.queries.at(-1), missing: a.verdict?.missing } : {}), ...(a.verdict?.out_of_scope ? { outOfScope: true } : {}) };
        return finish(200, { answerable: a.answerable, answer: a.answer, cited: a.cited.map((c) => c.key), sources: [...used.map((h, i) => ({ ...src(h), rank: i + 1 })), ...a.refs.map((r, i) => ({ key: r.key, label: `${r.label}`, text: r.text, rank: used.length + i + 1, ref: true }))], searchMs, llmMs: Date.now() - t1, agent, demo: role === 'demo' || undefined, rewritten: rewritten && { terms: rewritten.terms, laws: rewritten.laws } });
      } catch (e) {
        console.error('answer 실패:', e.message);
        report('답변 생성 실패', e.message);
        return finish(200, { answer: null, error: `답변 생성에 실패했습니다(${String(e.message).slice(0, 120)}). 검색된 근거 조문은 아래에 그대로 보입니다.`, sources: hs.map(src), searchMs });
      } finally { busy--; }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log(`법숲 http://localhost:${PORT}  (chunks ${idx.chunks.length}, embed ${MODEL}, llm ${LLM_MODEL}, demo 질문 ${Object.keys(demoCache).length}개)`));
