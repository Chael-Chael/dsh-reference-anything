# 接入第三方引用来源

Reference Anything 的每个来源都是一个独立的 DSH 插件。第三方来源和内置来源走同一套接口：注册后即出现在模型工具、`@` 菜单和设置面板中；插件行关闭后三处一起消失。

完整可运行示例：[`examples/reference-source-notes`](../../examples/reference-source-notes)，由 [`tests/example-source.spec.ts`](../../tests/example-source.spec.ts) 覆盖。

## 组成

| 部分 | 必需 | 做什么 | 接口 |
| --- | --- | --- | --- |
| 宿主来源 | 是 | 让模型列出、读取条目 | `ctx.references.registerSource(source)` |
| 来源设置 | 否 | 用户可改的选项，核心负责存储与迁移 | `ctx.references.defineSettings(id, definition)` |
| 附件 | 否 | 让模型取回条目附带的文件 | `source.attachments` |
| 读取上限 | 否 | 用户设定的每次读取条数 | `source.readLimit()` |
| `@` 菜单分组 | 否 | 用户在输入框里挑选条目 | 浏览器端 `ctx.referenceSources.register(group)` |
| Remote | 有菜单分组时 | 浏览器端查询宿主 | 自己的 `TypertRemoteService` 与 Typert 贡献 |

类型与浏览器安全的辅助函数都从 `dsh-reference-anything/sdk` 导入。

## 宿主来源

插件声明 `inject: ['references']`，在 `apply` 中注册：

```ts
ctx.effect(() => ctx.references.registerSource(source), 'my-source')
```

`ReferenceSource` 的约定：

- `id`：全局唯一，也是每个引用的 `source` 字段。发布后不要改：用户对话里已保存的引用依赖它。
- `requiresGrant`：条目在任务工作区之外时设为 `true`，模型只能读用户点名或本任务列出过的条目。
- `available()`：只做本地廉价检查，不发网络请求、不起子进程。
- `list(query, limit)`：只按标题等元数据匹配，不把正文摘录交给模型。
- `read(ref, window)`：有条目却读不到内容时抛错，不返回空结果。空结果会被模型当成"内容为空"。

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

1. 模型能通过 `external_reference_list` 列出并用 `external_reference_read` 读到条目。
2. 关闭插件行后，`external_reference_list` 不再包含它，`@` 菜单与设置中也不再出现。
3. 已保存的旧引用在来源关闭时读取失败并给出原因，而不是返回空内容。
