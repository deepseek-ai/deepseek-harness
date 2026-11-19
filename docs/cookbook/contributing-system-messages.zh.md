# 实践指南：贡献系统消息

[English](contributing-system-messages.md) | 中文

## 概要

通过 `ctx.systemPrompt.section()` 注册具名指令，已接受的 agent（智能体）步骤会首次引入指令、发送变化后的文本，并在其拥有者卸载后撤回指令。本教程假定你已有一个挂载在 `dsh` 配置中的 Cordis 插件，且配置提供 `systemPrompt`；创建插件的步骤见[包检查清单](adding-a-package.zh.md)。

## 目录

- [1. 注册指令](#1-register-instructions)
- [2. 更新文本](#2-update-the-text)
- [3. 结束注册](#3-end-the-registration)
- [4. 选择作用域与消息类型](#4-choose-scope-and-message-kind)
- [5. 验证准入](#5-verify-admission)
- [延伸阅读](#further-exploration)
- [开发备注](#dev-note)

<a id="1-register-instructions"></a>

## 1. 注册指令

声明服务依赖，并通过插件的 `ctx` 注册。Cordis 管理返回的清理函数，在插件卸载时清理注册。

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'

export const name = 'example-response-style'
export const inject = ['systemPrompt']

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'example:response-style',
    order: 100,
    text: 'Use concise sentences and include relevant file paths.',
    interpolate: false,
    retirement: 'The response-style instructions no longer apply.',
  })
}
```

使用稳定且带命名空间的 `name`，以便在更新和重新加载之间识别同一组指令。最近作用域中的同名注册遮蔽外层注册；同一作用域中，最后一个活跃注册优先。`order` 必须是有限数值；节先按顺序值排序，再按名称排序。示例使用局部顺序值；第一方贡献应通过 `getSectionOrder()` 获取所属位置。可用名称和数值见[系统提示源码](../../packages/core/system-prompt/src/index.ts)中的 `SECTION_ORDERS`，查询方法 `SystemPrompt.getSectionOrder()` 也位于该文件。

<a id="2-update-the-text"></a>

## 2. 更新文本

对于会变化的指令，保留一次注册，让同步 `text` 回调读取当前状态。在插件的 `apply(ctx)` 中调用此辅助函数，再从你负责的状态变化处理器调用返回的 `update()`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'

export function registerInstructions(ctx: Context, initialText: string) {
  let currentText = initialText
  const dispose = ctx.systemPrompt.section({
    name: 'example:workspace-policy',
    order: 200,
    text: () => currentText,
    interpolate: false,
    replacement: 'The workspace policy has changed.',
    retirement: 'The workspace policy no longer applies.',
  })
  return {
    update(text: string) { currentText = text },
    dispose,
  }
}
```

有效注册的回调会在每次 `assemble()` 时执行，包括检查操作和可能不被接受的候选步骤。隐藏注册的回调不会执行。保持回调无副作用；它并非只在文本变化时执行。带 Session 的组装会捕获渲染文本；循环将其与该 Session 的已提交系统记录比较，并在已接受步骤的首次请求前提交由此得到的消息增量。重试复用该组装；步骤内发生压缩时，根据同一份捕获文本重建系统头节点。`update()` 本身不会发送消息或启动模型请求。已完成组装的步骤保留当时捕获的文本。

省略 `replacement` 可使用包含节名称的默认替换通知；设为 `''` 可省略前缀。通知只用于更新此前已准入的指令，不用于首次引入。在同一作用域再次调用 `section()` 会覆盖先前注册，直到新注册被清理；通过 `text()` 读取可变状态可避免添加覆盖。

**每个新节都应显式设置 `interpolate: false`**，像两个示例一样，避免意外插值。API 为兼容性保留默认值 `true`，因此省略该选项可能替换 `{{name}}`，或因未知变量而失败，即使文本由回调返回也一样。请在回调中使用普通 JavaScript 表达式或模板字符串计算动态文本。系统节在直接比较文本前去除首尾空白，因此只改变首尾空白不会发送更新。

对于大型且可变的系统提示，可将独立变化的指令拆分为多个节。例如，将稳定的回答规则与频繁更新的工作区指令分开。为每部分分配稳定的名称、各自的顺序值和文本提供者，以及显式撤回通知。更新会重发整个发生变化的节；拆分后，可以更新或撤回其中一部分，而不重发未变的部分。

要让仍然注册的节变为空文本，返回 `''`。新注册的空节不贡献内容；已有非空节变空时，使用其替换通知，未提供替换通知时则使用默认撤回通知。仅含空白的字符串行为相同，因此 `"\n"` 变为 `"\n\n"` 不会发送额外更新。

<a id="3-end-the-registration"></a>

## 3. 结束注册

如果指令在插件卸载前就不再适用，调用返回的 `dispose()`；否则交给 Cordis 清理。为每个节提供显式的 `retirement` 通知，让模型知道哪些指令不再适用。API 允许省略，但鼓励提供含义明确的通知。通知是字面文本，去除首尾空白后必须非空；清理不会再次调用已清理的文本提供者。

释放只移除对应注册。如果另一个可见注册具有同名，下一次组装会使用其文本和替换通知，而不是撤回来源。只有可见作用域链中的所有注册都被释放后才会撤回，且仅发送给观察过注册并此前提交过该名称的 Session。通知来自最后一个被释放且曾被观察到的注册。在准入前注册并立即清理，不会向从未接收该节的 Session 发送撤回消息。在下次准入前清理并重新注册同名节，若渲染文本未变，则不发送消息；若文本不同，则发送一次替换更新。

若多项注册共享同一生命周期，在 Cordis 生成器副作用中 yield 各自的清理函数。[工具执行器注册](../../packages/core/tools/src/index.ts)使用了这一模式。如果后续注册抛出异常，Cordis 会清理之前的注册；这些注册仍遵循普通撤回规则。

<a id="4-choose-scope-and-message-kind"></a>

## 4. 选择作用域与消息类型

通过 agent 的 `ctx` 注册仅适用于该 agent 的指令。复用父级来源名称以覆盖它；需要独立撤回的指令应使用不同名称。覆盖 persona 时，以对应的 `getSectionOrder()` 位置注册 `PERSONA_PREFIX_SECTION` 或 `PERSONA_SUFFIX_SECTION`，或挂载 [persona 插件](../../packages/preset/persona/README.zh.md)来注册两者。只覆盖前缀时会继承后缀。将工作目录等变化的运行事实放在 `ctx.systemPrompt.context()` 中；它们会成为用户角色上下文快照，并使用独立的刷新路径。

强烈不建议插件使用 `complete: true`。保留它仅为让 [minimal 预设](../../packages/bundle/web-app/presets/minimal.patch.yml)抑制正常系统消息，几乎没有插件场景适用这一例外。请贡献普通节；抑制整个提示也会移除其他插件的指令。

<a id="5-verify-admission"></a>

## 5. 验证准入

在代理 Session 中运行贡献，并检查日志中的 `system/message` 事件。注册和组装本身不会提交消息；循环只在首次尝试中追加准备好的增量一次。[准入测试](../../packages/core/system-prompt/tests/admission.spec.ts)展示了适用于包测试的小型测试装置。

1. 准入初始文本，再准入未变的文本：第二次准入不增加系统更新。
2. 改变回调读取的状态：下次接受的组装只增加该节的文本和替换通知。
3. 只改变首尾空白：不增加更新。
4. 清理覆盖：继承的指令通过普通替换恢复。清理所有可见注册：已接收该节的 Session 收到一次撤回通知；新 Session 不收到撤回通知。
5. 在两次准入之间清理并恢复相同文本：不增加撤回或替换消息。

开发贡献时运行现有的聚焦行为测试：

```sh
pnpm exec vitest run packages/core/system-prompt/tests
```

检查转录时读取所有仍保留的系统消息；后续消息包含更新，而非完整提示。压缩可能将它们合并。运行时定义和未提交的释放状态仅存在于进程中。仅凭重放或继承文本，无法恢复当前 Session 从未观察过的来源的撤回；见[已知限制](../../packages/core/system-prompt/README.zh.md#known-limitations-and-deferred-work)。

<a id="further-exploration"></a>

## 延伸阅读

- [系统提示 API 参考](../subsystems/system-prompt.zh.md)——类型和服务方法。
- [按节准入的设计理由](../../.agents/notes/implemented/architecture/2026-10-21-section-based-system-updates.zh.md)——注册、作用域覆盖与退役。
- [延后的压缩重建](../../.agents/notes/implemented/architecture/2026-11-09-deferred-system-compaction.zh.md)——已捕获的段与压缩后重建的指令。

<a id="dev-note"></a>

## 开发备注

无。
