# Agent Note: Web agent 获得显式运行时上下文

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-web-agent-runtime-context.md) | 中文

## 问题

CLI（命令行界面）共享 base 配置了空的部署 persona，Web overlay 没有替换它，而 Web 启动器既未添加源码提示词段，也未添加交互界面提示词段。会话 header 会记录工作目录，供工具与持久化使用，但模型提示词既不说明该目录，也不标识 DeepSeek Harness Web GUI。因此，当用户提出「修改这个页面的主题」之类的请求时，即使用户指的是承载当前会话的 GUI，agent（智能体）也会在所选项目中搜索一个未明确说明的页面。

## 决策

Web profile 会组合 `dsh-base` 与 `dsh-web-app` 两个组合包。Web 组合包提供一段简洁的编码 agent persona，其中包含解析后的 `{{model}}` 与会话 `{{cwd}}`；当 `surfaceContext` 为 true 时，其 `web-runtime` 插件会添加 `app:web-surface` 提示词段。挂载 profile 配置树前，`dsh web` 别名会读取组合后的同一项设置，并且仅在启用界面上下文时安装现有的 `harness:source` 提示词段。无头组合包和拥有完整提示词的 profile 都会设置 `surfaceContext: false`，从而抑制 Web 提示词与受管 shell 事实；Web 别名也会抑制源码提示词段，而无需检查 overlay 路径。每项已挂载的提示词贡献仍会在 agent loop（智能体循环）等消费方发出 request header 前激活。源码提示词段的措辞，以及其中不得从一条路径推断另一条路径的警告，均由另行记录的[源码 checkout 与工作目录区分决策](2026-07-30-source-checkout-workdir-distinction.zh.md)负责。

Web 提示词段把未限定的「这个页面」「这个 GUI」或「这个应用」解释为 DeepSeek Harness Web GUI。同时，它会明确说明浏览器不会隐式提供 DOM、路由或截图上下文，使模型能够识别产品，但不会声称掌握未收到的视觉状态。组装后的文本会记录在 `request/header` 中，从而保持「模型可见内容必须有日志记录」这一不变量。

## 验证

Web 运行时单元测试会固定启用和禁用 `surfaceContext` 时的行为，Web 别名单元测试则会固定组合后配置行对源码提示词段的默认启用与显式禁用门控。无密钥的 Web fresh-round-trip 场景会启动已交付的 base 与 Web 组合包，通过 HTTP／SSE（Server-Sent Events）应用运行一个真实会话，并在规范化源码路径与工作目录后对系统提示词前缀生成快照。该快照按请求顺序固定 harness 身份、源码 checkout、Web 界面定位，以及解析后的编码 agent persona。Core Web 快照会应用 RL overlay，并固定不含源码提示词段或 Web 提示词段的完整系统提示词。

## 考虑过的替代方案

**每次提示词都发送 URL、DOM 或截图。** 本次故障只需要稳定的产品定位；当前根 URL 无法标识所选组件，消息约定中也不存在视觉捕获内容。添加动态页面状态需要另行设计可记录的模型输入，不属于本次修复的隐含范围。

**要求会话 Workspace 必须是 harness checkout。** Workspace cwd 是用户任务的目标，可以合理地指向空项目或其他仓库。将其与应用源码位置混为一谈会破坏这一边界，并且仍无法消除已安装版本或外部启动会话中的歧义。

**把 Web 文案放入全局 harness 身份。** `dsh-system-prompt` 还服务于 TUI、ACP（Agent Client Protocol）、SDK 和不在浏览器中运行的自定义部署。该界面事实应由组装 Web 应用负责。

**为所有 CLI 界面修改现有源码位置提示词段。** TUI 也复用源码位置提示词段，而该段只陈述 checkout 事实。单独保留 Web 界面定位可以维持这份可复用约定，避免错误地告诉无头或终端 agent 它们正处于浏览器中。

## 影响

常规 Web 请求会增加一段较短且稳定的提示词前缀；部署此变更时，模型提供方的前缀缓存可能失效一次。agent 可以区分 GUI 源码 checkout 与所选 Workspace，并且无需再经过一轮澄清即可解析对当前应用的一般指代。对特定视觉状态的指代仍受「无 DOM／无路由／无截图」这一显式边界约束，必要时仍需用户提供路径、描述或附件。拥有完整提示词的 profile 可以通过 Web 运行时的组合设置选择退出，而无需检查启动器路径。
