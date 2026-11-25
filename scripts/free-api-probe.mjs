#!/usr/bin/env node
/**
 * 免费 / 低价 OpenAI 兼容端点探活（不碰 NVIDIA NIM / AMD）。
 * 用法：
 *   node scripts/free-api-probe.mjs                 # 只测无需 key 的端点
 *   MOONSHOT_KEY=... node scripts/free-api-probe.mjs  # 也可以直接跑 curl 手动测
 */
const providers = [
  {
    name: 'ModelScope 魔搭推理 API（推荐，国内稳）',
    base: 'https://api-inference.modelscope.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyEnv: 'MODELSCOPE_API_KEY',
    note: '每天免费额度（约 2000 次/模型），需在魔搭个人中心拿 token',
  },
  {
    name: '智谱 GLM-4-Flash（永久免费）',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyEnv: 'ZHIPU_API_KEY',
    note: '免费，限速；GLM-4.5-Flash 也免费',
  },
  {
    name: '硅基流动 SiliconFlow（部分模型免费）',
    base: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyEnv: 'SILICONFLOW_API_KEY',
    note: '注册送额度，qwen2.5-7b / glm-4-9b 等有免费档',
  },
  {
    name: '阿里百炼 DashScope 兼容模式（有免费额度）',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    keyEnv: 'DASHSCOPE_API_KEY',
    note: '新用户 100 万 token 免费额度，qwen-flash 便宜',
  },
  {
    name: '腾讯混元（Lite 免费）',
    base: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-lite',
    keyEnv: 'HUNYUAN_API_KEY',
    note: 'hunyuan-lite 免费，限并发',
  },
  {
    name: '百度千帆（ERNIE-Speed 免费）',
    base: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-speed-128k',
    keyEnv: 'QIANFAN_API_KEY',
    note: 'ERNIE-Speed 系列免费，需开通',
  },
  {
    name: 'Pollinations（无需 key，45s/次）',
    base: 'https://text.pollinations.ai/openai',
    path: '',
    model: 'openai',
    keyEnv: '',
    note: '匿名档 = GPT-OSS-20B，1 次/45 秒；带 pollen key 可解限',
  },
  {
    name: 'Groq（免费额度，国内常需代理）',
    base: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
    note: '免费额度大、速度快；国内网络看运气',
  },
  {
    name: 'OpenRouter :free 模型（国内常需代理）',
    base: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat-v3-0324:free',
    keyEnv: 'OPENROUTER_API_KEY',
    note: '有 :free 后缀模型，需注册；限速',
  },
];

async function probe(p) {
  const key = p.keyEnv ? process.env[p.keyEnv] : '';
  const url = `${p.base}${p.path ?? '/chat/completions'}`;
  if (p.keyEnv && !key) return { name: p.name, status: 'skip', detail: `缺少 ${p.keyEnv}` };
  const t = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key || 'anonymous'}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: '只回两个字：可用' }],
        max_tokens: 16,
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    const ms = Date.now() - t;
    if (!res.ok) return { name: p.name, status: 'fail', detail: `HTTP ${res.status} ${text.slice(0, 120)}`, ms };
    let content = '';
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    } catch {
      content = '（非 JSON 响应）';
    }
    return { name: p.name, status: 'ok', detail: content.slice(0, 40), ms };
  } catch (err) {
    return { name: p.name, status: 'fail', detail: String(err.message || err).slice(0, 80), ms: Date.now() - t };
  }
}

const rows = [];
for (const p of providers) rows.push({ ...(await probe(p)), note: p.note, base: p.base, model: p.model, keyEnv: p.keyEnv });
console.table(rows.map((r) => ({ 名称: r.name, 状态: r.status, 耗时: r.ms ? `${r.ms}ms` : '', 结果: r.detail, base: r.base })));
const ok = rows.filter((r) => r.status === 'ok');
console.log(`\n可用 ${ok.length} / 有 key ${rows.filter((r) => r.status !== 'skip').length}；skip = 没设对应 key`);
if (ok.length) console.log('可直接用：NOVEL_FORGE_BASE_URL=' + ok[0].base + ' NOVEL_FORGE_MODEL=' + providers.find((p) => p.name === ok[0].name).model);
