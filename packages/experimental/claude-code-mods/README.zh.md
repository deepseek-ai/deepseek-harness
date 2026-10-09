---
description: "实验性桥接：把 Claude Code 模组作为 DSH 插件运行——其 register(on, options) 钩子可守卫工具调用、改写提示词、添加命令与工具并在提示框上方绘制；面向挂载模组的用户与扩展映射的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-claude-code-mods

[English](README.md) | 中文

## 概述

在智能体运行中执行 [Claude Code 模组](https://code.claude.com/docs/en/plugins/mods/overview)：用 `defineMod` 包装模组的 `register(on, options)`，在本桥接之后作为插件挂载，其钩子即可通过同一套 `$`、`e`、`next` 链守卫工具调用、改写提示词、添加命令与工具、读取会话事实，并在提示框上方绘制一条横幅。桥接需要 `dsh-working-directory`，每次 `$` 调用都落在一个已组合的 harness 服务上。它是 alpha 阶段的接口兼容性演示：未服务的事件在加载时报告，未服务的 `$` 成员以指明缺口的消息失败，[兼容性页面](../../../docs/subsystems/claude-code-mods.zh.md) 列出了全部差异。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

模组就是插件。`defineMod` 接收模组的 `register` 函数以及 `plugin.json` 本应承载的身份，返回一个 Cordis 插件：其配置就是 `register` 收到的 `options` 对象，覆盖在你给出的 `userConfig` 默认值之上。先挂载桥接，再按链顺序挂载各模组。

```ts
// mods/token-weather/index.ts — `register` is the mod's own hooks module (`./hooks/token-weather.mjs`).
import { defineMod, type ModOn } from '@deepseek-ai/dsh-experimental-claude-code-mods'

declare const register: (on: ModOn, options: Readonly<Record<string, unknown>>) => void

export default defineMod({ name: 'token-weather', version: '0.1.0', root: import.meta.dirname, register })
```

```yaml
- name: '@deepseek-ai/dsh-experimental-claude-code-mods'
- name: './mods/blast-radius/index.ts'
- name: './mods/token-weather/index.ts'
  config:
    history: 12
```

| 桥接字段 | 默认值 | 含义 |
|---|---|---|
| `hookTimeoutMs` | `10000` | 钩子每个事件自身的运行时间（Claude Code 的限制）；`next` 或 `$` 调用内部的时间不计入 |
| `catchTimeoutMs` | `1000` | `.catch` 处理器的运行时间 |
| `processTimeoutMs` | `30000` | `$.process.run` 与 `$.http.fetch` 的默认超时 |
| `toolAliases` | — | 追加到内置表的 Claude Code 工具名 → harness 工具名条目 |
| `bandColumns` | `120` | 提示框上方横幅向 `ui.render` 报告的列数（`bodyColumns` 与 `viewport.columns`） |
| `bandRows` | `10` | 横幅报告的 `maxRows` 行数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-claude-code-mods)是所有可接受字段的完整来源。[examples](examples/) 目录以插件目录的形式收录了 Anthropic [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) 一文中的三个模组，它们同样可在 `claude --plugin-dir` 下运行：Token Weather 的已发布模块、类型与测试原样保留，Blast Radius 与 Replay Theater 则由已发布片段补全。[可选叠加层](cordis.source.patch.yml)把桥接、三个模组与 [Web 横幅](../client-ui-claude-code-mods/README.zh.md)组合起来用于源码启动。

Blast Radius 的 DSH 包装使用当前运行的可执行文件提供 Node 计时子进程，因此 Proceed/Cancel 等待在 Windows 上不依赖 POSIX `sleep`。等待仍通过 `$.process.run` 执行，暂停钩子自身的运行时间预算，并随事件取消子进程。独立的 Claude Code hooks 模块默认使用 `sleep 0.25`；其预演命令也需要宿主机提供相应工具。

### 你的模组会收到哪些事件

