/**
 * bench 金样层：大模型一次性核查生成 gold.json（真值参考），缓存复用。
 * 两种模式：API（ANTHROPIC_API_KEY，直接调 messages 接口）与 bundle
 * （产出自包含 prompt，用户贴给任意大模型后 --import 回填）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

export const GoldSchema = z.object({
  schemaVersion: z.literal(1),
  case: z.string().min(1),
  url: z.string().min(1),
  /** norm(pageText) 的 sha256，用于页面漂移检测 */
  pageTextHash: z.string().length(64),
  title: z.string().min(1),
  headings: z
    .array(z.object({ level: z.number().int().min(1).max(6), text: z.string().min(1) }))
    .default([]),
  paragraphs: z.array(z.string()).min(1),
  images: z.array(z.string()).default([]),
  noise_examples: z.array(z.string()).default([]),
  /** 理解层：原子事实（正文可直接找到的数字/名称/结论），自动包含匹配评分 */
  key_facts: z.array(z.string()).default([]),
  /** 理解层：问答对（仅凭主内容可答），LLM 裁判以引擎输出为唯一资料作答后对照评分 */
  qa: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).default([]),
  model: z.string().optional(),
  generatedAt: z.string().optional(),
});
export type Gold = z.infer<typeof GoldSchema>;

export const pageTextHash = (pageText: string): string =>
  crypto.createHash('sha256').update(pageText.replace(/\s+/g, '').toLowerCase()).digest('hex');

/** 构建自包含标注 prompt（角色 + 规则 + schema + 示例 + 页面文本） */
export function buildGoldPrompt(caseName: string, url: string, pageText: string): string {
  const truncated = pageText.length > 60_000 ? pageText.slice(0, 60_000) + '\n…[截断]' : pageText;
  return `你是网页内容抽取的金样标注员。下面是一段浏览器渲染后的页面可见文本（来自 ${url}）。
请只依据文本本身判断，输出该页面的"金样真值"JSON，用于客观评估各抽取引擎的效果。

规则：
1. paragraphs：页面主内容的段落，逐字保留原文（不要改写、不要总结、不要合并）。排除导航、菜单、广告、推荐位、相关文章、页脚、cookie 提示、登录/注册提示。
2. headings：主内容的标题大纲（含正文小标题），text 逐字，level 1-6 按语义层级；页面主标题 level 1。
3. images：主内容中的内容性图片（排除图标/头像/装饰），给绝对 URL；若文本中只有图片说明没有 URL 则留空数组。
4. noise_examples：从文本中挑 3-8 条明确属于非内容区域的句子/短语（如导航项、版权行、推荐标题），逐字。
5. key_facts：从主内容提炼 6-12 条原子事实（关键数字、人名/产品名、因果结论），措辞必须是正文中可直接找到的原文或其连续子串（不要概括改写、不要跨句拼接）——评分基于文本包含匹配。
6. qa：出 5-8 个理解题（{question, answer}），只凭主内容就能回答：事实细节题为主，1-2 题需要简单推理（对比/因果）。answer 要完整但不超 60 字。
7. 列表/搜索页：条目标题与摘要算主内容；翻页/排序/侧栏算噪音。
8. 只输出一个 JSON 对象，不要任何解释或 markdown 代码块包裹。

输出 JSON schema：
{
  "title": "页面主标题",
  "headings": [{ "level": 1, "text": "..." }],
  "paragraphs": ["逐字段落", "..."],
  "images": ["https://..."],
  "noise_examples": ["逐字噪音句", "..."],
  "key_facts": ["原子事实（原文措辞）", "..."],
  "qa": [{ "question": "理解题", "answer": "标准答案" }]
}

===== 页面文本开始 =====
${truncated}
===== 页面文本结束 =====`;
}

