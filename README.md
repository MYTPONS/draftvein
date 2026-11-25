# novel-forge · 逐章推进的长篇小说写作框架

不是"一次生成 300 章标题 + 一次性把正文补齐"的流水线。它按真人写连载的方式工作：
**先有骨架 → 只规划下一章 → 一章写完再写下一章 → 每章结束后更新世界状态与伏笔台账。**

当前版本：`0.1.0`（可运行，零运行时依赖）

---

## 1. 它和市面模板生成的区别

| 市面常见做法 | novel-forge |
| --- | --- |
| 一次调用生成全书章节标题 | 只规划**当前章 + 1 章前瞻**，后面的章不存在 |
| 一次性生成整章正文 | 按**场景**逐段生成，每段看到真实的前文结尾 |
| 伏笔在大纲里列个清单 | **伏笔台账**：必须从正文里抽到原句作证据才能记账；回收也要证据 |
| 上下文塞全书 | 分层装配：骨架 / 本卷 / 相关设定 / 前情摘要 / 上一章尾部 / 到期线索 / 硬事实 |
| 质量靠模型自觉 | 规则质检（套话词表、节奏、对白比、跨章重复、章末总结）+ 独立模型审稿 + 定点返工 |
| 写完就完 | 每章抽取 事实 / 时间线 / 线索事件，写入状态库，下一章据此推进 |

关键约束写在代码里，不是写在提示词里：

- `src/engine/outline.ts` 的 `ensureWindow()` 只保证 `fromIdx .. fromIdx+lookahead` 有章计划；
- `src/engine/ledger.ts` 的 `applyThreadEvents()` 对 `payoff` 强制校验 `quote` 是否逐字出现在正文里，抽不到就拒绝并保持 `open`；
- `src/engine/quality.ts` 用词表与统计判定，不通过会触发场景重写（有上限）。

## 2. 一章的生命周期

```
ensurePlan(单章)                  只规划这一章：目标 / 3-5 个节拍 / 要收的线索 / 最多埋 1 条新线索
  └─ scene × N                    逐场景写：上下文 = 本章目标 + 本场景任务 + 已写正文尾部 + 相关设定
       └─ 局部质检                套话 / 节奏 / 字数不达标 → 带问题清单重写该场景（≤2 次）
  └─ 拼装 + 字数校准              不足就补一个收尾场景，而不是拉长已有段落
  └─ 规则质检 + 模型审稿           连续性 / 文风 / 节奏 / 信息增量 / 反 AI 味
  └─ 定点返工                     只替换被点名的原句（有上限），不整章重写
  └─ 抽取 & 记账                  摘要 / 硬事实 / 时间线 / 线索事件（证据核验）
  └─ 落库                        chapters + facts + timeline + threads
```

## 3. 快速开始

```bash
cd novel-forge

# 离线跑通全链路（不花钱、不看模型脸色）
NOVEL_FORGE_PROVIDER=mock node src/cli.ts new "旧城换命" --genre 悬疑 --premise "接了就换命的差事"
NOVEL_FORGE_PROVIDER=mock node src/cli.ts write --book 1 --count 3
NOVEL_FORGE_PROVIDER=mock node src/cli.ts serve      # http://127.0.0.1:4260

# 接真实模型（任意 OpenAI 兼容端点）
export NOVEL_FORGE_PROVIDER=openai
export NOVEL_FORGE_BASE_URL=https://api.deepseek.com/v1
export NOVEL_FORGE_API_KEY=<your-api-key>
export NOVEL_FORGE_MODEL=deepseek-chat
node src/cli.ts write --book 1 --count 1
```

配置也可以写在 `~/.novel-forge/config.json`。公开仓库提供了脱敏模板：

```bash
mkdir -p ~/.novel-forge
cp config.example.json ~/.novel-forge/config.json
chmod 600 ~/.novel-forge/config.json
```

`config.example.json` 只有占位值。真实的 `config.json`、`.env`、数据库、登录 cookie 和导出文件都已加入 `.gitignore`，不要提交。

## 4. 命令

