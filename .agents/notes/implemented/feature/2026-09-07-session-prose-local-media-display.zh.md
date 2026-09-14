# Agent Note: 会话正文本地媒体路径通过同源文件路由显示

Status: implemented

[English](2026-09-07-session-prose-local-media-display.md) | 中文

## Problem

Assistant 正文可能通过文件系统路径引用图片，但浏览器无法读取 Host 文件。仅允许绝对 HTTP(S) 目标的渲染器会把这些引用保留为静态 alt 文本。Issue #3662 记录了这一展示缺口。

## Decision

Session 正文中的本地媒体路径通过同源文件路由渲染。本记录拥有渲染器词表及其归属；[鉴权文件系统读取](2026-09-08-file-display-through-filesystem.zh.md)拥有当前文件服务策略，并取代下文的工作区与媒体限制。

`ui-primitives` 拥有 `MarkdownText` 上的 `MarkdownPathImages` 词表。与 `fileMentions` 一样，它只在消息稳定后生效，使冻结的流式块无法缓存词表处理函数。稳定渲染过程重写远程 URL 白名单之外的图片目标，并只输出绝对 `http(s)`、`blob` 或 `data` 结果。没有词表时，本地目标保留静态 alt 文本。加载失败会把图片替换为作者提供的 alt 文本；alt 为空时显示原始目标路径；不同来源仍可重新加载。

`ui-chat` 通过 `AssistantMarkdown` 提供页面稳定的 `localPathMediaUrl` 词表。它把绝对 POSIX 路径映射到页面同源的 `/api/file?path=…`。相对路径、协议相对路径、Windows 风格路径，以及 Electron `file://` 等非 HTTP 页面传输保持静态回退。

`session-controller` 在 `SessionFileReferences` 旁拥有 `SessionMediaReferences` 贡献。它通过 `connection.fetch` 注册；该通道执行与 `/api` RPC 相同的浏览器鉴权和信任检查。固定同源端点让同步渲染器获得稳定 URL，无需异步能力协商。

## Alternatives considered

**由 Typert gateway 或 workspace controller 拥有。** gateway 拥有 Remote RPC 分发，workspace controller 拥有注册表生命周期。两者都不拥有文件字节展示；Session Controller 是服务 Session 正文的消费方。

**先经 Session RPC 获取，再使用 blob/data URL。** 附件图片可以异步获取，但此 Markdown 词表必须在记忆化渲染过程中同步解析目标。

**图片专用端点。** 单一文件路由即可服务图片、音频和视频，无需独立 URL 词表。当前实现返回有界完整文件；Markdown 音视频播放器节点仍是独立工作。

**路由中的字节签名校验。** 面向模型的 `read_image` 工具拥有图片准入检查。展示响应通过 MIME 查询描述内容，由浏览器解码拒绝损坏载荷，避免重复实现签名检查器。

**仅限工作区与媒体的访问（已取代）。** 原策略把规范路径限制在已注册工作区根目录内，并允许除 SVG 外的 image/video/audio MIME 类别。打开前的普通文件检查拒绝管道与设备；已打开句柄的身份比较收窄替换竞态。这些限制约束了鉴权后的访问范围，并避免每次请求的交互授权流程。它们也排除了临时截图与远程文件；后续记录说明替代策略及不保留这些限制的理由。

## Consequences

客户端词表无法绕过 Host 鉴权或文件系统提供方。原受限路由区分了工作区外已存在路径与缺失路径，即使拒绝其字节仍暴露存在性；后续策略则允许提供方可读的普通文件。

客户端词表仍不支持作者提供的 Windows 风格路径。轨迹与工具卡片 Markdown 消费方不提供此词表，音视频 Markdown 节点也不渲染播放器。这些属于渲染器限制，与文件路由可读的 MIME 类型无关。

已归档的[模型可读图片路径](../../archived/feature/2026-08-21-model-readable-image-paths.md)记录拥有模型侧行为；本记录拥有用户侧展示，不取代它。

## Testing

渲染器测试覆盖稳定与流式门禁、引用式图片、协议复查、加载失败回退和来源替换。聊天测试覆盖词表与组件连接。`apps/web/tests/markdown-images.e2e.ts` 浏览器场景使用已播种 Session 启动交付的 Web 组合，检查实际加载与回退文本。模型驱动的记录 Session 往返仍独立于此 UI 期望；后续记录说明当前路由覆盖。
