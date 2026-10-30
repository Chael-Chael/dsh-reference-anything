[中文](#cn-051) | [English](#en-051)

<h3 id="cn-051">v0.5.1</h3>

本版本基于 v0.5.0，修复引用兼容与菜单体验问题。

### 问题修复

- 修复与官方 `ui-reference` 同时启用时的引用注册冲突。官方开启时保留其引用与缓存机制，并隐藏 RA 的重复文件、会话来源；此前插入的 RA 引用仍可使用。
- 本地 Agent 查询仅对匹配且去重后的来源查询导入状态，避免无匹配时重复扫描造成等待。

### 体验优化

- 官方文件、会话来源接入显示开关、独立排序与展开/收起，支持方向键、Enter 和 Tab 操作。
- Tab 进入文件目录或进入本地 Agent 的操作、导入确认页后，仅显示当前来源；返回根级列表后恢复其他来源。
- 展开/收起操作采用灰色文字。新功能介绍卡片与演示沿用 v0.5.0。

<h3 id="en-051">v0.5.1</h3>

This patch is based on v0.5.0 and improves reference compatibility and menu behavior.

### Bug Fixes

- Fix conflicting reference registrations when the official `ui-reference` plugin is enabled. Official references and caching remain in use, duplicate RA file/session sources are hidden, and previously inserted RA references remain supported.
- Query local Agent import status only for sources contributing matched, deduplicated results, avoiding repeated scans for queries with no matches.

### Improvements

- Apply visibility toggles, independent ordering, and expand/collapse controls to official file and session sources, with arrow-key, Enter, and Tab navigation.
- Show only the active source after entering a file directory with Tab or opening a local Agent action/import confirmation page. Restore other sources on return to the root list.
- Use gray text for expand/collapse actions. Reuse the v0.5.0 feature cards and demos.

Full Changelog: [v0.5.0...v0.5.1](https://github.com/Chael-Chael/dsh-reference-anything/compare/v0.5.0...v0.5.1)
