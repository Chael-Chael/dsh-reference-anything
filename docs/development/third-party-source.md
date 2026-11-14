# 接入第三方引用来源

Reference Anything 的每个来源都是一个独立的 DSH 插件。第三方来源和内置来源走同一套接口：注册后即可经单一 `reference` 工具读取，并出现在 `@` 菜单和设置面板中；插件行关闭后三处一起消失。

让 Agent 来写：核心插件注册技能 `reference-source-author`（正文为 [`skills/reference-source-author/SKILL.md`](../../skills/reference-source-author/SKILL.md) 加上下方示例的完整代码，并填入当前 profile 与 DSH 版本）。设置页「@ 来源」列表下的「立即尝试」会新建对话并预填 `/reference-source-author …`；技能只在调用时加载，平时不占模型上下文。改本文的接口约定时同步修改该技能。

完整可运行示例：[`examples/reference-source-notes`](../../examples/reference-source-notes)，由 [`tests/example-source.spec.ts`](../../tests/example-source.spec.ts) 覆盖。

## 组成

| 部分 | 必需 | 做什么 | 接口 |
| --- | --- | --- | --- |
| 来源插件 | 是 | 让模型通过 `reference` 工具列出、搜索、读取条目 | `ctx.references.registerPlugin(defineReferenceSource({ source, load, list }))` |
| 来源设置 | 否 | 用户可改的选项，核心负责存储与迁移 | `ctx.references.defineSettings(id, definition)` |
| 子项（附件） | 否 | 图片、文件作为子 id，模型用 `read` + `as: "image" \| "file"` 取回 | `ReferenceDoc.children` + `fetch` |
| `@` 菜单分组 | 否 | 用户在输入框里挑选条目 | 浏览器端 `ctx.referenceSources.register(group)` |
| Remote | 有菜单分组时 | 浏览器端查询宿主 | 自己的 `TypertRemoteService` 与 Typert 贡献 |

宿主端的 `defineReferenceSource`、`referenceError`、`readAllText` 从 `dsh-reference-anything/source` 导入；类型与浏览器安全的辅助函数从 `dsh-reference-anything/sdk` 导入。

## 来源插件（2026-11-14 单一 `reference` 工具，设计见[方案](../ideas/reference-single-tool.md)）

插件声明 `inject: ['references']`，在 `apply` 中注册：

```ts
import { defineReferenceSource, referenceError } from 'dsh-reference-anything/source'

ctx.effect(() => ctx.references.registerPlugin(defineReferenceSource({
  source: 'notes',
  usage: 'Notes from one folder. Ids are file names such as plan.md.',
  async list(query) { return { items: [{ id: 'plan.md', title: 'plan.md', updatedAt: 0 }] } },
  async load(id, signal) { return { title: id, content: [{ role: 'document', text: '...' }] } },
})), 'my-source')
```

模型只有一个工具 `reference({ source, id?, op: 'list' | 'search' | 'read', args })`，通用参数 `query`、`limit`、`next`、`as`。`defineReferenceSource` 根据 `load` 自动提供分页、`next` 续读、字面搜索、revision 校验、子项列出与读取以及 `@` 预览；作者不计算位置。

约定：

