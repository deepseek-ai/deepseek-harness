# Agent Note: 在所有应有之处使用 branded ID

Status: implemented
Archived: 2026-09-04

[English](2026-06-20-branded-ids.md) | 中文

## 问题

harness 使用 `Branded<B> = string & { readonly [BRAND]: B }` 以及 `@deepseek-ai/dsh-brand` 中的无状态 `brandString<T>()` 构造函数，为 `ToolCallId`（`packages/llm/llm/src/brand.ts`）和 agent（智能体）/会话共享的 `SessionId`（`packages/core/session/src/types.ts`）做 brand 处理；该包位于 `packages/util/brand/`，见其 [README](../../../../packages/util/brand/README.zh.md)。`dsh-brand` 还声明了治理策略：*「Branding 用于跨包边界且可能被混淆的 id；不是每个 string 都需要 brand。」* 这条策略是正确的；问题在于它只落实了一半。两处缺口使得结构相同但语义错误的 string 仍能通过类型检查器。

**缺口 1：bash seam 中未 brand 的跨边界 ID。** 后台 job id 是普通 `string`：`BashTask.id: string`（`packages/shell/shell/src/types.ts`），作为 `string` 贯穿整个执行器 seam（`packages/shell/shell/src/index.ts` 中的 `ShellExecutor.get`/`ownerOf`/`readOutput`/`kill(id: string)`），再由面向模型的工具以 `string` 校验并传递（`validateJobId`、`assertTaskAccess`、`packages/shell/tool-bash/src/index.ts` 中 `job_id` 的 schema 参数）。它由每执行器计数器生成——`packages/shell/bash-local/src/index.ts` 中的 `` `bash-${this.nextTaskId++}` ``——其形状与 `SessionId` 的默认值**完全相同，都是 `name-N`**（`packages/core/session/src/index.ts` 中的 `` `session-${++counter}` ``）。bash job id 和会话 id 在调用点轻易就能互换，而编译器毫无反应。它是面向模型的 id（模型会把 `job_id` 传回 `bash_output`/`bash_kill`），所以该混淆可由不受信任的输入触达。

bash **owner token** 是相关的子情形：`ShellExecRequest.owner?: string` 和 `ShellExecSpec.owner: string | undefined`（`packages/shell/shell/src/types.ts`）被文档描述为刻意*不透明*的隔离键，但在所有实际调用方中，该值就是所属 agent 共享的 `Agent.id`/`SessionId`（`callerToken = (exec) => exec.agent?.id`，位于 `packages/shell/tool-bash/src/index.ts`），只是披着另一个 seam 本地名称。它被用于访问控制比较（`owner !== callerToken(exec)`），因此一个不匹配但类型正确的 string 在此处就是跨会话隔离 bug，而当前类型系统无法捕获。这正是[统一 agent/session 标识决策](../simplification/2026-06-20-unify-agent-and-session-id.zh.md)覆盖的共享 id 别名。

**缺口 2：*已经 brand* 的 ID 在边界处被侵蚀。** 就连 `ToolCallId` 和 `SessionId` 也恰好在最容易混淆的地方退化为裸 `string`：注册表/store 键类型和公开方法参数。代表性位置包括会话存储、agent 注册表（二者都以共享的 `SessionId` 为键）、工具展示层的 call-id map、ACP（Agent Client Protocol）的会话记录，以及持久化协调器。在集合键处丢弃 brand，会让既有 brand 在查找时毫无价值；它们的价值只实现了一部分。

## 决策

Brand 仍是普通字符串；`brandString<T>()` 原样返回输入，因此序列化、比较与协议格式（wire format）均不改变。该决策分三部分，全部遵循既有的「不是每个 string 都需要」策略。

- **为 bash job id 加 brand。** 在 `packages/shell/shell/src/types.ts`（*拥有*该 id 的包）中添加 `BashTaskId = Branded<'BashTaskId'>`，从 `@deepseek-ai/dsh-brand` 导入 `Branded` 并用 `brandString<BashTaskId>()` 构造值。brand 工具包让 `dsh-shell` 只依赖它就能为自己的 id 加 brand，而无需为了原语引入 `dsh-llm` 或 `dsh-session`。将该类型贯穿 `BashTask.id`、`ShellExecutor` Service Definition 方法（`get`/`ownerOf`/`readOutput`/`kill`）、`dsh-bash-local` 中的生成点，以及 `dsh-tool-bash` 的校验/访问面。

- **铸造独立的 `OwnerToken` brand。** 在 `packages/shell/shell/src/types.ts` 中添加 `OwnerToken = Branded<'OwnerToken'>`；将 `ShellExecRequest.owner` / `ShellExecSpec.owner` / `ShellExecutor.ownerOf` 的类型标注为 `OwnerToken | undefined`。`dsh-tool-bash` 消费方在两套词汇唯一交汇的位置，对 agent 共享的 `id`（`SessionId`）应用 `brandString<OwnerToken>()`。bash Service Definition 从不导入 `dsh-session`。（理由见下一节。）

- **阻止 brand 侵蚀。** 将既有 brand 传播到缺口 2 列出的 `Map` 键类型和公开方法参数中：`Map<SessionId, Session>`、`Map<SessionId, Agent>`、`get(id: SessionId)`、`Map<ToolCallId, …>`、ACP 的 `SessionId` surface、协调器的 `Map<SessionId, …>`。这是变更中机械量最大的部分，也是让*既有* brand 在查找处真正发挥作用（而不仅仅标注在结构体字段上）的关键。

