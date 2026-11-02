// Claude Code 를 뒤에 두고 `claude -p` 로 부른다. 임베딩은 로컬, 생성만 Claude.
//  - 로그인: FINLAW_CLAUDE_TOKEN(개인 구독 토큰, `claude setup-token`)이 **필수**다. 없으면 실행을 거부한다 — 의도하지 않은 계정이 쓰이지 않게
//    정말 기본 로그인을 쓰려면 FINLAW_ALLOW_DEFAULT_LOGIN=1.
//  - 도구 전부 끔(--tools ""), 세션 저장 끔, CLAUDE.md · 자동 메모리 끔 — 순수 "글 넣고 글 받기"로만 쓴다.
//  - 대체 순서(2026-11-02 사용자 "클로드 토큰 다 쓰면 다른 후보 토큰들도 · codex · 그게 안되면 재미니 flash라도"):
//    FINLAW_CLAUDE_TOKEN → FINLAW_CLAUDE_TOKEN_2(예비 계정) → Codex → Gemini. Codex · Gemini 는 uyai 컨테이너의 LiteLLM(ALT_LLM_URL · ALT_LLM_KEY,
//    dart-deck server/alt_llm.py)에 같은 claude -p 를 붙여 모델만 바꾼다. 한도 · 인증 실패가 난 후보는 풀릴 때까지(한도 이벤트의 resetsAt, 없으면 1시간) 건너뛴다.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { addUsage, notify } from './notify.mjs';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const WORK = mkdtempSync(join(tmpdir(), 'finlaw-llm-')); // 어느 저장소의 CLAUDE.md 도 안 읽히게 빈 폴더에서 실행
const CFG = () => process.env.FINLAW_CLAUDE_CONFIG_DIR || join(new URL('../data/', import.meta.url).pathname, 'claude-config');
const LIMIT_RE = /usage limit|limit reached|hit your (?:usage )?limit|rate[ _-]?limit|\b429\b|\b529\b|quota|overloaded|out of (?:extra )?usage|credit balance|resource.?exhausted|too many requests/i;
const AUTH_RE = /\b401\b|\b403\b|unauthori[sz]ed|authentication|oauth|invalid[^\n]{0,20}(?:token|key)|(?:token|key)[^\n]{0,20}(?:expired|revoked|invalid)/i;
const BLOCK = new Map(); // 열쇠(토큰 지문 · 'codex' · 'gemini') → 풀리는 시각(ms)
const fp = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

export function block(k, label, why, untilSec = 0) {
  const now = Date.now(); const until = untilSec * 1000 > now ? untilSec * 1000 : now + (why === 'auth' ? 6 : 1) * 3600e3;
  const fresh = !(BLOCK.get(k) > now); BLOCK.set(k, until);
  if (fresh) notify(`[법숲] ${label} ${why === 'auth' ? '인증 실패' : '사용량 한도'} — 다음 후보로 넘깁니다(다시 시도: ${new Date(until + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} KST)`);
}

// 이번 질문에 시도할 순서 — 막힌 것은 빼고, 다 막혔으면 가장 먼저 풀리는 것 하나라도
export function candidates() {
  const out = [];
  for (const [i, t] of [process.env.FINLAW_CLAUDE_TOKEN, process.env.FINLAW_CLAUDE_TOKEN_2].entries())
    if (t && !out.some((c) => c.tok === t)) out.push({ eng: 'sub', tok: t, label: i ? 'Claude 예비' : 'Claude', key: fp(t) });
  if (process.env.ALT_LLM_URL && process.env.ALT_LLM_KEY) for (const e of ['codex', 'gemini']) out.push({ eng: e, label: e === 'codex' ? 'Codex' : 'Gemini', key: e });
  const live = out.filter((c) => !(BLOCK.get(c.key) > Date.now()));
  return live.length ? live : out.sort((a, b) => (BLOCK.get(a.key) || 0) - (BLOCK.get(b.key) || 0)).slice(0, 1);
}