| 命令 | 作用 |
| --- | --- |
| `serve` | 启动控制台（默认 127.0.0.1:4260） |
| `new "书名" --genre --premise` | 新建书 |
| `books` | 列出书与进度 |
| `plan --book B --from N --count K` | 只规划（不写正文），K 是前瞻窗口 |
| `write --book B [--from N] --count K` | 逐章生成，每章走完整流水线 |
| `revise --book B --idx N` | 对已落库正文只返工，不重写 |
| `show / check / outline / threads` | 看正文、质检报告、卷章计划、伏笔台账 |
| `export --book B [--dir D]` | 导出每章 txt + merged.txt + manifest（控制台可选 docx） |
| `push --book B --idx N --cbid ID [--publish]` | 递交作家助手（默认只存草稿） |
| `zuojia me\|books\|volumes` | 查作家助手登录态与远端作品 |
| `logs --book B` | 运行日志与调用统计 |

## 5. 控制台里有什么

| 页 | 内容 |
| --- | --- |
| 目录 | 码字条（今日/目标/连续/近7天/全书/日均）、**卷→章**树（卷头显示章区间/章数/字数，可新建与编辑卷）、生成台（**本书专属叙事声纹**、本章目标与节拍、出场人物 chips、运行日志 SSE） |
| 大纲 | **总纲 / 章纲 / 自定义纲**（势力谱、金手指规则…），总纲与自定义纲可写可存，章纲自动汇总当前章节计划 |
| 人物 | 人物卡（**按书隔离，不跨本复用**），默认分**主要角色 / 次要角色**并可加分类；姓名/定位/身份/性格/想要/怕/**说话方式/口头禅/禁忌**/状态/首次登场/提及章数；右侧**人物关系图**（当前关系 + 历史） |
| 伏笔台账 | 未回收/逾期/回收率/平均跨度 + 每条线索的埋/收章号与证据原句 |
| 设定与事实 | 设定集默认分**背景设定 / 其他设定**并可加分类（如"金手指规则"）+ 每章抽取的硬事实 + 故事内时间线 |
| 结构 | 结构模板（三幕 / 起点连载流 / 英雄之旅，可切换）+ 当前阶段与职能 + 阶段条与章范围 + **期待-兑现台账**（立旗/羞辱/约定/威胁/悬念 → 兑现，逾期高亮，带证据原句） |
| 爆点节奏 | 钩子覆盖率/平均强度/连续无爆点/爆点数；每章强度曲线 + 钩子点；问题清单；爆点清单（类型/强度/证据原句） |
| 体检 | 时间线冲突（死人复活/同章两地/时间倒退）、别名混用、未登记人名、毒点，按等级分组 |
| 递交 | **项目内扫码登录作家助手**、**在工作台直接创建并自动绑定远端作品**、绑定当前书写远端 CBID、远端作品列表、草稿递交记录、导出 txt / **docx**（书名+简介+标签首页） |

需求取舍与调研依据见 [docs/research.md](docs/research.md)。

## 6. 与作家助手（zuojia.write.qq.com / authorwrite）的对接

Linux 客户端 `authorwrite 5.24.0` 是 Electron 应用，所有写作请求打 `https://pcwrite.yuewen.com`。
本项目按其接口层还原了一套直连客户端（`src/integrations/zuojia/client.ts`），只做**读作品 + 写草稿**，
默认不发布。详见 [docs/authorwrite-bridge.md](docs/authorwrite-bridge.md)。

```bash
# 1) 启动工作台
pnpm start
# 2) 打开「递交」页 → 扫码登录作家助手；没有远端作品时直接点「在工作台创建远端作品」
# 3) 拉取远端作品 → 点「绑定本书」
# 4) 在章节抽屉点「递交草稿」，或使用 CLI：
node src/cli.ts push --book 1 --idx 1 --cbid 1234567
```

扫码登录由项目内的 `src/integrations/zuojia/session.ts` 管理：二维码通过工作台 API 返回，
登录成功后即时更新运行中的配置并写回 `~/.novel-forge/config.json`，无需重启服务或手改 JSON。
CLI 的 `zuojia-login` 仍保留给纯终端场景，但它复用同一登录模块。

## 7. 验收

```bash
pnpm verify        # 全量单测 + 起服务跑真实 HTTP 链路验收
pnpm visual http://127.0.0.1:4260 forge   # 桌面 1440×900 / 移动 390×844 截图 + console 采集
```

