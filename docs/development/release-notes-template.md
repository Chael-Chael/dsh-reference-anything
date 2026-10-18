# Release 正文模板

用户指定参考：[DeepSeek Harness v0.2.1-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)，2026-10-18 核对实际 release 正文。

## 写作规则

- 开头提供中文 / English 锚点导航，中文在前，英文在后；用一句话交代版本性质与上次版本之间的变更范围。
- 按“新增功能、体验优化、问题修复、其他变更”分类，英文对应 New Features、Improvements、Bug Fixes、Chores。没有内容的分类两种语言一起省略。
- 每条用简短陈述说明用户可见变化。修复说明触发条件和修复后的行为；涉及兼容、迁移或实验性限制时写清楚，不仅列 commit 标题。
- 同一变化不要在多个分类重复；内部重构仅在影响用户或插件开发者时列入，其他放完整 changelog。
- 贡献者有可靠 commit/PR 依据才署名；中文条目末尾 `@name`，英文 `by @name`，不自动把提交账号当唯一实际作者，不虚构贡献者。
- 最后附实际仓库的 Full Changelog 比较链接；核对 tag 存在，待创建 tag 在审稿包里标明，不能复制上游项目链接冒充本项目。
- 中英文逐条对应，不漏掉限制；正文不附内部测试流水账。验收报告单独链接给用户。
- GIF 只用于关键新功能，紧接对应说明或放本次功能演示区，保持正文易读。媒体字幕、标题和 alt 文本同样进入用户最终审稿。
- 本模板是草稿结构，发布前替换全部占位符并核对锚点。标题采用项目实际版本/tag 命名，不照搬 DSH 的前缀。

## 待填正文

```markdown
[中文](#cn-VERSION) | [English](#en-VERSION)

本版本汇总了自 `PREVIOUS_VERSION` 以来的主要变更。VERSION_CONTEXT

<h3 id="cn-VERSION">新增功能</h3>

- NEW_FEATURE_DESCRIPTION

### 体验优化

- IMPROVEMENT_DESCRIPTION

### 问题修复

- FIX_DESCRIPTION

### 其他变更

- COMPATIBILITY_OR_OTHER_CHANGE

<h3 id="en-VERSION">New Features</h3>

This release includes the main changes since `PREVIOUS_VERSION`. VERSION_CONTEXT_EN

- NEW_FEATURE_DESCRIPTION_EN

### Improvements

- IMPROVEMENT_DESCRIPTION_EN

### Bug Fixes

- FIX_DESCRIPTION_EN

### Chores

- COMPATIBILITY_OR_OTHER_CHANGE_EN

Full Changelog: [PREVIOUS_TAG...CURRENT_TAG](https://github.com/Chael-Chael/dsh-reference-anything/compare/PREVIOUS_TAG...CURRENT_TAG)
```