示意形状：

```ts ignore-check
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** A background bash task handle (generated `bash-N` by the local executor). */
export type BashTaskId = Branded<'BashTaskId'>
const taskId = brandString<BashTaskId>('bash-1')

/** A bash task's opaque isolation key — the consumer's owner identity, NOT the bash seam's. */
export type OwnerToken = Branded<'OwnerToken'>
const owner = brandString<OwnerToken>('session-1')
```

## 曾考虑的替代方案

### 为什么不把 `owner` 类型标注为 `SessionId`？

显而易见的捷径是直接把 `owner` 类型标注为 `SessionId`——它确实*总是*一个会话 id。我们否决这个方案。bash 执行器 seam 是能力 seam（Service Definition `dsh-shell`、Service Provider `dsh-bash-local`、Consumer `dsh-tool-bash`），其 owner token 被*明确记录为刻意不透明*：执行器「从不解释它（seam 中没有访问策略——那是消费方的职责）」（`packages/shell/shell/src/types.ts`）。把 Service Definition 的字段类型标注为 `SessionId`，会把 `dsh-session` 的词汇引入一个不应知道 owner token *含义*的包——这会让通用执行后端耦合会话模型，并违背不透明 token 的设计。取代 `dsh-bash-local` 的沙箱化执行器或远程执行器不应继承会话依赖。独立的 `OwnerToken` brand 使 seam 保持解耦：`dsh-shell` 只知道「owner 是某种带 brand 的不透明 token」，而已经决定访问策略的 `dsh-tool-bash` 消费方，是把 `brandString<OwnerToken>()` 应用于其 `SessionId` 的唯一边界。该 brand 仍带来安全收益（不能把 `BashTaskId` 或裸 string 传到 owner 位置），且不引入耦合。

## 不在范围内 / 可能的扩展

遵循「不是每个 string 都需要 brand」的策略，刻意保持窄范围。以下每项都是合理的未来 brand 候选，附带推迟理由而非承诺：

- **`ModelId`**（`GenerateOptions.model`，`LlmRuntime` 适配器注册表的键）：一个真正的跨包查找键（config → agent → llm → 适配器）；合理的下一个 brand，仅为控制本决策的影响范围而暂不纳入。
- **`ToolName`**（`ToolRuntime` 的键）：由作者定义、人类可读，且很少与其他 id 混淆；最弱的候选，可能不值得加 brand。
- **`ErrorCode`**（`HarnessError.code`）：一个封闭词汇（`ABORTED`、`NO_ADAPTER`……），不是逐实例的 id；如果要做，string 字面量联合类型比 brand 更合适。
- **其他数值序号**：[Session 序列号与日志偏移决策](2026-08-31-session-sequence-and-log-offset-brands.zh.md)会为事件身份与日志间隙加 brand，因为它们跨越 persistence 与引用 seam。turn 与 step number 保持普通 number：它们是 payload-local ordinal，不会与 Session 事件位置互换。
- **带校验的构造**：`brandString<T>()` 不执行运行时检查，且每个边界（ACP `sessionId`、提供方签发的 `call.id`、`dsh-llm-deepseek` 中的空字符串回退）都信任裸 string。一个在边界处对格式错误的输入抛异常的 `SessionId.parse()` / `isValid()` 配套工具确实是缺口，但它属于运行时行为变更，有自己的设计问题（什么算「格式错误」？失败时会怎样？），应在独立决策中处理。

## 验证

已落地的不变式如下：`BashTaskId` 和 `OwnerToken` 定义在 `dsh-shell` 中，并端到端贯穿 Service Definition、`dsh-bash-local` 生成点与 `dsh-tool-bash` 面向模型的工具，且 `dsh-shell` 未添加对 `dsh-session` 的依赖；没有任何以范围内 brand id（`ToolCallId`/`SessionId`/`BashTaskId`）为键的集合使用裸 `string`；公开方法参数和导出签名保留 brand；每个原始 string 进入的边界都使用 `brandString<T>()`，而不是散落的 `as` cast。

## 后果

- **两个接口面的机械性改动。** 传播 brand 涉及 bash seam（Service Definition + Service Provider + Consumer）以及 ACP 会话 id 接口和持久化协调器。改动面广但严重度低：遗漏的位置是编译错误而非静默 bug。构造返回同一个运行时字符串，因此不会产生 snapshot 或 e2e 行为差异。它与[统一 agent/会话标识决策](../simplification/2026-06-20-unify-agent-and-session-id.zh.md)相邻，因为二者都触及会话 id / owner-token 边界；`OwnerToken` 出于上述解耦理由仍与统一后的 id 保持独立。
- **Brand 不做校验。** Brand 是混淆防护，不是正确性证明：一个*错误的*会话 id 只要仍是格式正确的 string，就和以前一样能通过类型检查器。本决策不关闭这个缺口（见「不在范围内」）——它只阻止这类*类别*错误：传入错误*种类*的 id。
- **「在哪里停下」仍是判断题。** 为 `BashTaskId` 加 brand 但不为 `ToolName` 加，为 `OwnerToken` 加但不为 `ModelId` 加，是对哪些 string「可能被混淆」的品味判断。合理的评审者可能想要更多或更少；`brand.ts` 中的策略是裁决依据，本决策倾向于面向模型或用于访问控制的 id。
