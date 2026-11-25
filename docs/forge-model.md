# novel-forge 专属模型（forge-model）· 契约与训练

目标：训练一个**只服务本项目**的小模型——它只认 novel-forge 的 4 类任务与 JSON 契约，
离开本项目的提示词与 schema 就出不了活。这就是"严重依赖本项目"的含义。

## 1. 依赖契约（模型被绑死在这里）

**系统提示词固定为：**
```
你是 novel-forge 的写作引擎 v1。只处理四类任务：plan / scene / review / extract。
其它请求只回 {"error":"NOVELFORGE_ONLY"}。
```

| 任务 | 用户消息形态 | 输出契约（必须含） |
| --- | --- | --- |
| `plan` | `任务：plan` + 书名/本章/上一章结尾 | `title, pov, characters, goal, beats[], highlights[], expectations_plant[], expectations_pay[], hook, word_target` |
| `scene` | `任务：scene` + 章号/节拍/人物/上文 | 纯正文（无 JSON、无解释） |
| `review` | `任务：review` + 正文 | `verdict, scores{continuity,voice,pacing,information,anti_slop,characters}, issues[]` |
| `extract` | `任务：extract` + 正文 | `summary, facts[], timeline[], character_updates[], relation_updates[], thread_events[], expectation_events[], highlights[]` |

别的请求（写代码、查资料、闲聊、翻译…）一律 `{"error":"NOVELFORGE_ONLY"}`，不给通用能力。

## 2. 数据（`training/forge_sft.py`）

- 语料：魔搭 `chenxiecang/xiaoshuo` 18 本小说（约 710 万字）。
- 每个 1100 字窗口生成 1 条样本，按比例产出：`scene 2736 / plan 1419 / extract 1402 / review 1435`，
  另加 8 条"非本项目请求"负样本，总计 **7000 条**（`forge_train.jsonl`）+ 150 条评测（`forge_eval.jsonl`）。
- 所有 `quote` 字段都从原文截取，保证通过 novel-forge 的逐字校验；JSON 结构与真实流水线字段一致。

## 3. 训练（可多轮续训 = 慢慢练）

```bash
# 第 1 轮：风格（通用续写）
python training/train_lora.py --steps 160 --bs 1 --accum 4 --lr 3e-4 --maxlen 320
# 第 2 轮起：项目契约（从上轮 adapter 续训，可反复跑）
python training/train_forge.py \
  --init ~/models/qwen0.5b-novel/lora_adapter \
  --out ~/models/forge-lora --steps 60 --accum 4 --lr 2e-4 --maxlen 384
```

产物：`~/models/forge-lora/{lora_adapter,merged}`。
`--init` 指向上一轮的 `lora_adapter` 即可继续练（轮数、步数按需要加）。

## 4. 评测（是否真的被"绑死"）

```bash
python training/eval_contract.py --model ~/models/qwen0.5b        --tag base
python training/eval_contract.py --model ~/models/forge-lora/merged --tag forge
```
指标：`json_parse_rate`（能不能吐出 JSON）、`schema_rate`（四类任务必需字段齐不齐）、
`by_kind`（plan/extract/review 分别的遵循率）。对比 base 与 forge，就是"依赖度"的直接证据。

## 5. 使用

```bash
python training/serve_hf.py --model ~/models/forge-lora/merged --port 8095
export NOVEL_FORGE_PROVIDER=openai NOVEL_FORGE_BASE_URL=http://127.0.0.1:8095/v1 \
       NOVEL_FORGE_API_KEY=local NOVEL_FORGE_MODEL=novel-forge-v1 \
       NOVEL_FORGE_TIGHT=1 NOVEL_FORGE_MAX_TOKENS=600 \
       NOVEL_FORGE_SCENE_RETRIES=0 NOVEL_FORGE_REPAIR_ROUNDS=0
node src/cli.ts write --book 1 --count 1
```

## 6. 第 1-2 轮实测（0.5B，2026-11-24）

| 轮次 | 数据 | 步数 | 耗时 | train_loss |
| --- | --- | --- | --- | --- |
| 第 1 轮 风格 | 通用续写 14k | 160（≈640 样本） | 27 min | 12.38 |
| 第 2 轮 契约 | forge 7k（本文件 §2） | 60（≈240 样本） | 22 min | **3.08** |

契约评测（12 条，`training/eval_contract.py`）：

| 模型 | json_parse_rate | schema_rate |
| --- | --- | --- |
| base Qwen2.5-0.5B | 0.0 | 0.0（全部回 NOVELFORGE_ONLY） |
| forge-lora（60 步） | 0.0 | 0.0（JSON 结构错乱/长文复读） |

结论：**0.5B 学得动文风（scene 输出已是网文排版、对白密集），但学不动 JSON 契约**。
契约遵循和长文稳定性都有明显的模型容量门槛，60 步/240 样本也远不够。

