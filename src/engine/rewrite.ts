/** 选中段落局部改写：只换这一段，不动整章 */
import type { Llm } from '../llm/client.ts';
import type { Book } from './book.ts';
import { styleGuide } from './context.ts';
import { readVoiceProfile } from './voice.ts';

export interface RewriteInput {
  book: Book;
  chapterIdx: number;
  paragraph: string;
  instruction: string;
  /** 段落前一段，给语感上下文 */
  before?: string;
  after?: string;
}

export async function rewriteParagraph(llm: Llm, input: RewriteInput, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const prompt = `你在改一段小说正文。只重写【目标段落】，其他都不要输出。

【本书设定】
${input.book.premise}

【文风要求】
${styleGuide(input.book.style_id, readVoiceProfile(input.book))}

【上文结尾】
${(input.before || '').slice(-300) || '（无）'}

【目标段落】
${input.paragraph}

【下文开头】
${(input.after || '').slice(0, 200) || '（无）'}

【改写要求】${input.instruction || '更像人写的：去掉套话与总结句，把情绪落到动作上，保持信息不变'}

规则：
- 字数与原段落接近（±30%），不要新增情节或人物。
- 保持人称与时态一致，不要解释设定。
- 直接输出改写后的段落正文，不要引号包裹、不要任何说明。`;
  return (
    await llm.text(prompt, {
      purpose: `rewrite.${input.chapterIdx}`,
      system: '你是小说编辑，只输出改写后的段落正文。',
      mockKind: 'rewrite',
      signal: opts.signal,
    })
  ).trim();
}
