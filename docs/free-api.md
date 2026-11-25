# OpenAI-compatible model endpoints

`draftvein` uses the OpenAI chat-completions shape. Any compatible endpoint can be used.

## Quick probe

```bash
node scripts/free-api-probe.mjs
```

The script skips providers whose environment variable is missing. It never stores keys.

## Common free or low-cost options

| Provider | Base URL | Example model | Key variable |
| --- | --- | --- | --- |
| ModelScope inference | `https://api-inference.modelscope.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | `MODELSCOPE_API_KEY` |
| Zhipu | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `ZHIPU_API_KEY` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | `SILICONFLOW_API_KEY` |
| DashScope compatible mode | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-turbo` | `DASHSCOPE_API_KEY` |
| Tencent Hunyuan | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-lite` | `HUNYUAN_API_KEY` |
| Baidu Qianfan | `https://qianfan.baidubce.com/v2` | `ernie-speed-128k` | `QIANFAN_API_KEY` |
| Pollinations | `https://text.pollinations.ai/openai` | `openai` | no key |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | a `:free` model | `OPENROUTER_API_KEY` |

Free quotas and model availability change frequently. Run the probe before relying on a provider.

## Configure draftvein

```bash
export DRAFTVEIN_PROVIDER=openai
export DRAFTVEIN_BASE_URL=https://api-inference.modelscope.cn/v1
export DRAFTVEIN_API_KEY='replace-with-your-key'
export DRAFTVEIN_MODEL='Qwen/Qwen2.5-7B-Instruct'

node src/cli.ts write --book 1 --count 1
```

Pollinations can be used without a key:

```bash
export DRAFTVEIN_PROVIDER=openai
export DRAFTVEIN_BASE_URL=https://text.pollinations.ai/openai
export DRAFTVEIN_CHAT_PATH=
export DRAFTVEIN_API_KEY=anonymous
export DRAFTVEIN_MODEL=openai
```

## Multiple endpoints and model fallback

```bash
export DRAFTVEIN_BASE_URLS="https://endpoint-a.example/v1,https://endpoint-b.example/v1"
export DRAFTVEIN_MODELS="model-a,model-b"
```

The client tries the configured endpoints/models in order. `429`, `402`, and transient server failures move on to the next candidate instead of waiting indefinitely.

## Cost and quality

- A chapter normally needs several model calls: planning, scene drafting, repair, review, and state extraction.
- Small free models can run the full pipeline but may need more retries and produce weaker prose.
- Keep API keys in environment variables or `~/.draftvein/config.json`; never commit either file.
