# 本地小模型跑 draftvein（CPU，无 GPU）

目标：不依赖任何云端 API，用魔搭（ModelScope）上的**小参数模型**跑通真实生成。

## 1. 机器与结论

本机：24 核 CPU、15 GB 内存（可用约 5-6 GB）、无 GPU、Debian 13。

结论先说：**CPU 上能跑、且能读的下限是 7B（q3/q4 GGUF）**。
1.5B / 3B 在长文生成上会明显退化（套话、复读、甚至整段循环），只适合验证链路。

## 2. 魔搭上的候选（实测过）

| 模型 | 参数 | 体积 | 结论 |
| --- | --- | --- | --- |
| `hcnote/SparkMuse-4B` | 4.1B | fp16 8.2 GB | 中文小说/角色扮演专用，**无 GGUF**，超内存 |
| `hcnote/SparkMuse-4B-INT4` | 4.1B | 2.9 GB | GPTQ-INT4，**需要 GPU + auto-gptq**，CPU 跑不了 |
| `HeteroCat/HeteroCat-DS7b-webnovel` | 7B | 10.95 GB | 网文微调，超内存 |
| `Qwen/Qwen2.5-7B-Instruct-GGUF` | 7B | q3_k_m 3.8 GB | **可用**，CPU 6 tok/s 左右 |
| `Qwen/Qwen2.5-3B-Instruct-GGUF` | 3B | q4_k_m 2.1 GB | 能跑，但长文会复读 |
| `Qwen/Qwen2.5-1.5B-Instruct-GGUF` | 1.5B | q4_k_m 1.1 GB | 只能验证链路，文笔不可用 |

> RWKV-6-ChnNovel（1B6/3B/7B）在魔搭没有可用仓库，需 rwkv.cpp 工具链，本机未走通。

## 3. 起服务（llama.cpp，OpenAI 兼容）

```bash
# 一次性：llama.cpp 预编译包 + libgomp（本机缺这个库）
mkdir -p ~/opt/llama && cd ~/opt/llama
curl -sL -o llama.tar.gz https://github.com/ggml-org/llama.cpp/releases/download/b12674/llama-b12674-bin-ubuntu-x64.tar.gz
tar xzf llama.tar.gz
mkdir -p libs && cp /path/to/libgomp.so* libs/     # 任意来源的 libgomp 都行，只要 ABI 不打架

# 模型（魔搭直链）
mkdir -p ~/models/qwen7b && cd ~/models/qwen7b
curl -sL -o qwen2.5-7b-instruct-q3_k_m.gguf \
  "https://modelscope.cn/api/v1/models/Qwen/Qwen2.5-7B-Instruct-GGUF/repo?Revision=master&FilePath=qwen2.5-7b-instruct-q3_k_m.gguf"

# 启动（仓库自带脚本）
cd ~/Projects/draftvein
PORT=8090 CTX=4096 THREADS=22 ./scripts/local-model.sh ~/models/qwen7b/qwen2.5-7b-instruct-q3_k_m.gguf
# → http://127.0.0.1:8090/v1
```

## 4. 接进 draftvein

```bash
export DRAFTVEIN_PROVIDER=openai
export DRAFTVEIN_BASE_URL=http://127.0.0.1:8090/v1
export DRAFTVEIN_API_KEY=local
export DRAFTVEIN_MODEL=local
export DRAFTVEIN_TIGHT=1            # 小模型上下文吃紧：设定 topN=6、摘要 3 章、上文 500 字
export DRAFTVEIN_MAX_TOKENS=700
export DRAFTVEIN_TIMEOUT=1800000
export DRAFTVEIN_TEMPERATURE=0.8
export DRAFTVEIN_TOP_P=0.9
export DRAFTVEIN_FREQ_PENALTY=0.6   # 小模型不加惩罚会整段复读
export DRAFTVEIN_PRES_PENALTY=0.2
export DRAFTVEIN_HOME=~/.draftvein-local

node src/cli.ts new "旧城换命" --genre 悬疑 --premise "..." --words 900
node src/cli.ts write --book 1 --count 1
```

## 5. 实测数据（本机）

| 模型 | 生成速度 | 单章（约 1200 字）耗时 | 结果 |
| --- | --- | --- | --- |
| Qwen2.5-1.5B q4 | ~21 tok/s | 未整章跑 | 套话密集，会自己写"这个小小的钩子留给读者回味" |
| Qwen2.5-3B q4 | ~10 tok/s | 9 分 24 秒 | 长文退化成整段复读，质检 63（slop + 复读）→ draft |
| Qwen2.5-7B q3 | ~6.4 tok/s | 约 10 分钟（2 节拍、关重试） | 741 字，**质检 57 → 待返工**：一丝×5、眼中闪过一丝×3、整段复述、无章末钩子；审稿指出 OOC 与拖沓。正文能读，但远没到能直接发 |

