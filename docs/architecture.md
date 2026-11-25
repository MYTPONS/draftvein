# 架构

## 一句话
把"写小说"拆成可验证的状态机：**单章流水线 + 世界状态库 + 证据化伏笔台账 + 滚动大纲窗口**。

## 分层

```
CLI / Web 控制台（src/cli.ts, src/server, src/web）
        │  HTTP / SSE
        ▼
编排 run.ts ── 逐章循环（never batch）
        │
        ▼
chapter.ts ── 单章流水线
   ├─ outline.ts   ensurePlan / ensureWindow（只超前 lookahead 章）
   ├─ context.ts   buildContext（分层装配 + 设定检索）
   ├─ prompts.ts   plan / scene / review / extract / repair
   ├─ quality.ts   规则质检（词表 + 统计）
   └─ ledger.ts    applyThreadEvents（证据校验）
        │
        ▼
book.ts ── SQLite（node:sqlite，零依赖）
        │
        ▼
integrations/zuojia ── 作家助手直连（草稿递交）
```

## 数据模型（关键表）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `books` | 书：题材/核心设定/目标读者/每章字数 | — |
| `bible` | 设定集：世界/人物/势力/地点/物品/规则 | `kind` 分类，`importance` 参与检索排序 |
| `arcs` | 卷：宏观意图 | `start_chapter..end_chapter` 唯一覆盖 |
| `chapter_plans` | **滚动**章节计划 | `(book_id, idx)` 唯一；只存在已写+前瞻窗口 |
| `chapters` | 正文 | `(book_id, idx)` 唯一；`checks` 存质检与审稿 JSON |
| `threads` | 伏笔台账 | `code` 唯一；`plant_quote` / `resolve_quote` 存证据原句 |
| `facts` | 硬事实 | 每章抽取，审稿与规划都读 |
| `timeline` | 故事内时间线 | — |
| `runs / events` | 运行与事件流 | SSE 与日志页读它 |
| `llm_calls` | 调用计量 | 每次调用的字符数与耗时 |
| `pushes` | 递交记录 | 记录远端 `CBID/CVID/CCID`，二次递交走 update |

## 状态机

章节：`planned → drafted → reviewed`（质检 <70 或审稿要求返工则停在 `draft`）
线索：`open → resolved`，另有 `abandoned`；逾期由 `due_to < 当前章` 计算，不改状态位，避免"假装处理"。

## 为什么这样设计

1. **上下文会爆**：全书塞不进 prompt，所以装配"相关"而不是"全部"。
2. **模型会忘**：所以每章把事实/时间线/线索抽出来落库，下一章只读结构化状态。
3. **模型会撒谎**：所以伏笔回收必须给正文原句，程序核验；核验不过就拒绝。
4. **模板感来自批量**：所以只允许 lookahead 章计划，逼着每章都基于真实前文。

## 扩展点

- 新增流水线阶段：在 `chapter.ts` 里插入步骤，事件用 `emit(stage, msg)` 上报，控制台自动显示。
- 新增质检规则：`quality.ts` 的 `inspect()` 追加 Issue（severity `block` 会触发返工）。
- 新增平台：仿 `integrations/zuojia` 写一个客户端 + `push.ts` 适配即可。