| 事件 | 触发自 | 钩子可以 |
|---|---|---|
| `session.start` | 根智能体的 `agent/created`，在其首轮之前等待完成；`cwd` 使用已验证的目录，包括从持久化恢复的目录；取消创建会放弃验证和等待中的钩子 | 观察；注册命令与工具 |
| `prompt.submit` | 带有已认领消息的 `agent/pre-step`；`e.text` 拼接人类自己（`user` 来源）消息的文本块，改写也只触及这些块 | 改写 `text`、在输入的提示词之后追加 `context` 块，或 `{ drop }` 掉提示词 |
| `turn.start` | 一轮中的首个 `agent/pre-step` | 观察 |
| `tool.call` | `tools/execute` 瀑布流，在 harness 权限决定之后；模组用 `$.tool.call` 发起的调用只到达在它之前加载的模组，并归属于调用方 | 前后观察、`{ deny }`、以 `{ result }` 作答，或在 `next` 之后改写结果或其 `isError` |
| `turn.complete` | `turn/end` 会话事件 | 观察；返回 `{ text }` 在宿主日志中写一行 |
| `command.run` | 模组用 `$.command.register` 注册的命令被输入 | 以 `{ text }` 或 `{}` 作答 |
| `ui.render` | 提示框上方的横幅重绘：`{ component: 'AbovePrompt' }`，带 `bodyColumns`、`hasSurvey`、`isWorking`、`maxRows` 属性 | 从 `$.ui.resolve(e)` 返回 `Box`/`Text`/`Button` 树，或 `next(e)` 让出横幅 |
| `session.end` | 根智能体的 `agent/disposed`；钩子结束前 `$.state` 仍可读 | 观察 |
| `<namespace>.<method>` | 更晚加载的模组的 `$` 调用（`tool.call` 则经由工具流水线到达） | 观察、改写或 `{ deny }` |

`e.tool` 与 `tool` 匹配器在 harness 工具有对应名时使用 Claude Code 的名字（`Bash` ↔ `bash`、`Read` ↔ `read`、`Edit` ↔ `edit`、`Write` ↔ `write`、`Glob` ↔ `glob`、`Grep` ↔ `grep`、`WebFetch` ↔ `web_fetch`、`WebSearch` ↔ `web_search`、`Task` ↔ `subagent`、`TodoWrite` ↔ `todo_write`、`AskUserQuestion` ↔ `ask_user_question`、`ExitPlanMode` ↔ `exit_plan_mode`、`Skill` ↔ `skill`）；其余工具保留 harness 名。子智能体事件带 `e.agentId`。其他所有 Claude Code 事件名都能注册而不报错，但永不触发，并在模组加载时以警告点名。

<a id="the-band-above-the-prompt"></a>
### 提示框上方的横幅