## 6. 建议

- 只想本地免费跑：7B q3/q4 是底线，必须有耐心（一章 10 分钟级）。
- 想要能发布的质量：14B+ 或 GPU，或直接用 API（DeepSeek / Qwen-Plus）。
- SparkMuse-4B 是当前最贴"专门写小说"的开源模型，但要 GPU 跑 INT4；有卡的话换它最合适。


---

# 附：微调（LoRA）只练"写小说"

目标：把通用小模型的其他能力都丢掉，只保留中文网文写法。数据、脚本、流程都在 `training/`。

## 数据
- 语料：魔搭数据集 `chenxiecang/xiaoshuo`（中文小说合集）里抽 18 本、约 710 万字。
- 切法：每 650 字窗口，取前 200-420 字为 prompt、后面 180-500 字为续写目标 → `train.jsonl 14197 条 / eval 289 条`。
- 只保留"续写"这一种指令，不混问答、不混代码，把其它能力饿死。

```bash
python training/prepare_data.py
```

## 训练（CPU，Qwen2.5-0.5B 起步）
```bash
# 依赖（uv + python3.11 + torch cpu）
uv venv --python 3.11 ~/.venvs/ft
uv pip install --python ~/.venvs/ft/bin/python torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python ~/.venvs/ft/bin/python transformers peft accelerate datasets

# LoRA：r=16/alpha=32，q/k/v/o + gate/up/down，只训练 1.75% 参数
python training/train_lora.py --steps 160 --bs 1 --accum 4 --lr 3e-4 --maxlen 320
```
实测：0.5B、fp32、24 核 CPU、seq 320 → **约 5.4 s/step**（sdpa、20 线程），160 步约 15 分钟（accum 4 时约 28 分钟）。
产物：`~/models/qwen0.5b-novel`（合并后 HF 权重）+ `lora_adapter/`（可继续增量训练）。

## 起服务（微调后模型，OpenAI 兼容）
```bash
python training/serve_hf.py --model ~/models/qwen0.5b-novel --port 8095
# → http://127.0.0.1:8095/v1
```

## 接进 draftvein
```bash
export DRAFTVEIN_PROVIDER=openai DRAFTVEIN_BASE_URL=http://127.0.0.1:8095/v1 \
       DRAFTVEIN_API_KEY=local DRAFTVEIN_MODEL=novel-lora DRAFTVEIN_TIGHT=1 \
       DRAFTVEIN_MAX_TOKENS=600 DRAFTVEIN_FREQ_PENALTY=0.6 DRAFTVEIN_PRES_PENALTY=0.2
```

## 实测结果（本机，Qwen2.5-0.5B，160 步 × accum4 = 640 样本，27 分钟）

| 指标 | base | LoRA 后 |
| --- | --- | --- |
| 三组提示套话命中 | 4 / 4 / 0 | **1 / 2 / 0** |
| 输出形态 | 散文化、跑题、爱写"【情殇】"式标题 | 出现网文排版（`【一】`、全角缩进）、对白密度明显上升 |
| 长文稳定性 | 一般会跑题 | 300-400 字内可读；再长开始退化复读 |

训练日志：`train_loss 12.38`，160 步内 loss 在 7.9-23.5 间抖（640 个样本太少，没收敛）。
产物：`~/models/qwen0.5b-novel`（合并后 1.9 GB）+ `lora_adapter/`（28 MB，可续训）。

## 边界（先说清）
- 0.5B 微调后能做到"文风更像网文、模板腔减少"，但**写不出 7B 那种复杂度**；它是"风格适配"，不是"能力跃迁"。
- 0.5B 直接长文生成会退化复读（实测服务器 200 token 就开始重复）——**这个尺寸只能证明训练链路**。
- 下一步：同一份数据/脚本换成 1.5B 或 7B。1.5B 在 fp32 LoRA 下要 ~8-9 GB 内存，本机 6 GB 空闲不够，需要 GPU 或先做 8bit/QLoRA。
- 想要真能用的成品：把同一份数据/脚本换成 1.5B/7B（内存和步时线性上升），或上 GPU。
- 继续训练：`lora_adapter/` 可以接着练（`PeftModel.from_pretrained(base, adapter)`）。
