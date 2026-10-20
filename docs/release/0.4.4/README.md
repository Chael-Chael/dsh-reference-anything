# v0.4.4 — Local Plugins and Configurable Picker Shortcuts

## English

### Discover and reference local plugins

Before v0.4.4, the `@` menu could expose files, sessions, agents, and web chats, but it could not show which local DSH plugins were installed or running. Finding a plugin meant leaving the task and checking the host or profile configuration, and plugin packages were difficult to distinguish from ordinary dependencies.

v0.4.4 adds **All local plugins** as an `@` source. It reads the active loader entries, profile bundles, and installed packages that carry DSH bundle/client metadata, while filtering out ordinary dependencies. Each result reports whether the plugin is running, disabled, or not running. When its package directory can be resolved, selecting it also inserts a native reference to that directory so the agent can inspect it with the existing file tools.

Use `@plugin:` to search. Settings can hide the group, show only running plugins, or hide official DeepSeek plugins.

### Use one shortcut for the source you mean

Previously, source prefixes were fixed and several useful words could be claimed by only one group. A provider name such as `claude` or an Agent name such as `codex` could be ambiguous, and users had to remember different built-in spellings for groups and platforms. Users also could not choose vocabulary that matched their own workflow.

v0.4.4 lets users define their own shortcuts for source groups, web providers, local agents, and cloud-drive mounts. Shared shortcuts can route to more than one source, while provider and Agent shortcuts still select the concrete provider or Agent kind. For example, a user can configure `work` for web conversations and then use `@work:meeting`, or configure `history` for local agents and use `@history:cache`. Multiple shortcuts can be entered with commas in Settings.

The routing also accepts full-width colons and keeps ordinary keywords searchable when they are not being used as a scoped prefix.

### Make folders and references behave like their type

Previously, choosing a directory from the file source could either enter the directory or insert it without a clear distinction, and the resulting reference could still look like a file. This made folder navigation and folder references easy to confuse, especially when using the keyboard.

v0.4.4 gives directory candidates two explicit keyboard actions: press **`Tab`** to drill into the directory and continue browsing its contents; press **`Enter`** to settle the selection and insert a folder reference with folder appearance and the correct trailing path. Picker and Composer icons now distinguish commands, files, folders, sessions, local agents, web providers, cloud drives, and local plugins, including native icon projection updates.

### Keep the command source complete

Some hosts do not return a `model` command even though the command is available to the user. v0.4.4 adds the `model` entry when it is missing, with localized labels and the matching command icon, so the command picker remains complete across host versions.

### Validation

- TypeScript typecheck passed.
- Production build passed.
- Client source tests passed in isolation.
- The full test run passed: 46 test files, 805 tests passed, and 8 tests were skipped.

---

## 中文

### 发现并引用本地插件

在 v0.4.3 之前，`@` 菜单可以展示文件、会话、本地 Agent 和网页端对话，但不能直接告诉用户本机安装了哪些 DSH 插件、哪些插件正在运行。查找插件通常需要离开当前任务去检查宿主或 Profile 配置，而且插件包容易和普通依赖混在一起。

v0.4.4 在 `@` 菜单中新增“本地所有的插件”来源。它会读取当前 Loader 条目、Profile 声明的 Bundle，以及带有 DSH bundle/client 元数据的已安装包，同时排除普通依赖。每个结果会显示“运行中”“已停用”或“未运行”状态。如果能解析出插件目录，选中后还会插入指向真实本地目录的原生引用，Agent 可以继续使用现有文件工具查看该目录。

可以使用 `@plugin:` 搜索。设置中可以隐藏整个插件分组、只显示运行中的插件，或隐藏 DeepSeek 官方插件。

### 用快捷词直接定位目标来源

之前的来源前缀是固定的，而且一些常用词只能归属于一个分组。比如 `claude`、`codex` 既可能指网页端 Provider，也可能指本地 Agent，用户容易遇到歧义，还需要记住不同来源的内置写法。用户也无法把快捷词改成符合自己工作习惯的名称。

v0.4.4 允许用户自定义来源分组、网页 Provider、本地 Agent 和网盘挂载的快捷词。共享快捷词可以同时路由到多个来源；Provider 和 Agent 快捷词则可以进一步定位到具体平台或 Agent 类型。例如可以把网页对话配置为 `work`，然后使用 `@work:会议`；也可以把本地 Agent 配置为 `history`，然后使用 `@history:缓存`。设置输入框支持用逗号填写多个快捷词。

路由同时兼容全角冒号；没有被配置为分组前缀的普通关键词仍然会作为普通搜索词保留。

### 让文件夹和引用行为符合实际类型

之前从文件来源选择目录时，进入目录和插入目录引用的行为不够清晰，插入后的外观也可能仍然像普通文件；使用键盘时尤其容易混淆“浏览文件夹”和“引用文件夹”。

v0.4.4 为目录候选增加了明确的键盘操作：按 **`Tab`** 进入目录并继续浏览其内容；按 **`Enter`** 确认当前选择并插入带文件夹外观和正确尾部路径的目录引用。Picker 和 Composer 中的图标也进行了更新，现在可以区分命令、文件、文件夹、会话、本地 Agent、网页 Provider、网盘和本地插件，并同步处理原生菜单的图标投影。

### 补齐命令来源

部分宿主版本不会返回 `model` 命令，但用户仍然可以使用该命令。这会导致命令 Picker 在不同宿主版本中内容不一致。

v0.4.4 会在宿主未提供时补充 `model` 入口，并提供本地化名称和对应图标，让命令列表保持一致。

### 验证

- TypeScript 类型检查通过。
- 生产构建通过。
- 客户端来源测试单独运行通过。
- 完整测试通过：46 个测试文件，805 个用例通过，8 个用例跳过。
