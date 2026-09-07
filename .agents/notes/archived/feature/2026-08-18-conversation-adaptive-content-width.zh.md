# Agent Note: 会话正文宽度自适应与拖拽调宽

Status: implemented
Archived: 2026-09-04

[English](2026-08-18-conversation-adaptive-content-width.md) | 中文

## 问题

会话列的共享宽度轴（`--dsh-chat-content-width`）是 figma 定值 748px。在宽显示器上（4000px 屏幕的会话列约 3500px）正文只占列宽不到四分之一，两侧是大片空白边距。所有派生表面——输入卡（W + 32px）、dock 卡片、takeover 面板、StatsLine、回底按钮的 padding 公式——都由这一个变量推导，任何改动都必须保持整列的对齐关系。在自适应默认值之外，用户还要求直接控制：hover 正文两侧边距出现 col-resize 光标，拖任一侧、两侧对称联动。

## 决策

**宽度轴变为"用户覆盖 + 自适应 clamp"。** `ConversationRoot.module.css` 声明 `--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px))`。下限 680px——比 figma 的 748px 低一档，因为满宽阅读在各种屏幕上都显宽——更宽的列取列宽的 64%，920px 封顶保证行长可读性（基准字号下约 113 字符）。拖拽偏好存在时整体替换自适应项。

**列宽由 ResizeObserver 发布，不用容器查询。** 组件把根节点的 `offsetWidth` 以 px 发布为 `--dsh-conversation-column-width`（与既有 composer seat 高度 observer 相同的 callback-ref 模式）。拒绝 `container-type: inline-size`：会话子树内有不经 portal 的 `position: fixed` 后代（Tooltip、Menu、JsonTree 复制锚点），尺寸容器会捕获它们的视口定位——与 `.composerHero` 注释记录的 transform 陷阱同类。拒绝变量里的裸 `%`：自定义属性百分比在各消费点按不同包含块解析，破坏输入卡 = W + 32px 不变量；拒绝 `vw`：列不等于视口（侧栏折叠只改列宽）。

**拖拽手柄是正文两侧 40px 宽的条，对称是构造性的。** 每条内边缘位于内容列外 24px、向外延伸 40px，外边缘被钳制在距列缘至少 24px 的安全区（24 + 40 + 24 = 下文每侧 88px 的预算）；边距装不下"内偏移 + 热区 + 安全区"时计算宽度为负、热区解析为零。两个手柄写同一个居中宽度——向外拖按指针位移 2 倍变宽——复用 AppFrame DragHandle 的捕获模型（指针捕获 + rAF 节流 + 拖拽起点快照）；只有指针确实产生位移的手势才提交存储，因此在被窗口钳制的宽度上按下即松开不会用钳制后的显示值覆盖更宽的已存偏好。hover 提示是跟随指针 Y 的 3px 光带（pointermove 发布 `--dsh-width-handle-pointer-y`）：24px 实色核心、两侧各 40px 渐变，用滚动条 hover 色——border token 的透明度在底色上几乎不可见。手柄只在 active 阶段渲染；选举了 composer overlay 的视图（trajectory）隐藏手柄，header 提升到手柄之上（z-index 9）保持可点。

**偏好持久化在 `localStorage`（`dsh.conversation.contentWidth`），钳制不改写。** 列收窄时显示宽度重新钳制到 `[640px, 列宽 − 176px]`（每侧预留 88px 保证手柄永远放得下），但存储的偏好保留——拉宽窗口自动恢复，与 AppFrame 侧栏拖拽同规则。手柄不带重置操作也不带 tooltip；已存储的偏好只会被下一次拖拽替换。

**用户气泡上限跟随宽度轴。** `min(525px, 82%)` 改为 `min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)`（0.702 = 525/748，即 figma 气泡占 figma 列宽的比例），`ui-conversation` MessageItem 与对称的 `ui-goal` 命令气泡同步，气泡随列缩放。748px 缺省值覆盖会话列之外的挂载。

## 备选方案

**调大常量（748 → 约 850）。** 拒绝：所有中等宽度窗口的行长一起变长，伤及多数用户的可读性。

**宽内容出血（代码块、工具卡片突破散文列）。** 阅读工效最佳但涉及 MarkdownText 和所有工具卡片布局；作为可能的二期推迟。

**settings 支持的"宽屏模式"开关。** 为拖拽已覆盖的能力增加持久设置面；不需要。

**输入卡旁 12px 手柄条。** 首版实现，实践中不可用：宽屏上千余像素的边距里只有一条细缝，且 sticky 输入卡遮挡它。改为锚定在光带位置的 40px 条。

## 影响

普通窗口的阅读宽度比 figma 基线略窄（下限 680px）。宽列正文最多放宽到 920px，拖拽可取 `[640px, 列宽 − 176px]` 内任意值，两者都不触碰任何派生表面：输入卡、dock 卡片、takeover 面板和回底公式沿用它们本就消费的宽度轴。手柄（按列居中）与内容盒（按滚动条预留后居中）之间约 4px 的已知偏差完全落在 40px 热区内。680px / 64% / 920px 三个数值在 `ConversationRoot.module.css` 一处声明、由组件内 `resolveContentWidth` 镜像；重调它们不影响其他代码。