## 8. 目录

```
src/
  db/             SQLite schema 与 Store（node:sqlite，零依赖）
  llm/            OpenAI 兼容客户端（重试/超时/JSON 抽取）+ 离线 mock provider
  engine/
    book.ts       书 / 章 / 计划 / 事实 / 时间线的读写
    context.ts    上下文分层装配 + 设定检索
    prompts.ts    规划 / 场景 / 审稿 / 抽取 / 定点修补的提示词
    quality.ts    词表与统计质检
    ledger.ts     伏笔台账（证据校验、到期、健康度）
    outline.ts    滚动窗口规划，保证"只超前 lookahead 章"
    chapter.ts    单章流水线
    run.ts        逐章循环、事件流、统计
  integrations/zuojia/   作家助手直连客户端与递交
  server/        HTTP API + SSE + 静态控制台
  web/           控制台（原生 ESM，无构建）
scripts/         verify.mjs / visual.mjs
```

## 9. 故事结构 + 期待-兑现

- **结构模板**：`three_act`（三幕）/ `qidian`（黄金三章 + 立足 + 升级 + 卷末高潮 + 新篇铺垫）/ `hero`（英雄之旅）。阶段按百分比切，按规划总章数换算章号，改卷后自动对齐。规划时把"当前阶段职能"写进 prompt。
- **期待-兑现台账**（`expectations`）：读者先被勾住（羞辱/立旗/约定/威胁/悬念/许诺），后给兑现（打脸/收获/反转）。
  - 立与兑都必须带正文原句，`applyExpectationEvents()` 逐字校验；
  - 强度≥4 的爆点必须挂在一个期待上（`pays_code`），否则提示"读者不知在为哪口气憋着"；
  - 逾期未兑现（≥3 章）判 block；跨度 >12 章提示"读者早忘了"；
  - 结构页展示未兑现/逾期/兑现率/平均跨度。

## 10. 爆点 / 钩子机制（没有爆点就没人追）

写进流水线，不是靠模型自觉：

1. **规划期就有商业要求**：`pacingAdviceFor()` 会算最近几章强度，若连续 ≥2 章没有中强度爆点，下一章直接要求"强度≥4"；规划输出里必须有 `highlights`（类型/强度/爆点在哪/铺垫来自第几章）和 `hook`（章末钩子一句话）。黄金三章另有加码（1 立冲突异象、2 小胜、3 第一个爆点）。
2. **写作期**：最后一个场景被要求"结尾落在钩子上：未完成的动作 / 没说完的话 / 刚出现的东西"，禁止总结收束。
3. **落库期证据化**：抽取出的爆点必须带正文原句，`applyHighlights()` 逐字校验；没有钩子的章直接 `draft`，不算过审。
4. **审稿维度**：review 新增"本章有没有强度≥3 的爽点？章末有没有钩子？没有就 block"。
5. **可视化**：爆点节奏页给强度曲线、钩子点、连续无爆点告警、下一章建议（强度/类型/必须钩子）。

## 11. 结构层级

```
书
├─ 卷（可新建/编辑，卷有章区间；章节按卷分组显示，未归卷单列）
│   └─ 章（章号、标题、字数、状态、质检分、节拍）
├─ 大纲：总纲（主线+结局锚点）/ 章纲（自动汇总计划）/ 自定义纲（可无限加）
├─ 人物：主要角色 / 次要角色 / 自定义分类
└─ 设定：背景设定 / 其他设定 / 自定义分类
```

## 12. 单章内可做的手术

- 抽屉里每段右侧「改」：只重写这一段（下指令，如"压短一半、把最后一句改成动作"），整章其它段落不动。
- 「返工」：对已落库整章跑质检+定点替换，不重新生成。

## 13. 本地小模型（CPU，无 GPU）

不接云 API 也能跑真实模型：llama.cpp + 魔搭 GGUF，暴露 OpenAI 兼容接口。详见 [docs/local-model.md](docs/local-model.md)。

