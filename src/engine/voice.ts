import type { Store } from '../db/index.ts';
import type { Llm } from '../llm/client.ts';
import { type Book, updateBook } from './book.ts';
import { voicePrompt } from './prompts.ts';

export interface VoiceProfile {
  narrator: string;
  tone: string;
  diction: string;
  rhythm: string;
  dialogue: string;
  imagery: string;
  terminology: string;
  signature: string;
  avoid: string[];
  sample: string;
  createdAt: string;
}

export function readVoiceProfile(book: Book): VoiceProfile | undefined {
  let data: any = {};
  try {
    data = JSON.parse(book.data || '{}');
  } catch {
    return undefined;
  }
  const p = data.voiceProfile;
  if (!p?.tone || !p?.sample) return undefined;
  return p as VoiceProfile;
}

function normalizeProfile(raw: any): VoiceProfile {
  const text = (value: unknown, fallback: string) => String(value || fallback).trim().slice(0, 240);
  return {
    narrator: text(raw?.narrator, '贴身第三人称，跟着主视角人物的感官和误判走'),
    tone: text(raw?.tone, '自然、口语、有具体情绪，不端着'),
    diction: text(raw?.diction, '普通读者一眼看懂的话，不堆术语和官称'),
    rhythm: text(raw?.rhythm, '长短交错，短段推进，不用固定排比'),
    dialogue: text(raw?.dialogue, '对话短，允许打断和答非所问'),
    imagery: text(raw?.imagery, '只用会挡路、硌手、发潮或改变局面的物件'),
    terminology: text(raw?.terminology, '术语预算：中。行业词只在人物自然会说时出现，并且必须马上影响动作、判断或代价'),
    signature: text(raw?.signature, '这本书独有的误会、代价或叙事习惯'),
    avoid: (Array.isArray(raw?.avoid) ? raw.avoid : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 8),
    sample: String(raw?.sample || '').trim().slice(0, 600),
    createdAt: new Date().toISOString(),
  };
}

export async function ensureVoiceProfile(
  store: Store,
  llm: Llm,
  book: Book,
  opts: { signal?: AbortSignal; force?: boolean; onEvent?: (message: string) => void } = {},
): Promise<Book> {
  const existing = readVoiceProfile(book);
  if (existing && !opts.force) return book;

  const otherBooks = store.all<Book>('SELECT * FROM books WHERE id<>? ORDER BY id', book.id).map((b) => {
    const voice = readVoiceProfile(b);
    return `《${b.title}》｜${b.genre || '未定'}｜${String(b.premise || '').slice(0, 100)}｜${voice?.tone || voice?.signature || '尚未建立声纹'}`;
  });
  let data: any = {};
  try {
    data = JSON.parse(book.data || '{}');
  } catch {
    data = {};
  }
  const raw = await llm.json<any>(
    voicePrompt({
      title: book.title,
      genre: book.genre,
      premise: book.premise,
      audience: book.audience,
      authorSample: String(data.styleSample || ''),
      otherBooks,
    }),
    {
      purpose: 'voice.bootstrap',
      system: '你是小说策划，只输出 JSON。你要为每本书设计不同的叙事声纹，不能把不同作品写成同一宇宙的外传。',
      mockKind: 'voice',
      mockSeed: `${book.slug}:voice`,
      signal: opts.signal,
    },
  );
  const profile = normalizeProfile(raw);
  data.voiceProfile = profile;
  const updated = updateBook(store, book.id, { data: JSON.stringify(data) });
  opts.onEvent?.(`本书声纹已建立：${profile.tone}｜${profile.signature}`);
  return updated;
}
