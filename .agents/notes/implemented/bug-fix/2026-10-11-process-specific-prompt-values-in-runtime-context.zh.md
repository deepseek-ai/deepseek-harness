# Agent Note: 进程相关的 checkout 路径与 Web URL 改走运行时上下文

Status: implemented

[English](2026-10-11-process-specific-prompt-values-in-runtime-context.md) | 中文

## 问题

`dsh web` 曾把两项随进程变化的值直接写进 system prompt：`harness:source` 段里的实现 checkout 路径（web-app 模块位置上溯四层），以及 `app:web-surface` 段里的 Web GUI URL（实际监听端口或 `publicUrl`）。下列操作都会改变它们，而用户感知不到 system prompt 变了：

| 操作 | 变化的值 |
|---|---|
| Desktop 每次启动（`--port 0` 取随机端口） | Web URL |
| 换 `--port`、A/B 两个 checkout 交替运行 | Web URL、checkout 路径 |
| npm 安装与 Desktop 安装共用同一个 `DSH_HOME` | checkout 路径 |

会话恢复时 loop 重新渲染 prompt。对不声明 `systemPromptUpdate: 'in-history'` 的路由（例如手写的 pi-ai `anthropic-messages` 路由），变化的 prompt 会改写 surface 头节点。Claude 的历史 thinking 块签名绑定包括 system prompt 在内的对话前缀，前缀一变上游返回 400（`Invalid signature … bound to a different conversation`），会话在环境恢复原样之前无法继续。声明 in-history 的路由不报错，但每次变化都追加一份完整 prompt。

## 决定

两项值改为运行时上下文，system prompt 只保留不含值的说明；已经按旧格式写入日志的会话继续沿用日志里的旧段落。

