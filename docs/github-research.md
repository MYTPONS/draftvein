# GitHub 开源 AI 写小说项目调研（取长补短）

调研时间：2026-11-25。按 star 排序抓了 6 个代表项目，读 README 与架构，提炼可借鉴机制，并标注本项目已采纳/待办。

## 一、代表项目

| 项目 | ★ | 语言 | 核心做法 |
| --- | --- | --- | --- |
| [zenstory-ai/oh-story-claudecode](https://github.com/zenstory-ai/oh-story-claudecode) | 8.9k | JS | 网文 Agent 技能包：**扫榜→拆文→大纲细纲→正文→去AI味**；文件系统当记忆（`追踪/_tracking-state.json`），自动生成状态卡、伏笔清单、**作者真相/读者已知双时间线**；7 个专职角色 + 读写守卫（缺细纲、追踪未入账先拦） |
| [YILING0013/AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) | 6.5k | Python | 经典多章节生成：大纲→章节目录→逐章正文，**自动衔接上下文、伏笔管理**、向量检索（Chroma） |
| [PenglongHuang/chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill) | 5.6k | JS | 三层递进问答定设定、**偏好记忆**、中断续写；产物：人物档案 / 写作计划.json / **文风基准.md（含 AI 味负面清单）** / 章节摘要 |
| [ExplosiveCoderflome/AI-Novel-Writing-Assistant](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant) | 3.6k | TS | 世界观 + 写法引擎 + RAG(Qdrant)；**分阶段模型路由**（规划/正文/审阅/拆书各用不同模型）；角色关系图、角色时间线（计划 vs 实际出场） |
| [Xiaoyangy/novel-studio](https://github.com/Xiaoyangy/novel-studio) | 165 | Go | 多智能体世界推演 + **按弧规划** + RAG 长程记忆 + **逐章审核与断点恢复**；章节合同冻结、digest/SHA 校验、回执与承诺对账 |
| [GLFzr/QianBi-Novel](https://github.com/GLFzr/QianBi-Novel) | 51 | Python | **条目化世界书 + 正则 must 契约（确定性复检，违规拦住锁定）**、三层审校、**代价必须兑现**、字数闸门（不足扩写/超标压缩）、30 版/章 diff 回退 |

## 二、它们的共识（也是我们缺的）

1. **世界书要"条目化 + 触发词"**：不是把设定整段塞进去，而是条目带关键词，本章提到才注入。→ 我们已采纳。
2. **must 契约**：每章先声明"必须出现的东西"（物件/台词/线索/代价），写完用确定性规则核对，缺了就阻塞。→ 我们已采纳。
3. **多层记忆**：章节摘要 + 全局摘要 + 状态卡 + 双时间线（作者真相/读者已知）+ 检索。→ 我们部分有（摘要、facts、timeline），**缺"读者已知 vs 作者真相"分离**。
4. **RAG 检索旧文**：Qdrant/Chroma 向量检索；轻量做法也有 FTS。→ 我们已用 SQLite FTS5 采纳轻量版。
5. **分阶段模型路由**：规划用强模型、正文用便宜模型、审阅用第三方模型。→ 我们已支持独立审稿模型。
6. **字数闸门**：不足扩写、超标压缩（防注水），不是只告警。→ 我们只有"不足补场景"，**超标压缩待做**。
7. **版本与回滚**：每章 30 版 diff、SHA 校验、断点恢复。→ 我们只有 `revision` 计数，**无版本历史**。
8. **拆书/扫榜**：把爆款拆成 beats、节奏、爽点密度，反哺自己的大纲。→ 我们**完全没有**，是最值得补的"上游能力"。
9. **文风基准文件**：显式保存"文风指纹 + AI 味负面清单 + 基准段落"。→ 我们只有 `styleSample` 一段，较薄。
10. **人工审校模式**：作者填阻断问题，AI 只修不重写（省 token、保风格）。→ 我们有定点返工，**缺"作者填问题单 → 只修"的 UI**。

## 三、本轮已采纳（代码已落）

| 借鉴 | 实现 | 验证 |
| --- | --- | --- |
| 条目化世界书 + 触发词 | `context.ts`：bible 条目名/`tags` 命中本章目标或节拍时**强制注入**，不再只看 topN | 单测 + `pnpm verify` 36/36 |
| RAG 轻量版 | 新增 `chapters_fts`（SQLite FTS5），`saveChapter` 同步索引；装配时按本章关键词检索 2 段旧文放进 `ctx.related` | 同上 |
| must 契约 | `plan` 输出 `musts[]`（3-5 条具体物/台词/线索）→ 存 `chapter_plans.musts`；写完后 `missingMusts()` 确定性核对，缺了先**自然织入**，仍缺则 block 扣分 | 单测 `missingMusts` |
| 分阶段模型 | 已有 `NOVEL_FORGE_REVIEW_MODEL`，审稿单独模型 | 上轮已用 GLM 验收 |

## 四、进展（2026-11-25 第二轮）

- ✅ 拆书/写法模板：`src/engine/deconstruct.ts` + `cli deconstruct|templates|template-use`；模板注入规划与场景提示词。
- ✅ 作者/读者双时间线：`facts.visibility`（reader/author），上下文分两段注入，审稿查"信息泄露"。
- ✅ 字数超标压缩：>135% 目标时压缩，接受条件=字数下降且质检分不降 5 分。
- ✅ 章节版本历史：`chapter_versions` 快照 + `cli versions|rollback`。
- ✅ 作者问题单只修：`cli fix --book --chapter --quote/--paragraph --instruction`，只重写那一段并留版本。
- ✅ 角色出场时间线：`GET /books/:id/character-timeline` + 人物页「出场时间线」表（计划章/实际章/缺场/首末）。
- ✅ 章节重算：`cli recheck --book --chapter`（不重写正文，只重算质检/must/钩子）。
- 文风基准：暂用"拆书模板 + styleSample + 质检套话表"三件套代偿，独立文件待做。

## 五、待办（按收益排序）

| 优先级 | 事项 | 来源 | 说明 |
| --- | --- | --- | --- |
| P0 | **拆书/扫榜**：抓 3-5 本同题材爆款 → 拆 beats、爽点密度、章末钩子类型、人物关系，落成"写法模板" | oh-story、QianBi | 现在纯靠模型自由发挥；拆书能把"怎么写"变成可复用资产 |
| P0 | **双时间线**：`facts` 增加 `visibility: author/reader`，规划时只看"读者已知"，避免角色提前知道秘密 | oh-story | 上轮审稿多次报"角色知道了不该知道的" |
| P1 | **字数超标压缩**：>130% 时按段压缩，接受条件=字数下降且质检分不降 | QianBi | 现在一章 4400 字 vs 目标 1800 |
| P1 | **章节版本历史**：每次落库存 diff/快照，可回退 | QianBi、novel-studio | 现在只有 revision 计数 |
| P1 | **文风基准文件**：把 `styleSample` 升级成"文风指纹 + 负面清单 + 3 段基准段落" | chinese-novelist-skill | 现在只有一段样本 |
| P2 | **作者问题单 → 只修**：审稿页让作者填"哪里不对"，AI 只改那一处 | QianBi v0.19 | 省 token、保风格 |
| P2 | **角色关系图/时间线**（计划 vs 实际出场） | AI-Novel-Writing-Assistant | 我们有关系图，缺时间线视图 |

## 五、结论

我们已有的骨架（单章流水线、伏笔台账、期待兑现、爆点节奏、结构模板、体检、独立审稿模型）比多数项目更强调"闸门"；
它们比我们强的地方集中在**上游（拆书/扫榜/写法模板）**和**记忆工程（双时间线、版本、字数闸门）**。
下一轮先做 P0 两项：拆书模板 + 作者/读者双时间线，再谈整本重写。
