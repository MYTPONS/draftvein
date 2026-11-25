import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderName = 'openai' | 'mock';

export interface LlmConfig {
  provider: ProviderName;
  baseUrl: string;
  /** 多家免费端点做失败切换（按顺序尝试） */
  baseUrls: string[];
  /** 聊天补全路径，默认 /chat/completions（pollinations 这类直连端点可设空） */
  chatPath: string;
  apiKey: string;
  model: string;
  /** 模型降级链：model 打头，前一个 429/402 时自动换下一个（可缺省） */
  models?: string[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  jsonTemperature: number;
  jsonMaxTokens: number;
  disableThinking: boolean;
  frequencyPenalty: number;
  presencePenalty: number;
  topP: number;
}

export interface ForgeConfig {
  dataDir: string;
  lookahead: number;
  port: number;
  host: string;
  llm: LlmConfig;
  zuojia: ZuojiaConfig;
}

export interface ZuojiaConfig {
  /** pubtoken / x-token，作家助手登录后写入 */
  token: string;
  /** 登录后完整 cookie；某些接口需要 ywkey 等字段一起带上 */
  cookie: string;
  /** d1 设备序列号；留空则按本机 MAC 现算 */
  serial: string;
  /** 远端书 ID（CBID）与本项目的映射：{ ng_slug: cbID } */
  books: Record<string, string>;
  /** 是否允许直接发布（默认只存草稿） */
  allowPublish: boolean;
  baseUrl: string;
}

const DEFAULTS = {
  dataDir: path.join(process.env.DRAFTVEIN_HOME || path.join(os.homedir(), '.draftvein'), 'data'),
  lookahead: Number(process.env.DRAFTVEIN_LOOKAHEAD || 2),
  port: Number(process.env.DRAFTVEIN_PORT || 4260),
  host: process.env.DRAFTVEIN_HOST || '127.0.0.1',
};

function readConfigFile(): any {
  const explicit = process.env.DRAFTVEIN_CONFIG;
  const candidates = explicit
    ? [explicit]
    : [
        path.join(process.env.DRAFTVEIN_HOME || path.join(os.homedir(), '.draftvein'), 'config.json'),
      ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败 ${file}: ${(err as Error).message}`);
    }
  }
  return {};
}

export function loadConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  const file = readConfigFile();
  const llmFile = file.llm || {};
  const provider: ProviderName =
    (process.env.DRAFTVEIN_PROVIDER as ProviderName) || llmFile.provider || (process.env.DRAFTVEIN_API_KEY || llmFile.apiKey ? 'openai' : 'mock');

  const llm: LlmConfig = {
    provider,
    baseUrl:
      process.env.DRAFTVEIN_BASE_URL ||
      llmFile.baseUrl ||
      'https://api.openai.com/v1',
    baseUrls: (process.env.DRAFTVEIN_BASE_URLS || llmFile.baseUrls?.join?.(',') || '')
      .split(',')
      .map((x: string) => x.trim())
      .filter(Boolean),
    chatPath: process.env.DRAFTVEIN_CHAT_PATH ?? llmFile.chatPath ?? '/chat/completions',
    apiKey: process.env.DRAFTVEIN_API_KEY || llmFile.apiKey || '',
    model: process.env.DRAFTVEIN_MODEL || llmFile.model || 'gpt-4o-mini',
    models: (process.env.DRAFTVEIN_MODELS || llmFile.models?.join?.(',') || '')
      .split(',')
      .map((x: string) => x.trim())
      .filter(Boolean),
    temperature: Number(process.env.DRAFTVEIN_TEMPERATURE ?? llmFile.temperature ?? 0.85),
    maxTokens: Number(process.env.DRAFTVEIN_MAX_TOKENS ?? llmFile.maxTokens ?? 4000),
    timeoutMs: Number(process.env.DRAFTVEIN_TIMEOUT ?? llmFile.timeoutMs ?? 180000),
    jsonTemperature: Number(process.env.DRAFTVEIN_JSON_TEMPERATURE ?? llmFile.jsonTemperature ?? 0.4),
    jsonMaxTokens: Number(process.env.DRAFTVEIN_JSON_MAX_TOKENS ?? llmFile.jsonMaxTokens ?? 2600),
    disableThinking: (process.env.DRAFTVEIN_DISABLE_THINKING ?? String(llmFile.disableThinking ?? false)) === '1' || (process.env.DRAFTVEIN_DISABLE_THINKING ?? '') === 'true',
    frequencyPenalty: Number(process.env.DRAFTVEIN_FREQ_PENALTY ?? llmFile.frequencyPenalty ?? 0),
    presencePenalty: Number(process.env.DRAFTVEIN_PRES_PENALTY ?? llmFile.presencePenalty ?? 0),
    topP: Number(process.env.DRAFTVEIN_TOP_P ?? llmFile.topP ?? 1),
  };

  if (provider === 'openai' && !llm.apiKey) {
    throw new Error(
      '缺少 LLM apiKey：设置 DRAFTVEIN_API_KEY，或写 ~/.draftvein/config.json 的 {"llm":{"apiKey":"..."}}；无网络环境可用 DRAFTVEIN_PROVIDER=mock',
    );
  }

  const zuojiaFile = file.zuojia || {};
  const zuojia: ZuojiaConfig = {
    token: process.env.DRAFTVEIN_ZUOJIA_TOKEN || zuojiaFile.token || '',
    cookie: process.env.DRAFTVEIN_ZUOJIA_COOKIE || zuojiaFile.cookie || '',
    serial: process.env.DRAFTVEIN_ZUOJIA_SERIAL || zuojiaFile.serial || '',
    books: zuojiaFile.books || {},
    allowPublish: Boolean(zuojiaFile.allowPublish),
    baseUrl: zuojiaFile.baseUrl || 'https://pcwrite.yuewen.com',
  };

  return {
    ...DEFAULTS,
    ...file.global,
    llm,
    zuojia,
    ...overrides,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
