# Prompt Architecture

调研时间：2026-11-25。目标：把提示词从“针对方言/样章的规则集合”改成可跨题材复用的分层架构。

## 外部参考

本轮直接阅读了以下公开项目的实际 prompt/工作流文件（不复制其 prompt 内容）：

- [YILING0013/AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator)
  - 任务流把 `write_chapter`、`plan_chapters`、`check_chapter_world_rules` 等拆成独立 prompt。
  - 写作 prompt 只注入当前章计划、当前场景、边界、人物/事实/前文，不把全书灌进去。
  - 规划、正文、世界规则检查、心理状态检查是不同职责，不把所有约束塞进写作 prompt。
- [MaoXiaoYuZ/Long-Novel-GPT](https://github.com/MaoXiaoYuZ/Long-Novel-GPT)
  - `system_prompt.txt`、`context_prompt.txt`、章节/正文/审阅 prompt 分离。
  - 写作、提取上下文、生成修改意见、重写分别使用不同 prompt 和输出格式。
- [PenglongHuang/chinese-novelist-skill](https://github.com/PenglongHuang/chinese-novelist-skill)
  - 逐章 checklist 先读大纲、人物、上一章结尾和文风基准，再写正文。
  - 第一章定稿后从正文提取校准段落，作为后续章节的“本书文风锚点”。
  - 去 AI 味、连续性、数字一致性、信息边界、章节摘要分阶段处理。
- [xiamuceer-j/MuMuAINovel](https://github.com/xiamuceer-j/MuMuAINovel)
  - 长篇写作 Skill、去 AI 味 Skill、角色/大纲/章节重写提示词分文件管理。
  - `anti-ai-writing.md` 将去 AI 味作为独立审查/润色层，而不是写作 prompt 里的超长禁令。
- [NousResearch/autonovel](https://github.com/NousResearch/autonovel)
  - `voice.md` 明确分成“永久通用 Guardrails”和“本书 Voice Identity”两部分。
  - 正文 draft prompt 只给 voice、本章 outline、下一章衔接、上一章结尾、world/characters。
  - slop 检查、审稿、revision 由后面的独立阶段完成。

## 采用的通用原则

1. **通用层和本书层分离**
   - 通用层：小说写作的基本逻辑、POV、输出格式、事实边界。
   - 本书层：voice profile、人物卡、世界书、章节计划、作者样本。
   - 禁止把某本样章的人名、物件、行业词写进全局 prompt。

2. **写作 prompt 保持短**
   - 只回答：这一场是谁、想做什么、遇到什么阻碍、最后局面如何变化。
   - 不把环境段配额、对白配额、术语配额、段落模板、禁词表全部塞给写手。
   - 这些检查进入独立 reviewer / quality 阶段，避免模型逐条“表演规则”。

3. **每本书独立 voice**
   - voice 包含叙述距离、语气、用词、节奏、对话、意象、术语预算、signature、avoid、原创 sample。
   - 生成 voice 时参考工作区其它书，要求拉开差异。
   - 没有本书样本时，不使用全项目共用范文。

4. **事实边界**
   - 计划不等于已发生事实。
   - 人物只能使用已知道的信息。
   - 缺失信息保持未知，不补造。

5. **写、审、改分离**
   - planner 负责章节结构。
   - writer 负责把当前场景写成正文。
   - reviewer 负责连续性、人物声音、信息边界、可读性。
   - quality 负责确定性结构检查。
   - repair 只改被点名的问题，不做整章重写。

6. **结构性质量优先于词表**
   - 检查全名段首比例、把字流程句密度、技术缩写密度、对白墙、碎句比例、重复段落、地点锚点。
   - 不在全局配置里维护“某本书的稀有词列表”。

## 本项目当前分层

```text
BASE_SYSTEM（通用写作身份，短）
  └─ Book Voice Profile（每本书独立声纹）
      └─ Chapter Brief（本章任务/场景/POV/前文）
          └─ Writer Prompt（只写当前场景）
              └─ Reviewer（人物/事实/可读性/voice）
                  └─ Quality Gates（确定性结构检查）
                      └─ Targeted Repair（只改点名问题）
```

## 防回退

`test/generic-prompts.test.ts` 会扫描全局 prompt/quality 源文件，禁止重新出现样章专属词或具体设备词。具体题材词只能出现在：

- 本书的 `voiceProfile`
- 本书正文/设定/人物数据
- 测试夹具
- 文档里的调研示例