function runOnce(c, { system, prompt, schema, model, timeoutMs }, last) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence',
    '--system-prompt', system, '--disable-slash-commands', '--setting-sources', '', ...(schema ? ['--json-schema', JSON.stringify(schema)] : [])];
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k.startsWith('FINLAW_CLAUDE_TOKEN') || k.startsWith('ALT_LLM_') || k.startsWith('TELEGRAM_') || k === 'GATEWAY_KEY' || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
  if (c.eng === 'sub') {
    if (c.tok !== 'default') { env.CLAUDE_CODE_OAUTH_TOKEN = c.tok; env.CLAUDE_CONFIG_DIR = CFG(); mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true }); }
    args.push('--model', model);
  } else { // --bare: OAuth · 키체인을 읽지 않고 이 열쇠만 쓴다(다른 로그인이 끼지 않는다)
    Object.assign(env, { ANTHROPIC_BASE_URL: process.env.ALT_LLM_URL, ANTHROPIC_API_KEY: process.env.ALT_LLM_KEY, CLAUDE_CONFIG_DIR: CFG() + '-alt' });
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    args.push('--bare', '--model', `alt-${c.eng}`);
  }
  return new Promise((resolve) => {
    const p = spawn(CLAUDE, args, { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '', result = null, rejected = null, timed = false;
    const timer = setTimeout(() => { timed = true; p.kill('SIGKILL'); }, timeoutMs);
    const line = (l) => {
      let j; try { j = JSON.parse(l); } catch { return; }
      if (j.type === 'result') result = j;
      // 구독 한도(5시간 · 주간)가 찼다 — 추가 사용(유료)으로 넘어가기 전에 다음 후보로. 모델별 한도(opus · sonnet)는 막지 않는다
      if (j.type === 'rate_limit_event' && c.eng === 'sub' && j.rate_limit_info?.status === 'rejected' && !/opus|sonnet/.test(String(j.rate_limit_info.rateLimitType || ''))) {
        rejected = j.rate_limit_info; block(c.key, c.label, 'limit', rejected.resetsAt || 0);
        if (!last) p.kill('SIGKILL');
      }
    };
    p.stdout.on('data', (d) => { so += d; let k; while ((k = so.indexOf('\n')) >= 0) { line(so.slice(0, k)); so = so.slice(k + 1); } });
    p.stderr.on('data', (d) => (se += d));
    p.on('close', (code) => { clearTimeout(timer); if (so.trim()) line(so); resolve({ result, rejected, timed, err: se, code }); });
  });
}

export async function claudeJSON({ system, prompt, schema, model = 'sonnet', timeoutMs = 120000 }) {
  if (!process.env.FINLAW_CLAUDE_TOKEN && !process.env.FINLAW_ALLOW_DEFAULT_LOGIN && !(process.env.ALT_LLM_URL && process.env.ALT_LLM_KEY))
    throw new Error('FINLAW_CLAUDE_TOKEN 이 없습니다(개인 구독 토큰 필요 — set-token.sh 참고). 기본 로그인은 쓰지 않습니다(FINLAW_ALLOW_DEFAULT_LOGIN=1 이면 사용)');
  let cs = candidates();
  if (!cs.length && process.env.FINLAW_ALLOW_DEFAULT_LOGIN) cs = [{ eng: 'sub', tok: 'default', label: 'Claude(기본 로그인)', key: 'default' }];
  let last;
  for (const [i, c] of cs.entries()) {
    last = await runOnce(c, { system, prompt, schema, model, timeoutMs }, i === cs.length - 1);
    const j = last.result;
    if (j && !j.is_error) {
      addUsage(j.usage, j.total_cost_usd);   // 이 요청의 사용량 합계(텔레그램 알림용 - notify.mjs)
      let data = j.structured_output;
      if (data == null) { try { data = JSON.parse(String(j.result).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { data = null; } }
      return { data, text: j.result, usage: j.usage, cost: j.total_cost_usd, ms: j.duration_ms, via: c.eng === 'sub' && i === 0 && c.label === 'Claude' ? '' : c.label };
    }
    if (last.timed) throw new Error(`${c.label} 시간 초과(${timeoutMs / 1000}s)`);
    const msg = String(j?.result || last.err || `코드 ${last.code}`);
    const why = last.rejected ? 'limit' : LIMIT_RE.test(msg) ? 'limit' : AUTH_RE.test(msg) ? 'auth' : '';
    if (why && !last.rejected) block(c.key, c.label, why);
    if (!why || i === cs.length - 1) throw new Error(`${c.label} 오류: ${msg.slice(0, 300)}`);
  }
  throw new Error('쓸 수 있는 AI 가 없습니다');
}
