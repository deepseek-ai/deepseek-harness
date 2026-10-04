# Claude Code 模组：兼容性

[English](claude-code-mods.md) | 中文

模组经本桥接运行时与在 Claude Code 下行为不同的每一处，基准为 Claude Code 2.1.287（[模组参考](https://code.claude.com/docs/en/plugins/mods/reference)及其 `claude-code.d.ts`）与 2026-10-01 的 [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) 一文。每行给出 Claude Code 的行为、本桥接的做法，以及原因或后续工作。未列出的一切均按参考文档描述的方式运行；对本宿主永不触发的事件注册钩子会在模组加载时以警告点名，服务表之外的 `$` 调用以 `no implementation for <namespace>.<method>` 拒绝。

## 打包与加载

| Claude Code | 本桥接 | 原因或后续 |
|---|---|---|
| 一个插件目录，含 `.claude-plugin/plugin.json` 与指定一个钩子模块的 `hooks/hooks.json`；`claude --plugin-dir`、市场、`/plugin install` | 模组就是插件：`defineMod({ name, version, root, userConfig, register })` 包装钩子模块，并在桥接之后经 cordis.yml 挂载；不读取 `plugin.json` 与 `hooks.json` | 模组加入每个 DSH 插件都使用的同一组合机制；示例目录保留其清单，因此也能在 `claude --plugin-dir` 下运行 |
| `plugin.json` 中带类型默认值的 `userConfig` schema；选项在加载时校验 | `userConfig` 是 `defineMod` 规格的默认值对象；插件的 cordis.yml `config` 覆盖其上，并按字符串、数字、布尔与字符串列表的记录校验 | 不读取清单 |
| 层级（`user`、`project`、`managed`）与 `next.to(e, tier)` | 每个模组都以 `user` 加载；测试中的 `tier()` 被接受并忽略；`next.to` 拒绝 | 托管设置不是 DSH 的概念 |
| 编辑时热重载钩子模块；`claude plugin validate`、`claude plugin test`、由 `types/index.d.ts` 生成类型 | 这些命令都没有；重新挂载会在同一已求值模块上重新运行 `register`，模块级变量保留其值 | 仅按需跟进；测试工具包的 `createModTestKit` 在 Vitest 中替代 `claude plugin test` |
| 钩子模块可以是 TypeScript | `.ts` 钩子模块只在启动器转译时可加载（源码启动可以；构建后的安装不行） | DSH 交付的是纯 Node |
| 模组在进程内运行，`$` 是其访问宿主的唯一途径 | 钩子模块以 Node 全局对象在进程内运行，没有访问规则，并拥有进程的全部权限：`$.env` 读写 harness 环境变量，`$.http.fetch` 可访问任意 URL，`$.fs` 与 `$.tool.call` 以会话的身份行动 | 不对模组施加沙箱；只挂载你愿意作为插件运行的模组 |
| `import type { … } from 'claude-code'`、`declare module 'claude-code' { interface PluginState }` | `claude-code` 模块名只在本仓库的测试设置中解析到桥接的类型；仓库外的模组导入 `@deepseek-ai/dsh-experimental-claude-code-mods` | 类型名是桥接自己的 |
| `hooks.json` 中的设置钩子与模组钩子并行运行 | 不运行；为它们挂载 `@deepseek-ai/dsh-hooks-claude-code` | 不同的桥接 |

## 事件

| 事件 | Claude Code | 本桥接 |
|---|---|---|
| `session.start` | 每会话触发一次，在首个提示词之前 | 由根智能体的 `agent/created` 触发，在其首轮之前等待完成；不为子智能体触发 |
| `session.end` | 每会话触发一次 | 由根智能体的 `agent/disposed` 触发；钩子结束前 `$.state` 可读 |
| `prompt.submit` | `e.text` 是输入的提示词；`context` 条目各成一块跟在输入的提示词之后；插件提交的提示词带 `origin: { kind: 'plugin', name }` | 相同；`e.text` 拼接已认领批次中人类自己（`user` 来源）消息的文本块，仅含注入上下文的批次不触发，`$.prompt.submit` 排入的提示词以提交的模组为来源 |
| `turn.start`、`turn.complete` | 每轮触发；子智能体的轮带 `agentId` | 相同；`turn.complete` 的 `{ text }` 到达宿主日志，而非答案下方的一行；`durationMs` 从 `turn/start` 起算 |
| `tool.call` | 在 Claude Code 的权限检查之前运行；`next({ ...e, command })` 改写工具实际运行的参数，`next({ ...e, tool })` 把调用改派给另一工具 | 包裹 `tools/execute` 运行，在 harness 权限决定之后；改写参数或改名工具的钩子（或 `.catch` 处理器）会被跳过并报告——参数情形指向[工具前输入改写提案](../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)——因为已写入日志的调用按原样运行。`{ deny }`、`{ result }`、观察以及在 `next` 之后改写结果或 `isError` 均按描述工作 |
| `command.run` | 为模组注册的命令运行 | 相同 |
| `ui.render` | 为每个渲染位点触发（`AbovePrompt`、`Pane`、`ToolUse`、`AssistantMessage`、`Spinner`……） | 只为 `AbovePrompt` 触发，每次会话横幅重绘一次；`Pane` 钩子只经测试工具包的 `$.ui.mount({ component: 'Pane' })` 运行 |
| `tool.check`、`tool.describe`、`tool.list`、`tool.register` | 塑造工具列表与权限 | 不触发；`$.tool.register` 与 `$.tool.list` 作为 `$` 调用服务 |
| `turn.step` | 每个模型步骤 | 不触发 |
| 参考中的其他所有事件：其他 `prompt.*` 事件、`skill.prompt`、`attribution.text`、`command.describe`、`config.*`、其他 `session.*` 事件、`agent.*`、`plugin.register`、`engine.create`、`telemetry.*`、`ui.resolve`、`ui.press`、`ui.input`、`ui.select`、`ui.focus`、`ui.scroll`、`ui.close`、`ui.message` | 由引擎触发 | 可注册，永不触发，在加载时以警告点名 |
| `classic.*` | 经典设置钩子作为事件 | 在 `register` 时拒绝，与任何未知事件名相同 |
| `<namespace>.<method>` 操作事件（`fs.read`、`store.set`……） | 更晚加载的模组的 `$` 调用到达在它之前加载的模组 | 相同；`tool.call` 则经由工具流水线到达 |

## 链

| Claude Code | 本桥接 | 原因 |
|---|---|---|
| 钩子可多次调用 `next`；每次调用都再次运行下层链 | `next` 只运行一次：第二次调用返回第一次运行的结果 | 每条写入日志的调用只执行一次工具 |
| 钩子在其 `next` 仍在运行时作答 | 下层运行会在钩子答案落定前被等待；答案之后的下层失败会被报告 | 事件只在其启动的一切都结束后落定 |
| 自身时间预算 10 秒，`.catch` 为 1 秒，`next` 与 `$` 调用内的时间不计，`$.clock.sleep` 除外 | 相同，可配置（`hookTimeoutMs`、`catchTimeoutMs`） | — |
| 不返回结果对象视为失败 | 相同；`null` 被接受为答案（绘制为空的表面） | 无可绘制内容的 `ui.render` |
| 结果中的未知字段被丢弃，类型错误使钩子失败 | 类型错误的 `prompt.submit` 结果保留原文本，并只取字符串形式的 context 行 | 对这一常见部分结果的事件从宽处理 |

## `$` 成员

| 命名空间 | Claude Code | 本桥接 |
|---|---|---|
| `$.plugin` | `name`、`root`、`tier` | 来自 `defineMod` 规格的 `name`、`root` |
| `$.ui` | `resolve`、`invalidate`、`open`、`close`、`panes`、`focus`、`log`、`toast`、`status`、`notice`、`ask`、`blit`、`copy`、`press`、`input`、`select` | `resolve`、`invalidate`、`open`、`close`、`panes`、`log`、`toast`、`status`、`ask`；`open` 带原因回答 `{ isPlaced: false }` 并重绘横幅；`log`、`toast`、`status` 到达宿主日志；其余拒绝 |
| `$.command` | `register`、`run`、`list` | 相同；`run` 一个无人回答的命令时拒绝，并点名注册它的模组 |
| `$.tool` | `register`、`call`、`list` | 相同；注册的工具为 `mcp__<plugin>__<tool>`；`call` 运行 harness 流水线，并把工具推迟的上下文注入会话 |
| `$.prompt` | `submit`、`compose` | `submit`；消息为 `user` 来源，除非 `asUser` 否则套上 `Message from the "<plugin>" mod:` 框架，它触发的 `prompt.submit` 以该模组为来源 |
| `$.session` | `id`、`cwd`、`root`、`repo`、`model`、`turns`、`messages`、`usage`、`version`、`send`、`append`、`authorize`、`compact`、`surfaces` | `id`、`cwd`、`root`、`model`、`turns`、`messages`、`usage`、`version`；`cwd` 与 `root` 都报告会话工作区；在 token 计量器得知路由窗口前 `usage.context.window` 为 `0` 且无 `percent`；`rateLimits` 为空；`version` 指明本桥接 |
| `$.state` | 按会话，热重载后保留 | 按会话，内存中；`ui.render` 期间的读取让横幅订阅该槽位 |
| `$.store` | 按插件，持久 | 相同，在 `claude_code_mods` 存储域中，每插件 4 MiB |
| `$.clock` | `now`、`sleep`、`after`、`every`；定时器随插件消亡 | 相同；定时器还随安排它的事件所属会话消亡，事件取消时 `sleep` 拒绝 |
| `$.fs` | `read`、`write`、`list`、`exists`、`stat`、`ancestors` | 除 `ancestors` 外全部；每文件 4 MiB；`stat.mtimeMs` 为 `0` |
| `$.process` | `run`、`spawn` | 仅 `run`，不经 shell 的 argv，默认 `processTimeoutMs` |
| `$.http` | `fetch` | 相同，正文最多 4 MiB |
| `$.env` | `get`、`set` | 相同；进程环境由所有会话与插件共享 |
| `$.model`、`$.agent`、`$.config`、`$.settings`、`$.mcp`、`$.audio`、`$.telemetry`、`$.turn` | 已服务 | 以 `no implementation` 拒绝；`$.model.complete` 等待一个写入日志的副请求事件 |

## 绘制

| Claude Code | 本桥接 |
|---|---|
| `Box`、`Text`、`Button`、`Input`、`Spacer` 以及宿主自己的元素种类 | 来自 `$.ui.resolve(e)` 的 `Box`、`Text`、`Button`；树经校验，`Button` 的 `onPress` 留在宿主中，位于按绘制分配的动作 id 之后 |
| `Box` 属性：`flexDirection`、`padding*`、`gap`、`border*`、`width`、`height`、`overflow`、`scroll` | `flexDirection`、`padding`、`paddingX`、`paddingY`、`gap`、`border`、`borderColor`；其余会序列化，Web 横幅忽略 |
| `Text` 属性：`color`、`bold`、`dimColor`、`italic`、`underline`、`wrap`、`truncate` | `color`（终端调色板名）、`bold`、`dimColor`、`italic`、`underline`；Web 横幅会换行 |
| `Button` 属性：`label`、`hotkey`、`disabled`、`onPress`；单个数字键触发热键 | `label`、`hotkey`（显示为提示）、`disabled`、`onPress`（点击） |
| 横幅是一个实例；`hasSurvey`、`isWorking`、`maxRows`、`bodyColumns` 反映终端 | 每会话一个实例，按模组加载顺序咨询；`bodyColumns` 与 `viewport.columns` 取桥接的 `bandColumns`（默认 `120`），`maxRows` 取 `bandRows`（默认 `10`），`hasSurvey` 与 `isWorking` 为 `false`；Web 横幅换行而非滚动 |
| 横幅随宿主帧重绘，并在渲染读取过的 `$.state` 值变化时重绘 | 在 `session.start` 之后、上次绘制读取过的 `$.state` 值被写入时、在 `$.ui.open`、`$.ui.close`、`$.ui.invalidate` 之后、在每条 `tool.call` 链与 `turn.complete` 结束后以及按下之后重绘；在其他时刻改变模块级状态的模组在下一次触发时绘出。按下运行 `onPress` 时没有时间限制 |
| 带 `focus`、`scroll`、停靠在对话旁的 `Pane` | 没有面板：`$.ui.open` 回答 `{ isPlaced: false }`，模组回退到横幅；测试工具包直接挂载 `Pane` 钩子 |
| 热键、`TextInput`、焦点、滚动、`ui.press`、`ui.input`、`ui.select` | 不服务；后续工作 |

## 测试

| `claude-code/testing` | 本桥接 |
|---|---|
| `describe`、`test(name, ($, on) => …)`、`expect`、`mock`、`tier` | 在本仓库内同一模块名基于 Vitest 提供它们；`test` 从测试文件位置推断模组（`<mod>/tests/*.test.ts` → `<mod>/index.ts`），`defineModTests` 可覆盖。仓库外则从 `@deepseek-ai/dsh-experimental-claude-code-mods/testing` 获取 `createModTestKit` 与 `mock` |
| `on` 为引擎的答案打桩；工具包自行回答 `ui.*` | 相同；`ui.open` 回答 `{ isPlaced: false }`，`ui.invalidate` 与 `ui.close` 成功；`session.cwd`、`process.run`、`fs.*`、`store.*`、`env.*` 需要桩（`mock.store`、`mock.env`、`mock.clock` 回答整个命名空间） |
| `$.ui.mount({ plugin, surface, component, props })` → `find`、`findAll`、`press`、`unmount` | 相同，另有 `tree()` 与 `text()`；每次读取都经所有已加载模组的钩子重新渲染；`plugin` 与 `surface` 为源码兼容而接受 |
| 测试中钩子预算 5 秒 | 相同（`budgetMs`） |

## 示例模组

| 模组 | 来源 | 经本桥接 |
|---|---|---|
| Token Weather | 文中的模块、类型契约与测试，原样 | 按发布原样运行；测试中的三处 `as any` 转换因工具包带类型而去掉。通过 token 计量器从 `$.session.usage` 在横幅中绘制 |
| Blast Radius | 文中的 `tool.call` 钩子原样；`classify`、`measure` 与树按文中描述补全 | 以真实的 `sleep` 轮询持有命令，在横幅中绘制报告（`isPlaced: false`），由 Proceed 或 Cancel 决定；请加载在 Token Weather 之前 |
| Replay Theater | 文中的五个钩子原样；`stepsFor`、差异、`openReplay`、面板与提示补全 | 记录 Edit 与 Write 调用，轮结束后在横幅中提示，并因无面板放置而在横幅中逐步浏览差异 |
| `diff`（[anthropics/claude-code](https://github.com/anthropics/claude-code/tree/main/mods/diff)，于 `52c7644` 阅读） | TypeScript，约 570 个文件，钩住 `command.run`、`prompt.submit`、`session.start`、`tool.call`、`ui.close`、`ui.focus`、`ui.render`、`ui.scroll` | 不可运行：需要 `$.settings.read`、`$.telemetry.*`、面板上的 `$.session.messages`、`ui.focus` 与 `ui.scroll` 事件以及已放置的 `Pane`。以阅读方式评估；该仓库的条款不允许复制夹具 |
| `agents-md`（同一仓库） | 钩住 `agent.spawn`、`prompt.context`、`session.start`、`tool.call` | 不可运行：`prompt.context` 与 `agent.spawn` 不触发，`$.fs.ancestors`、`$.telemetry.*` 不服务 |
| `sec-default`（同一仓库） | 钩住 `tool.check`、`prompt.compose`、`settings.read`、`classic.*`、`plugin.register`…… | 不可运行：基于本宿主不触发的事件的托管层策略 |
| `telemetry`（同一仓库） | 钩住 `engine.create`、`telemetry.*`、`session.start`、`session.end`；调用 `$.session.repo`、`$.settings.read` | 不可运行：`telemetry.*` 与 `engine.create` 不触发，两个 `$` 成员不服务 |

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclaudecodemods--claudecodemods"></a>

### `ctx.claudeCodeMods` — `ClaudeCodeMods`

The bridge service: loaded mods, their hooks, and the harness listeners that raise their events. Mods join through ClaudeCodeMods.add, which defineMod calls when a mod plugin mounts. The Remote methods let a Client draw each session's band above the prompt and press its buttons.

```ts cordis-catalog
/**
 * Watch the band above the prompt of one session: the current drawing, then
 * every redraw, until the Client stops watching.
 * @param agent - the session's agent, resolved by the Gateway.
 * @param signal - carrier cancellation.
 * @returns the band's snapshots.
 */
@Remote({ mode: 'stream' }) watchBand(agent: Agent, signal: AbortSignal): AsyncIterable<SurfaceSnapshot>

/**
 * Press a button of the band's current drawing: runs the mod's `onPress` and redraws.
 * @param agent - the session's agent, resolved by the Gateway.
 * @param generation - the drawing the Client saw.
 * @param actionId - the button's action id in that drawing.
 * @returns the snapshot after the press.
 */
@Remote pressBand(agent: Agent, generation: number, actionId: string): Promise<SurfaceSnapshot>

/**
 * Load one mod beneath every mod loaded before it: run its `register`,
 * keep its hooks, and report which of its events this host never raises.
 * @param definition - the mod as its plugin defined it.
 * @returns the disposer that removes the mod's hooks, closes its timers, and releases its registrations.
 * @throws Error when the name is invalid or taken, or when `register` throws (Claude Code's `hooks module did not load` wording).
 */
async add(definition: ModDefinition): Promise<() => Promise<void>>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/claude-code-mods/src/index.ts`](../../packages/experimental/claude-code-mods/src/index.ts)
<!-- END GENERATED cordis-surface -->