- `source`：插件类别，也是宿主唯一的路由键与授权键前缀。小写字母开头，只含小写字母、数字和 `-`；发布后不要改。重复注册报 `SOURCE_DUPLICATE`。
- `id`：由插件发放，跨重启有效，可逆编码、不建登记表；不含凭据、用户名或绝对路径，也不能让 `..` 跳出范围。`>` 保留给子项（`<id>><key>`）。
- 授权：只有用户 `@` 才授权该 id 及其子项。不带 id 的 `list` 与按标题 `search` 只返回元数据、不授权；`read` 与 id 内 `search` 未授权时报 `UNAUTHORIZED`。工具结果里出现的引用不算授权。
- `load(id, signal)`：返回 `{ title, content: [{ role?, text }], children?, partial?, notice? }`。条目不存在或不允许读时抛 `referenceError(code, message)`，不返回空结果；每次调用都重查自己的开关、目录与账号。文件内容用 `role: 'document'`。
- `list(query, args, call)`：只按标题等元数据匹配，不把正文交给模型。
- 子项：`children: [{ key, title, kind: 'image' | 'file' | 'text', item? }]`，二进制子项由 `fetch(id, child, maxBytes)` 返回字节；核心负责落盘、类型检测、≤10 MiB 图片附像素与清理，上限由 `files.maxBytes` 决定。
- 错误：模型看到 `{ code, message, retry }`，`code` 为 `NOT_FOUND`、`UNAUTHORIZED`、`SOURCE_DISABLED`、`SOURCE_UNAVAILABLE`、`REVISION_CHANGED`、`UNSUPPORTED_OP`、`INVALID_ARGS`、`BUDGET_EXCEEDED`，`retry` 为 `relist`、`restart`、`none`。
- 自带服务端分页的数据源可以直接实现 `ReferenceSourcePlugin`（`describe`、`list?`、`search?`、`read`），但必须在预算内产出并给出 `next`（宿主超预算只报错不截断），并用 `readAllText` 自测：按 `next` 拼接须逐字还原原文。

### 旧接口 `registerSource`

旧的 `ctx.references.registerSource(source)`（`ReferenceSource`：`available`、`list`、`read`、`attachments`）继续可用：核心把它包装成同名来源插件（`cloud-drive` 对应 `drive`，`local-plugin` 对应 `plugin`），按窗口从新到旧读完整条目（最多 2000 条，超出标为不完整）。新来源请直接用 `defineReferenceSource`。

## 来源设置

```ts
const settings = ctx.references.defineSettings('my-source', {
  schema,                 // zod schema
  defaults,               // schema 通过的默认值
  prepare: async (next, previous) => next,   // 可选：保存前校验（例如目录必须存在）
})
settings.get()            // 同步读取当前值
```

- 每个来源一条记录，核心不读其中字段；值在插件卸载后保留，重新启用时恢复。
- 设置开关只影响本来源。需要拦截读取的开关（例如"关闭某个账号"），要在 `list` 与 `read` 里都检查，不能只在菜单里隐藏。

## `@` 菜单分组

浏览器端插件声明 `inject: ['remote', 'referenceSources']`：

```ts
ctx.effect(() => ctx.referenceSources.register({
  id: 'notes', label: 'Notes', hostSource: 'notes', order: 45, aliases: ['note'],
  create: options => ({ trigger: '@', name: 'Notes', order: options.order, candidates, onPick, codec }),
}))
```

- `hostSource` 填宿主来源 id：来源未加载时分组自动隐藏。
- `create(options)` 收到用户在设置中为该分组配置的顺序、条数和快捷词；核心再套上统一的折叠与展开行为。
- 用 `scopedGroupQuery(query, id, options)` 处理 `note:` 这类前缀，用 `formatReferenceMention(ref, label)` 生成插入文本。
- 插入的 `appearance` 只能是 `file`、`folder` 或 `session`（DSH 输入框的限制）。

## Remote

分组要从宿主取候选时，宿主端挂一个 `TypertRemoteService`，浏览器端用 `ctx.remote.$mount` 挂同一份调用描述。两点必须遵守：

1. Typert 每个包名只接受一份贡献：用自己的包名，不要复用 `dsh-reference-anything`。
2. 宿主端放在 `ctx.inject(['typert'], ...)` 里挂载，没有 Typert 的环境中来源仍可供模型使用。

## 打包

- 包内 `cordis.patch.yml` 插入一行（如 `id: reference-notes`），用户即可在插件页单独开关。
- `package.json` 的 `dsh.client.inject` 写 `dsh-reference-anything`，保证浏览器端在注册表之后加载。
- 浏览器端代码只挂在包名对应的行上，所以一个有菜单分组的来源发布为独立 npm 包。

## 自测清单

1. 模型能用 `reference({ source, op: 'list' })` 列出条目；用户 `@` 之后能 `read` 读到、在 id 内 `search` 搜到；有附件时 `list` 该 id 列出子项，`read` 子 id 加 `as: "file"` 能取回。
2. 关闭插件行后，`reference` 工具不再路由到它，`@` 菜单与设置中也不再出现。
3. 已保存的旧引用在来源关闭时读取失败并给出原因，而不是返回空内容。