```bash
./scripts/local-model.sh ~/models/qwen7b/qwen2.5-7b-instruct-q3_k_m.gguf   # → :8090/v1
export NOVEL_FORGE_PROVIDER=openai NOVEL_FORGE_BASE_URL=http://127.0.0.1:8090/v1        NOVEL_FORGE_API_KEY=local NOVEL_FORGE_MODEL=local NOVEL_FORGE_TIGHT=1        NOVEL_FORGE_MAX_TOKENS=700 NOVEL_FORGE_TIMEOUT=1800000        NOVEL_FORGE_FREQ_PENALTY=0.6 NOVEL_FORGE_PRES_PENALTY=0.2 NOVEL_FORGE_TOP_P=0.9
node src/cli.ts write --book 1 --count 1
```

实测：3B 在长文上会整段复读（不可用）；**7B q3/q4 是 CPU 可跑的下限**，约 6 tok/s、一章 10 分钟级，仍需质检/返工拦套话。
要发布级质量：14B+、GPU，或直接接 API。SparkMuse-4B（小说/角色扮演专用）只有 fp16/GPTQ-INT4，需 GPU。

## 14. 免费在线模型（推荐先用这个）

不折腾本地 GPU 也能跑真实模型：**魔搭推理 API（每天约 2000 次）、智谱 GLM-4-Flash（永久免费）、硅基流动、阿里百炼、腾讯混元 Lite、百度千帆 ERNIE-Speed**，全都 OpenAI 兼容；
零配置兜底是 Pollinations（无需 key，1 次/45 秒）。NVIDIA NIM / AMD 端点按既定结论排除。

```bash
node scripts/free-api-probe.mjs     # 一键探活（设了对应 *_API_KEY 的会真调用一次）

export NOVEL_FORGE_PROVIDER=openai
export NOVEL_FORGE_BASE_URL=https://api-inference.modelscope.cn/v1
export NOVEL_FORGE_API_KEY=<魔搭 token>
export NOVEL_FORGE_MODEL=Qwen/Qwen2.5-7B-Instruct
node src/cli.ts write --book 1 --count 1
```

多端点自动切换：`NOVEL_FORGE_BASE_URLS="url1,url2"`，遇 429/402 会按 `retry after` 等待并换端点。
完整清单、额度、注册入口见 [docs/free-api.md](docs/free-api.md)。

## 15. 离线 mock 的正文质量

`NOVEL_FORGE_PROVIDER=mock` 用的是**组合式生成器**（人物×地点×物件×动作×细描×对白×时间，句级去重 + 对白去重 + 引号感知分句），只用来跑通链路与演示：
- 4 章实测：2739-2859 字，质检 88-94，对白占比 12-16%，跨章 12 字片段重叠 0-12%，全部 `reviewed`；
- 它仍然是模板拼句，**不代表真实模型水平**；要出成品请配 `NOVEL_FORGE_PROVIDER=openai` + 真模型。

## 16. 质量控制回路

写完整本后暴露的问题与修法（时间线按场景、爆点强制铺垫、标题去重、独立审稿模型、审稿归一化、钩子兜底、返工单调化）见
[docs/quality-loop.md](docs/quality-loop.md)。修复后用 3 章做 A/B：体检 5 block/23 warn → **1/1**，时间线误报 0，标题不再重复。

## 17. 开源项目调研与采纳

对比 GitHub 六个代表项目（oh-story 8.9k★、AI_NovelGenerator 6.5k★、chinese-novelist-skill 5.6k★、
AI-Novel-Writing-Assistant 3.6k★、novel-studio、QianBi-Novel），提炼并采纳：条目化世界书（触发词必注入）、
FTS5 检索旧文、must 契约（章节必须出现的具体物/台词，缺则 block）。待办 P0：拆书/扫榜、作者/读者双时间线。
提示词分层与 2026-11-25 的二次调研见 [docs/prompt-architecture.md](docs/prompt-architecture.md)。
详见 [docs/github-research.md](docs/github-research.md)。

## 18. 已知边界

- 只做"写"和"递交草稿"，不替作者点发布（`allowPublish` 需显式开）。
- 作家助手接口可能随客户端升级变化；`docs/authorwrite-bridge.md` 记了抓取依据与版本号，升级后按同路径重新核对。
- mock provider 只用于跑通链路与测试，正文质量不代表真实模型水平。