横幅每个会话一个实例，由加载顺序中第一个 `ui.render` 钩子返回树的模组绘制；调用 `next(e)` 的钩子把横幅让给下一个模组，因此把只在持有事项时才绘制的模组（Blast Radius、Replay Theater）放在只要有读数就绘制的模组（Token Weather）之前。横幅在 `session.start` 之后、上次绘制读取过的 `$.state` 值被写入时、在 `$.ui.open`、`$.ui.close`、`$.ui.invalidate` 之后、在每条 `tool.call` 链与 `turn.complete` 结束之后以及按钮按下之后重绘。`Button` 的 `onPress` 留在宿主中；Web 横幅把点击连同它看到的代数发回，针对更早绘制的点击会被报告并忽略。`$.ui.open` 回答 `{ isPlaced: false }`：没有面板被放置，降级到横幅的模组就在横幅中绘制。[测试工具包](#test-a-mod)的 `$.ui.mount` 不需要 Client 就能渲染同样的钩子。

### 你的模组可以调用哪些 `$` 成员

| 命名空间 | 已服务 | 基于 |
|---|---|---|
| `$.plugin` | `name`、`root` | `defineMod` 的规格 |
| `$.ui` | `resolve`、`invalidate`、`open`、`close`、`panes`、`log`、`toast`、`status`、`ask` | `resolve` 交出元素构造器；`invalidate`、`open`、`close` 重绘横幅；`ask` 基于 `ctx.userQuestions`；`log`、`toast`、`status` 到达宿主日志 |
| `$.command` | `register`、`run`、`list` | `ctx.commands`，限定在事件所属的智能体 |
| `$.tool` | `register`、`call`、`list` | `ctx.tools`；注册的工具名为 `mcp__<plugin>__<tool>`；工具推迟到下一请求的上下文会注入会话 |
| `$.prompt` | `submit` | `agent.followup()`，作为 `user` 来源的消息，除非 `asUser` 否则套上"来自模组"的框架；它触发的 `prompt.submit` 带 `origin: { kind: 'plugin', name }` |
| `$.session` | `id`、`cwd`、`root`、`model`、`turns`、`messages`、`usage`、`version` | 智能体的 Session 及 `turnBoundary`、`contextPressure` 投影；`cwd` 通过 `ctx.workingDirectory` 报告已提交的当前目录；`root` 保留原始项目 |
| `$.state` | `get`、`set` | 为会话持有的内存，以模组命名的 `{ plugin, key }` 寻址；`ui.render` 期间的读取会让横幅订阅 |
| `$.store` | `get`、`set`、`delete`、`keys` | `claude_code_mods` 存储域，每插件一个 JSON 对象，4 MiB |
| `$.clock` | `now`、`sleep`、`after`、`every` | 由安排它们的事件所属会话拥有的定时器；事件取消时 `sleep` 拒绝 |
| `$.fs` | `read`、`write`、`list`、`exists`、`stat` | `ctx.fs`，相对于已验证的 Session 当前目录，每文件 4 MiB |
| `$.process` | `run` | `ctx.subprocess`，不经 shell 的 argv；未提供 `init.cwd` 时，新进程默认使用已验证的 Session 当前目录 |
| `$.http` | `fetch` | 进程的 `fetch`，正文最多 4 MiB |
| `$.env` | `get`、`set` | 本进程的环境变量，所有会话与插件共享 |

所需服务未组合的调用以缺失服务的包名拒绝；表外的命名空间或方法以 `no implementation for <namespace>.<method>` 拒绝。模组以本进程的全部权限运行：`$.env` 读写 harness 的环境变量，`$.http.fetch` 可访问任意 URL，`$.fs` 与 `$.tool.call` 以会话的身份行动。

<a id="test-a-mod"></a>
### 测试模组

来自 `@deepseek-ai/dsh-experimental-claude-code-mods/testing` 的 `createModTestKit` 加载 `defineMod` 插件或裸定义，并以桩在底层回答的方式让事件穿过它们，形态与 `claude-code/testing` 相同：`kit.on('tool.call', () => ({ result: 'ok' }))` 代替引擎作答，`kit.$.tool.call({ tool: 'Bash', command: 'ls' })` 触发事件，`kit.$.ui.mount({ component: 'AbovePrompt' })` 渲染横幅并查找或按下其元素，`mock.store(kit.on)` 从内存回答 `$.store`。在本仓库内，`claude-code/testing` 解析为该工具包加上 Vitest 的 `describe`、`test`、`expect`，因此[示例模组的测试](examples/token-weather/tests/token-weather.test.ts)按为 `claude plugin test` 编写的原样运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 加载

[`define-mod.ts`](src/define-mod.ts) 把规格变成一个 Cordis 插件：挂载时调用 `ctx.claudeCodeMods.add(definition)`，卸载时移除模组。[`module.ts`](src/module.ts) 运行 `register` 并把每个 `on(...)` 收集进 `HookRegistry`；`on` 以 Claude Code 的措辞拒绝未知事件名和同一事件第二次无匹配器的注册，`register` 抛出则使模组插件挂载失败。模组顺序即挂载顺序，所以 cordis.yml 的顺序就是链顺序。

### 链

[`chain.ts`](src/chain.ts) 让一个事件穿过选中的钩子，最外层在前，引擎行为在底部。每个钩子的 `next` 只向下委托一次：第二次调用返回第一次的运行结果，钩子已启动的下层运行会在其自身答案落定前被等待。抛出、超时或没有结果就结束的钩子会被跳过并按失败类型报告一次，若它已调用 `next` 则下层结果生效，`.catch` 处理器可代为作答。预算时钟只计钩子自身的运行时间：在 `next` 内与除 `$.clock.sleep` 外的每个 `$` 调用内暂停。[`engine.ts`](src/engine.ts) 拥有注册表、按会话的 `$.state`、按会话与模组键控的定时器，以及两个分发方向：引擎事件到达所有选中的钩子，而一个模组发起的 `$` 调用只到达在它之前加载的模组。

### 映射到 harness

[`index.ts`](src/index.ts) 注册监听器。`tool.call` 包裹 `tools/execute`，因此 harness 的权限决定先于链；`{ deny }` 成为带原因的错误结果，`{ result }` 在工具为模组注册或值满足工具输出 schema 时成为成功结果，否则为错误形态的结果。钩子在 `next` 之后改写的结果经 `tools/post-execute` 作为替换内容安装。向 `next` 传入改写参数的钩子会被跳过并报告，因为调用参数已经写入日志。[`host-ops.ts`](src/host-ops.ts) 持有每个 `$` 调用基于 `ctx.get(...)` 服务的引擎行为；目录所有者为必需服务，其他服务按需读取。[`surfaces.ts`](src/surfaces.ts) 为每个会话保留一条横幅：触发 `ui.render`，用 [`elements.ts`](src/elements.ts) 校验并序列化树，把每个 `Button` 的 `onPress` 保存在按绘制分配的动作 id 之后，让横幅订阅该次绘制读取的 `$.state` 槽位，并通过 `claudeCodeMods` Remote（`watchBand`、`pressBand`）把各代推流给 Client。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 桥接服务：配置、模组注册表、扩展点监听器、Remote |
| [`src/define-mod.ts`](src/define-mod.ts) | `defineMod`：模组作为插件 |
| [`src/host-ops.ts`](src/host-ops.ts) | 基于 harness 服务的 `$` 行为 |
| [`src/surfaces.ts`](src/surfaces.ts)、[`src/elements.ts`](src/elements.ts) | 提示框上方的横幅；元素构造器、校验、序列化 |
| [`src/engine.ts`](src/engine.ts) | 注册表、`$.state`、定时器、分发方向 |
| [`src/chain.ts`](src/chain.ts) | 中间件链、预算时钟、失败规则 |
| [`src/api.ts`](src/api.ts) | 钩子收到的 `$` 对象 |
| [`src/module.ts`](src/module.ts)、[`src/matcher.ts`](src/matcher.ts)、[`src/tool-names.ts`](src/tool-names.ts) | `register` 与 `on`；事件名、匹配器、工具名别名 |
| [`src/testing.ts`](src/testing.ts) | 测试工具包（`./testing`） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [与 Claude Code 模组的兼容性](../../../docs/subsystems/claude-code-mods.zh.md) — 本桥接与 Claude Code 模组的每一处差异，以及修复或原因。
- [Claude Code 模组参考](https://code.claude.com/docs/en/plugins/mods/reference) — 本桥接镜像的事件、方法与限制。
- [Web 横幅](../client-ui-claude-code-mods/README.zh.md) — 在输入停靠区绘制 `ui.render` 树的 Client 包。
- [实验性包](../README.zh.md) — 发布策略与依赖隔离。
- [Claude Code 钩子桥接](../hooks-claude-code/README.zh.md) — 设置钩子桥接；插件 `hooks.json` 中的设置钩子需要 `dsh-hooks-claude-code`。
- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md) — `tool.call` 所包裹的瀑布流。
- [人类命令](../../interaction/commands/README.zh.md) — `$.command.register` 落到的注册表。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词上下文与提交的提示词

#### 模型看到什么

`prompt.submit` 钩子加入 `e.context` 的字符串成为输入的提示词之后的文本块，位于人类自己的消息内部；改写的 `text` 替换提示词的文本块。`$.prompt.submit({ text })` 排入一条 `user` 来源的消息：`asUser: true` 时只有文本本身，否则按下文框架填入插件名与文本。

##### 模组提交的提示词的框架

```markdown
Message from the "<plugin>" mod:
<text>
```

#### Token 影响

模组添加上下文或提交提示词之前没有开销；这些文本依赖数据、写入日志，并在后续请求中重发直到压缩。

#### KV 缓存影响

只追加：添加的上下文与提交的提示词跟在可复用的请求前缀之后，不会使现有条目失效。

### 模组决定的工具结果

#### 模型看到什么

`{ deny: reason }` 答案把 `Error: <reason>` 渲染为工具结果。`{ result }` 答案在工具为模组注册或值满足工具输出 schema 时经工具自身的呈现器渲染，否则作为携带该文本的错误形态结果。`next` 之后改写的结果替换工具的内容文本。被丢弃的提示词以 `blocked` 结束该轮，没有模型可见的消息。持有 `tool.call` 的模组（Blast Radius）把结果推迟到按钮决定为止；模型只看到结局。

#### Token 影响

拒绝与代答的调用用模组的文本替换工具自身输出；被丢弃的提示词不发送请求。

#### KV 缓存影响

工具结果追加在可复用前缀之后；被丢弃的提示词不会使任何条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述 Claude Code 模组经本桥接运行时行为不同之处；[兼容性页面](../../../docs/subsystems/claude-code-mods.zh.md) 是完整清单。它们是当前的包约束，不是任务积压。

- **一个绘制表面** — 服务 `AbovePrompt`；`Pane`、其他渲染位点、`Input`、热键、`ui.press`、`ui.input`、`ui.select`、`ui.focus`、`ui.scroll` 不服务：`$.ui.open` 回答 `{ isPlaced: false }`，`$.ui.log`、`$.ui.toast`、`$.ui.status` 到达宿主日志而非 GUI。钩子按 `bandColumns` 列宽的横幅绘制；Web 横幅会换行。按钮的 `onPress` 没有时间限制；挂起的 `onPress` 会让横幅的按钮保持禁用直到它结束。
- **`next` 只运行一次** — 调用 `next` 两次的钩子得到第一次的运行；Claude Code 会再次运行下层链。在其 `next` 仍在运行时作答的钩子会等待该次运行。
- **未服务的事件** — `tool.check`、`tool.describe`、`turn.step`、其他 `prompt.*` 事件、`command.describe`、`config.*`、`session.compact`、`session.receive`、`session.send`、`session.append`、`session.attach`、`session.detach`、`session.measure`、`agent.*`、`plugin.register`、`engine.create`、`telemetry.*` 可注册、永不触发，并在加载时以警告点名；`classic.*` 名字与任何未知事件一样在 `register` 时被拒绝。
- **未服务的 `$` 命名空间** — `$.model`、`$.agent`、`$.config`、`$.settings`、`$.mcp`、`$.audio`、`$.telemetry`、`$.turn`、`$.ui.notice`、`$.ui.blit`、`$.ui.copy`、`$.fs.ancestors`、`$.process.spawn` 以及 `$.session.repo`、`send`、`append`、`authorize`、`compact`、`surfaces` 以 `no implementation` 拒绝。`$.model.complete` 等待一个写入日志的副请求事件，以便模组的模型调用仍可从 Session 日志重建。
- **`tool.call` 在权限决定之后运行** — Claude Code 在其权限检查之前运行模组的 `tool.call` 钩子；此处 harness 的 `tools/pre-execute` 瀑布流（含审批）先行结束。改写传给 `next` 的参数或改名工具的钩子会被跳过并报告（参数情形指向[工具前输入改写提案](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)），因为已写入日志的调用按原样运行。
- **一个进程，多个会话** — 模组的模块级变量与 `$.env.set` 写入由进程内所有会话与插件共享，而 Claude Code 每进程一个会话；按会话的值请放在 `$.state`。`session.start` 与 `session.end` 只为根智能体触发。
- **无沙箱、无静态分析、无热重载** — 钩子模块以 Node 全局对象在进程内运行，拥有本进程的全部权限（环境变量、网络、文件系统与工具）；仅 `$` 访问规则、`claude plugin validate`、类型生成、`--plugin-dir` 监视与会话内模组编写流程均未实现。只挂载你愿意作为插件运行的模组。再次挂载模组会在同一已求值模块上重新运行 `register`，模块级变量保留其值。
- **`turn.complete` 文本** — 钩子返回的 `{ text }` 到达宿主日志，而非答案下方的一行；`durationMs` 从该轮的 `turn/start` 起算。
- **`$.session.usage`** — 在 token 计量器得知路由的上下文窗口与提供商用量报告之前，`window` 为 `0` 且无 `percent`；`rateLimits` 始终为空。`$.fs.stat` 报告 `mtimeMs: 0`。
- **`plugin.json` 与 `hooks.json`** — 不读取；`defineMod` 承载身份，插件的设置钩子需要 `@deepseek-ai/dsh-hooks-claude-code`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

按模组作者价值排序的后续步骤：Web GUI 中带 `TextInput`、热键以及 toast、status、log 表面的停靠 `Pane`；基于 `ctx.llm` 并带日志请求事件的 `$.model.complete`；以及在许可允许提供夹具后，以阅读方式运行 `anthropics/claude-code/mods` 中的官方模组。

</details>