## 7. 现实边界

- 0.5B 的 JSON 遵循率能练上来，但长文正文仍会退化；它的用途是**证明契约与归属**，
  不是产出成品。
- 换 1.5B/7B 用同一套数据与脚本；CPU 上 1.5B 训练需要 8-9GB 空闲内存（本机 6GB 不够），
  建议 GPU 或 QLoRA-8bit。1.5B 起 JSON 遵循才有戏（0.5B 实测 0/12）。
- 想在不换模型的前提下也"绑死"：在 `training/serve_hf.py` 外层加 schema 约束
  （固定模板 + JSON 校验 + 失败重试），让"依赖"由服务层保证，而不只靠权重。
- 想让模型更"只属于本项目"：把 `SYSTEM` 里的 `v1` 换成你的私有版本号，并在推理端强制校验该 tag。


---

## 8. 服务层绑死（`training/serve_forge.py`）

不依赖模型"自觉"吐 JSON，改由服务端掌握契约：

1. 识别 `任务：plan|extract|review|scene`；
2. JSON 任务只让模型输出 `键: 值` 行（比 JSON 好写）；
3. 服务端按项目固定 schema 组装（plan 11 键 / extract 8 键 / review 3 键）；
4. `quote` 逐字校验：正文里找不到就换成正文句子 —— 不允许编造引用；
5. 缺字段确定性兜底补全（从素材句子、已知人物表里取），保证**永远返回 schema 合法 JSON**；
6. 非这四类请求一律 `{"error":"NOVELFORGE_ONLY"}`，`/v1/forge/stats` 可查各任务计数。

实测（0.5B forge 模型挂在服务层上）：plan / extract / review 三条样例 **json_parse 3/3、schema 3/3**，
而裸模型（无服务层）是 **0/12**。这就是"绑死"的直接证据。

## 9. 1.5B 训练的实测门槛（本机）

| 尝试 | 配置 | 结果 |
| --- | --- | --- |
| bf16 + grad-ckpt | 1.5B，seq320，accum2 | 4 步跑了 12 分钟没走完一步（CPU bf16 模拟极慢 + 可用内存 0） |
| fp32 + grad-ckpt | 1.5B | 权重 6.2GB + 激活，超过本机 7GB 可用，OOM 风险 |

结论：**本机 CPU 只能练 0.5B**。1.5B 训练需要 ≥12GB 空闲内存（或 QLoRA-8bit），最佳是 GPU。
命令已经就绪，换机器直接跑：

```bash
python training/train_forge.py --model ~/models/qwen1.5b --init ~/models/qwen0.5b-novel/lora_adapter \
  --out ~/models/forge-1.5b --steps 600 --accum 4 --lr 1.5e-4 --maxlen 512 --dtype bfloat16
# GPU 版把 bf16=True 换成 fp16/bf16 + device_map，删 --grad-ckpt 即可
```

**1.5B 推理 + 服务层绑死是现在就能用的组合**：plan 单次 ~42s，schema 合法，正文质量优于 0.5B。


---

## 10. 1.5B + 服务层的实测（2026-11-24 晚）

**绑死效果（服务层统计）**：跑一章时任务分流 `plan 2 / scene 4 / review 1 / extract 1 / fallback 3`，
四类任务都走对了分支，JSON 全部由服务层组装，schema 100% 合法（不再出现裸模型的 0/12）。

**正文质量（1.5B base + 服务层，目标 500 字）**：实际 2565 字，质检 63 → 待返工；
`slop 17 次（仿佛×4、似乎×2、不禁×1…）`、对白 5%、章末落总结句、没有钩子。
正文与本书设定（当铺/名单）基本无关——1.5B 基座只会写通用悬疑腔，**必须靠微调或更大模型**。

**1.5B 训练在本机的结论**：
- bf16 + grad-ckpt、seq320、accum2：4 步跑 12 分钟没完成一步（CPU bf16 模拟 + 内存 0 空闲）；
- fp32：权重 6.2GB + 激活，超过本机 7GB 可用，OOM。
→ **本机只能练 0.5B**。1.5B 微调需要 ≥12GB 空闲内存或 GPU，命令已备好：

```bash
python training/train_forge.py --model ~/models/qwen1.5b \
  --init ~/models/qwen0.5b-novel/lora_adapter \
  --out ~/models/forge-1.5b --steps 600 --accum 4 --lr 1.5e-4 --maxlen 512 --dtype bfloat16
```

**当前可用的最佳组合**：`1.5B 推理 + serve_forge.py 严格模式`（契约 100%，但文笔一般）；
**要文笔+契约都行**：GPU 上把 1.5B/7B 用同一套数据练完，再挂同一个严格服务层。