/** 从大模型返回文本中提取并校验 gold（剥 fence → parse → zod → 修复） */
export function parseGoldOutput(
  raw: string,
  ctx: { case: string; url: string; hash: string; pageUrl: string },
): Gold {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('输出中未找到 JSON 对象');
  const obj = JSON.parse(text.slice(start, end + 1));

  // 修复：丢过短/重复段落、图片绝对化、噪音去重
  const abs = (u: string): string => {
    try {
      return new URL(u, ctx.pageUrl).href;
    } catch {
      return u;
    }
  };
  obj.paragraphs = [...new Set((obj.paragraphs ?? []).map((p: string) => String(p).trim()).filter((p: string) => p.length >= 8))];
  obj.noise_examples = [...new Set((obj.noise_examples ?? []).map((n: string) => String(n).trim()).filter(Boolean))];
  obj.images = [...new Set((obj.images ?? []).map((i: string) => abs(String(i).trim())).filter(Boolean))];
  obj.key_facts = [...new Set((obj.key_facts ?? []).map((k: string) => String(k).trim()).filter((k: string) => k.length >= 4))];
  obj.qa = (obj.qa ?? [])
    .map((q: { question?: unknown; answer?: unknown }) => ({
      question: String(q.question ?? '').trim(),
      answer: String(q.answer ?? '').trim(),
    }))
    .filter((q: { question: string; answer: string }) => q.question && q.answer);
  obj.headings = (obj.headings ?? [])
    .map((h: { level?: unknown; text?: unknown }) => ({ level: Number(h.level) || 1, text: String(h.text ?? '').trim() }))
    .filter((h: { text: string }) => h.text);

  const parsed = GoldSchema.safeParse({
    schemaVersion: 1,
    case: ctx.case,
    url: ctx.url,
    pageTextHash: ctx.hash,
    title: obj.title ?? '未标注标题',
    ...obj,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`gold 校验失败: ${issues}`);
  }
  return parsed.data;
}

/** API 模式：直接调 Anthropic messages 接口（不引 SDK） */
export async function callAnthropic(prompt: string, model: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('未设置 ANTHROPIC_API_KEY');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  if (!text) throw new Error('API 返回无文本内容');
  return text;
}

/** gold.json 已存在且可用则返回：hash 匹配直接用；hash 不匹配但正文段落仍 ≥90% 命中
 * （计数/推荐位等易变区域抖动）则自愈 hash 复用；正文真漂移 → null（stale） */
/** QA 裁判：以引擎输出为唯一资料作答，对照 gold 答案逐题判定。correct=1，partial=0.5，wrong=0 */
export interface QaVerdict {
  question: string;
  verdict: 'correct' | 'partial' | 'wrong';
  note?: string;
}
export async function judgeQA(
  engineMd: string,
  qa: { question: string; answer: string }[],
  model: string,
): Promise<{ results: QaVerdict[]; accuracy: number; correct: number; total: number }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('未设置 ANTHROPIC_API_KEY');
  const prompt = `你是阅读理解裁判。下面是一份从网页抽取的 Markdown 资料（可能有缺失或噪音），以及一组题目和标准答案。
请仅依据资料作答并逐题判定：资料足以得出标准答案 → correct；部分答对/资料有缺口但可部分推出 → partial；资料不足或矛盾 → wrong。
只输出 JSON 数组：[{"question":"原题","verdict":"correct|partial|wrong","note":"≤20字理由"}]

===== 资料开始 =====
${engineMd.slice(0, 40_000)}
===== 资料结束 =====

题目与标准答案：
${qa.map((q, i) => `${i + 1}. Q: ${q.question}\n   标准答案: ${q.answer}`).join('\n')}`;
  const raw = await callAnthropic(prompt, model);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error('裁判输出无 JSON 数组');
  const arr = JSON.parse(raw.slice(start, end + 1)) as QaVerdict[];
  const results = qa.map((q) => {
    const hit = arr.find((v) => v.question === q.question);
    return { question: q.question, verdict: hit?.verdict ?? 'wrong', note: hit?.note };
  });
  const score = results.reduce((s, r) => s + (r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0), 0);
  return { results, accuracy: qa.length ? score / qa.length : 0, correct: results.filter((r) => r.verdict === 'correct').length, total: qa.length };
}

export function loadFreshGold(dir: string, pageText: string): Gold | null {
  const p = path.join(dir, 'gold.json');
  if (!fs.existsSync(p)) return null;
  let g: Gold;
  try {
    g = GoldSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
  const hash = pageTextHash(pageText);
  if (g.pageTextHash === hash) return g;
  const normText = pageText.replace(/\s+/g, '').toLowerCase();
  const covered = g.paragraphs.filter((par) => normText.includes(par.replace(/\s+/g, '').toLowerCase())).length;
  if (g.paragraphs.length && covered / g.paragraphs.length >= 0.9) {
    g.pageTextHash = hash;
    fs.writeFileSync(p, JSON.stringify(g, null, 2));
    return g;
  }
  return null;
}
