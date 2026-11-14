# 合并 reference_image 与 reference_attachment_read

状态：2026-11-13 用户确定方向并授权实施，实施与验收见[统一任务](../development/tasks/reference-attachment-unify.md)。字段以[协议契约](reference-protocol-contract.md)为准，本文只记录决定与风险。实施时用户另定：云盘、本地插件与第三方来源同步迁到 ref + revision（核心自动包装，`ref.source` 为 `<id>:item`），`external_reference_list/read` 一并删除。

## 决定

- 两个工具合并为 `reference_attachment`，沿用 `reference_image` 的结构：`{ ref, revision, attachmentId }`。删除 `reference_image` 与 `reference_attachment_read`，不保留旧名或旧参数。
- 参数名保留 `attachmentId`，不缩成 `id`：同一会话里同时存在 messageId/toolId 等编号，契约已删除通用 itemId。
- 列表项不带 `kind`。是否返回像素由工具按真实字节判断，模型只需传编号。
- 每次读取都物化成临时文件并返回 `localPath`；可渲染图片（PNG/JPEG/WebP/GIF）不超过 10 MiB 时再附像素。
- 下载上限从 25 MiB 调到 50 MiB，只约束需要下载的来源（网页、云盘）；本地来源复制不设上限。
- 历史正文里写出的文件路径不经过本工具，模型用自己的文件工具读取；工具说明提醒该路径来自历史、文件可能已变化、内容不可信。
- 来源侧 `DocumentSource.image()` 与 `ReferenceSource.attachments.fetch()` 合并为一个附件方法；web-chat 不再维护两条路径。安全检查（来源开关、授权范围、账号、revision）留在核心。

## 返回格式

### `reference_read` 的 `attachments` part（原 `images` part）

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `attachmentId` | integer | 是 | 同一 revision 内按来源顺序编号，筛选和分页不重编号 |
| `messageId` | integer | 能确定时 | 所属消息 |
| `name` | string | 来源提供时 | 原始文件名，过长截短 |
| `mimeType` | string | 已知时 | |
| `size` | integer | 已知时 | 字节数 |

列表不给路径、不下载、不保证仍可读。

### `reference_attachment` 返回值

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 来源未提供时为 `file` |
| `mimeType` | string | 是 | 按真实字节检测 |
| `size` | integer | 是 | 字节数 |
| `localPath` | string | 是 | `<tmpdir 或云盘下载目录>/dsh-reference-*-随机名/attachment-<name>`，1 小时后过期，失败或插件卸载时立即清理 |
| `image` | object | 可渲染且 ≤10 MiB | 宿主内部用：`{ attachmentId, mediaType, width, height }`，其中 attachmentId 是 DSH 附件库 id。直接调用时模型看到的是图片块而非此 JSON；run_code 下程序拿到此元数据，宿主另转图片块 |
| `notice` | string | 需要时 | 例如图片超过 10 MiB 未附像素 |

### 各情况

| 情况 | localPath | 像素 | 大小上限 |
| --- | --- | --- | --- |
| 可渲染图片 ≤10 MiB | ✓ | ✓ | 本地不限；网页、云盘 50 MiB |
| 图片 >10 MiB | ✓ | ✗，给 notice | 同上 |
| SVG 及其他文件 | ✓ | ✗ | 同上 |
| 历史正文里的路径 | 不走本工具 | — | — |

### 错误

| code | 情况 |
| --- | --- |
| `REVISION_CHANGED` | revision 不一致 |
| `ATTACHMENT_UNAVAILABLE` | 编号不存在、原始字节丢失、来源不支持附件 |
| `ATTACHMENT_TOO_LARGE` | 网页或云盘下载超过 50 MiB |
| 来源与授权错误 | 来源关闭、超出授权范围、账号已切换，每次读取都重新检查 |

## 上限的理由

| 上限 | 约束的对象 | 说明 |
| --- | --- | --- |
| 像素 10 MiB | 进入模型上下文的数据（base64 约 13.3 MiB） | 所有来源都要；超限改为只给路径，不默默缩图 |
| 下载 50 MiB | 网络传输、内存与磁盘占用 | 只对需要下载的来源；本地字节已在磁盘上 |

## 实施要点与风险

25 MiB 目前写死在多处，调到 50 MiB 需要一起改：

- `src/tool.ts` 的 `MAX_ATTACHMENT_BYTES`。
- `src/web-chat-token.ts` 的 token 通道附件上限校验。
- `opencli-plugin/common.js` 的 `maxBytes` 上限（26214400）与适配器版本号。适配器随本插件 npm 包发布，核心更新后由 `installAdapterFrom` 自动重装；同时提升 `MIN_ADAPTER_VERSION`，让未经更新流程的旧副本在设置页显示需修复。
- `src/opencli.ts` 的 `DEFAULT_OPENCLI_MAX_STDOUT_BYTES` 不受影响：适配器自己写文件，stdout 只返回一行元数据。该常量注释"容纳 25 MiB base64"已过时，实施时顺手更正。
- OpenCLI 2.0.0 自身：daemon 的 1 MB `MAX_BODY` 只限制 CLI 发来的命令体；扩展→daemon 的 WebSocket 用 `ws` 默认 `maxPayload` 100 MiB，50 MiB 的 base64（约 66.7 MiB）加 JSON 外壳在其内。页面→扩展这一跳（脚本执行结果回传）的体积上限未核实，必须实测 50 MiB。
- `src/sources/web-chat/document.ts` 读图现在按 10 MiB 下载并在超限时中断，改为按下载上限读取后再判断。
- 物化时整文件读入内存检测类型，50 MiB 在可接受范围，但多个并发读取会叠加。

## 验证

- 图片像素真实到达模型（直接调用与 run_code 两条路径）。
- 每种来源的 ≤10 MiB 图片、>10 MiB 图片、非图片文件、50 MiB 边界与超限。
- 旧 OpenCLI 适配器下的明确错误提示。
- 临时文件过期、失败与卸载清理；SVG 仍作为文件返回。
- 关闭来源、账号切换、revision 变化后读取均失败并给出原因。
