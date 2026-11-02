// 금융 법령 검색을 MCP 도구로 노출한다(stdio). Claude Code 가 search_law / get_article 을 불러 근거를 직접 찾아 쓴다.
//   claude mcp add finlaw -- node /경로/finlaw-rag/mcp/server.mjs     (또는 이 폴더의 .mcp.json)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildIndex, search, DEFAULTS } from '../src/index.mjs';
import { loadArticles } from '../src/chunk.mjs';

const MODEL = process.env.FINLAW_EMBED || DEFAULTS.model;
const idx = await buildIndex({ model: MODEL, strategy: DEFAULTS.strategy, log: (m) => console.error(`[finlaw] ${m}`) });
const articles = loadArticles();
const text = (t) => ({ content: [{ type: 'text', text: t }] });

const server = new McpServer({ name: 'finlaw', version: '0.1.0' });

server.registerTool('search_law', {
  description: '금융 · 개인정보 · 민법 · 전자상거래 · 소비자 · 형법 등 생활·금융 법령(시행령 포함)에서 질문과 관련된 조문을 찾는다. BM25 + 임베딩 하이브리드 검색. 결과의 조문 키로 get_article 을 불러 전문을 읽을 수 있다.',
  inputSchema: { query: z.string().describe('자연어 질문 또는 키워드'), k: z.number().int().min(1).max(10).default(5).describe('돌려줄 조문 수') },
}, async ({ query, k }) => {
  const hits = await search(idx, query, { mode: 'hybrid', k, w: DEFAULTS.w });
  return text(hits.map((h) => `${h.rank}. ${h.chunk.label}  [key: ${h.chunk.articleKey}]\n${h.chunk.text.slice(0, 500)}${h.chunk.text.length > 500 ? ' …' : ''}`).join('\n\n') || '결과 없음');
});

server.registerTool('get_article', {
  description: '법령명과 조 번호로 조문 전문을 가져온다. 예: law="개인정보 보호법", article="제34조" 또는 "제15조의2".',
  inputSchema: { law: z.string().describe('법령명(약칭 가능: 신용정보법, 신용정보법 시행령)'), article: z.string().describe('제N조 또는 제N조의M') },
}, async ({ law, article }) => {
  const m = article.match(/(\d+)(?:\s*조)?(?:\s*의\s*(\d+))?/);
  if (!m) return text(`조 번호를 해석하지 못했습니다: ${article}`);
  const a = articles.find((x) => (x.law === law || x.lawShort === law) && x.no === m[1] && (x.branch || '') === (m[2] || ''));
  if (!a) return text(`${law} 제${m[1]}조${m[2] ? `의${m[2]}` : ''} 를 찾지 못했습니다.`);
  return text(`${a.label}${a.chapter ? ` · ${a.chapter}` : ''}\n${[...a.lead, ...a.paras.flatMap((p) => p.lines)].join('\n')}`);
});

await server.connect(new StdioServerTransport());
console.error('[finlaw] MCP 서버 준비 완료');
