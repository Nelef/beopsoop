// Claude Code 를 뒤에 두고 `claude -p` 로 부른다. 임베딩은 로컬, 생성만 Claude.
//  - 로그인: FINLAW_CLAUDE_TOKEN(개인 구독 토큰, `claude setup-token`)이 **필수**다. 없으면 실행을 거부한다 — 의도하지 않은 계정이 쓰이지 않게
//    정말 기본 로그인을 쓰려면 FINLAW_ALLOW_DEFAULT_LOGIN=1.
//  - 도구 전부 끔(--tools ""), 세션 저장 끔, CLAUDE.md · 자동 메모리 끔 — 순수 "글 넣고 글 받기"로만 쓴다.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsage } from './notify.mjs';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const WORK = mkdtempSync(join(tmpdir(), 'finlaw-llm-')); // 어느 저장소의 CLAUDE.md 도 안 읽히게 빈 폴더에서 실행

export function claudeJSON({ system, prompt, schema, model = 'sonnet', timeoutMs = 120000 }) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--tools', '', '--no-session-persistence',
    '--system-prompt', system, '--disable-slash-commands', '--setting-sources', '', ...(schema ? ['--json-schema', JSON.stringify(schema)] : [])];
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
  if (!process.env.FINLAW_CLAUDE_TOKEN && !process.env.FINLAW_ALLOW_DEFAULT_LOGIN) return Promise.reject(new Error('FINLAW_CLAUDE_TOKEN 이 없습니다(개인 구독 토큰 필요 — set-token.sh 참고). 기본 로그인은 쓰지 않습니다(FINLAW_ALLOW_DEFAULT_LOGIN=1 이면 사용)'));
  if (process.env.FINLAW_CLAUDE_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.FINLAW_CLAUDE_TOKEN;
    env.CLAUDE_CONFIG_DIR = process.env.FINLAW_CLAUDE_CONFIG_DIR || join(new URL('../data/', import.meta.url).pathname, 'claude-config');
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  }
  return new Promise((resolve, reject) => {
    const p = spawn(CLAUDE, args, { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`claude 시간 초과(${timeoutMs / 1000}s)`)); }, timeoutMs);
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (se += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      let j; try { j = JSON.parse(so); } catch { return reject(new Error(`claude 출력 파싱 실패(code ${code}): ${(so || se).slice(0, 300)}`)); }
      addUsage(j.usage, j.total_cost_usd);   // 이 요청의 Claude 사용량 합계(텔레그램 알림용 - notify.mjs)
      if (j.is_error) return reject(new Error(`claude 오류: ${String(j.result).slice(0, 300)}`));
      let data = j.structured_output;
      if (data == null) { try { data = JSON.parse(String(j.result).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { data = null; } }
      resolve({ data, text: j.result, usage: j.usage, cost: j.total_cost_usd, ms: j.duration_ms });
    });
  });
}
