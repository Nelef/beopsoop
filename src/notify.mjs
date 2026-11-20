// 텔레그램 알림(선택) — 남(데모 방문자 · 관문을 거친 관리자가 아닌 계정)이 질문해 운영자의 Claude 호출(FINLAW_CLAUDE_TOKEN)이 쓰일 때 알린다.
// TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID 가 없으면 아무것도 안 한다.
// 질문 하나에 Claude 를 여러 번(재작성 · 답변 · 채점 · 다시 찾기) 부르므로, 요청마다 usageCtx 에 모아 끝날 때 한 번만 보낸다.
import { AsyncLocalStorage } from 'node:async_hooks';

export const usageCtx = new AsyncLocalStorage();

export function addUsage(usage, cost) {
  const s = usageCtx.getStore();
  if (!s) return;
  const u = usage || {};
  s.calls += 1;
  s.inTok += u.input_tokens || 0;
  s.cacheTok += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  s.outTok += u.output_tokens || 0;
  s.cost += cost || 0;
}

export function notify(text) {
  const tok = (process.env.TELEGRAM_BOT_TOKEN || '').trim(), chat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!tok || !chat) return;
  fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.error('알림 실패:', e.name));
}