### 归属

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-harness-dev-context`（`packages/context/harness-dev-context`） | 两个 section、两个 context、旧格式投影；全部模块私有，只导出插件协议（`name`、`inject`、`apply`） |
| `@deepseek-ai/dsh-host-webserver` | `WebServer.getOrigin()`（绑定地址的 URL 形式加协议与实际端口）与 `bindUrlHost(host)` |
| `@deepseek-ai/dsh-web-app` | `web-runtime` 行提供 `webApp`，其 `getAdvertisedUrl()` 返回配置的 `publicUrl`，否则返回监听器 origin，与 `DSH_WEB_URL` 和启动 URL 同值；bundle patch 挂载 `harness-dev-context` 行 |
| `@deepseek-ai/dsh-system-prompt` | `CONTEXT_ORDERS.HARNESS_SOURCE = 200`、`WEB_SURFACE = 210` |

插件 `inject` 为 `systemPrompt`、`sessionProjections`、`webApp`，在代码里直接读取这些服务；patch 行不写任何配置表达式。checkout 路径取本包源码或构建入口上溯四层，与原 web-app 位置同深度，源码、npm 与 Desktop 安装下结果不变。URL 取 `webApp.getAdvertisedUrl()`，因此 profile 覆盖 `web-runtime` 行的 `publicUrl` 时模型也能看到。插件通过 `import type {} from '@deepseek-ai/dsh-web-app'` 取得 `webApp` 类型；该导入在运行时被擦除，因此 web-app bundle 对本包的依赖仍是唯一的运行时依赖。

### 新会话

| 注册 | 内容 |
|---|---|
| section `harness:source`（`HARNESS_SOURCE` 位） | `The runtime context names the DeepSeek Harness implementation checkout. …`，其余说明不变 |
| context `harness:source`（`CONTEXT_ORDERS.HARNESS_SOURCE = 200`） | `Current DeepSeek Harness implementation checkout: "<path>".` |
| section `app:web-surface`（`WEB_SURFACE` 位） | `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. …`，其余说明不变 |
| context `app:web-surface`（`CONTEXT_ORDERS.WEB_SURFACE = 210`） | `Current DeepSeek Harness Web GUI URL: "<url>".` |

两个 context 都是可选项（不设 `required`）。唯一的 complete persona（web-app 的 minimal 预设）同时关闭了可选运行时上下文，因此它仍然看不到这两项。运行时上下文按既有机制工作：值不变不发新快照，变化时在本轮 user 消息前追加完整快照，恢复时从会话日志取上一份快照比较，不改写任何已提交消息。

### 旧格式会话

插件注册仅限宿主的会话投影 `harnessDevLegacyPrompt`，按事件顺序折叠每个非空 `system/message`，状态为 `{ source, web }`：该 prompt 中按旧模板逐字匹配到的段落，未匹配为 `null`。

| 旧模板 | 匹配规则 |
|---|---|
| `harness:source` | `The DeepSeek Harness implementation checkout is at ` 开头、旧版固定说明结尾、中间不含换行 |
| `app:web-surface` | `You are interacting with the user through the DeepSeek Harness Web GUI at ` 开头、`. ` 加早期版本渲染的说明结尾（冻结为字面量）、中间不含换行 |

两个 section 的文本提供函数读取 `AssembleContext.agent.session` 的投影状态：有旧段落时原样返回该段落（`interpolate: false`），否则返回新说明。没有 agent 的诊断性组装使用新说明。`sessionProjections` 是插件的必需注入，投影单元由插件自己注册，因此存在 agent 时状态必然可读。

旧会话因此满足两点：

| 场景 | system prompt | 运行时上下文 |
|---|---|---|
| 升级后首次恢复，端口不变 | 与日志逐字相同，loop 不产生 `system/message` | 追加含两项当前值的快照 |
| 升级后换端口、slot 或安装位置 | 仍是日志里的旧段落 | 追加新值快照 |

投影只在每次提交的 `system/message` 上计算，不新增同步读取历史事件的调用；状态随投影检查点持久化。压缩或新请求序列重写头节点时，渲染结果仍含同一旧段落，投影状态不变。

## 备选方案

**只把两项值移到运行时上下文，不保留旧段落。** 升级本身会改变 prompt 文本，所有既有 Claude 会话在升级后第一轮改写头节点并报 400。

**为手写 Anthropic 路由开放 `supportsMidConvoSystemMessages`。** 上游实测接受对话中途的 system 消息，但 pi-ai 目录已为具名 Anthropic 路由提供该能力，手写路由按既有约定不开放目录字段；而且 in-history 路由每次值变化仍追加一份完整 prompt。

**请求上游丢弃不匹配的 thinking 块（`prefix_mismatch_behavior: "drop_block"`）。** 会静默丢失历史推理，且只覆盖一个供应商。

**会话内冻结整份 system prompt。** plan 模式、技能和工具说明等合法的 prompt 变化也会被冻结，无法到达模型。

**留在 web-app 与 app-boot 中实现。** 面向开发的上下文与旧格式兼容逻辑会扩大两个核心包的公开 API；app-boot 的 `addHarnessSourceSection` 当时只有 web-app 一个调用方。

**读取 `webStartup.publicUrl`。** 它只携带 `--public-url` 参数，profile 覆盖 `web-runtime` 行的 `publicUrl` 时只会影响 `DSH_WEB_URL`，到不了模型；生效值只存在于 web-app 内部，现在由它以 `webApp` 提供。

**直接读取会话历史中的头节点文本。** 同步读取任意历史事件的 API 已弃用，新调用被禁止；投影是恢复后取得该状态的既定方式。

## 后果

- 新会话的 system prompt 不再随端口、slot 或安装位置变化；两项当前值以运行时上下文快照送达，变化时只追加几行。
- 旧会话在整个生命周期内保留旧段落中的旧值；同一请求里更晚的 `Current …` 运行时上下文给出当前值。
- 只保护这两段。其他提示文本在版本之间变化时，不支持 in-history 的路由仍会改写头节点。
- 不含本修复的旧版本恢复新格式会话时会按旧模板改写头节点；A/B 两个 checkout 都需包含本修复后再交替运行。
- app-boot 不再导出 `addHarnessSourceSection` 与 `HARNESS_SOURCE_SECTION`；web-app 的 `surfaceContext` 只控制 `DSH_WEB_URL`，关闭这两项上下文改为禁用 `harness-dev-context` 行。
- Web e2e 录制会话里的运行时上下文多出两行；测试脚手架把 URL 与 checkout 路径规范化为占位符。

## 测试

- `packages/context/harness-dev-context/tests/harness-dev-context.spec.ts`：真实 AgentLoop 上，旧格式会话在另一端口恢复时不产生 `system/message`、请求中的 system prompt 与日志逐字相同、运行时上下文携带当前 URL；再换一次端口仍成立；不支持与支持 in-history 的路由各跑一遍。series 合并只清空后续版本时，下一轮仍沿用旧段落。缺少固定结尾或跨行的相似文本得到新说明。新会话换端口后 system prompt 不变、只追加运行时上下文快照。section 不含值、context 携带公告 URL，销毁插件 fiber 后全部注册消失。
- `packages/host/webserver/tests/webserver.spec.ts`：`bindUrlHost` 各地址形式；`getOrigin()` 在 HTTP 与 HTTPS 监听上的值，绑定前与带 zone 的非回环地址抛错。
- `packages/bundle/web-app/tests/web-app.spec.ts`：`webApp.getAdvertisedUrl()` 返回监听器 origin，或该行配置的 `publicUrl`。
- `packages/core/system-prompt/tests/system-prompt.spec.ts`：新增的 context 位置唯一且为整数。
