# Agent Note: 嵌套 terminal 卡片

Status: implemented

[English](2026-09-05-nested-terminal-cards.md) | 中文

## 问题

经 `run_code` 分发的 shell 命令携带 terminal 卡片所需的参数与渲染输出，但对所有带有 `parentCallId` 的块一律拒绝，会仅因调用嵌套而隐藏这类展示。该拒绝也影响运行中的命令提示行与选中子调用的 Details。

## 决策

`terminalCardModel` 对根调用与 Code Dispatch 调用应用相同的适用检查，不因 `parentCallId` 拒绝调用。受支持的运行中与已完成的 `bash`、`pwsh` 和 `terminal_send` 调用使用现有 terminal 卡片。后台调用、工具错误、格式错误的输入、缺失的调用头和不受支持的结果内容保留通用回退。持久 shell 在运行中仍可使用 terminal，完成后使用通用展示；非零进程退出仍是 terminal 结果数据，而非工具错误。

本文仅部分取代 [Client 派生工具展示](../architecture/2026-08-23-client-derived-tool-presentation.zh.md)中的 terminal 子调用卡片禁令。该文继续负责 Client 展示所有权及 diff/read/search/web 子调用限制。无需更改 Host 展示转换器、事件、schema、元数据、调用树或模型上下文。[规范工具输出](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)与 [PTC 类型化返回值](../feature/2026-07-20-ptc-typed-tool-returns.zh.md)中的元数据和执行期值决策保持不变；省略元数据不禁止 Client 派生 terminal 卡片。

以已识别的 spill 策略提示结尾的 shell 输出使用通用展示：在 `BashRow` 中可展开，在 Details 中使用原始回退。提示可能位于退出标记之后或取代它，因此末尾缺少退出标记不能作为 terminal 成功状态的依据。浏览器安全入口 `@deepseek-ai/dsh-spill-policy/notice` 负责文本约定：生产方调用 `formatSpillNotice(omitted, ref)`，Client 调用 `hasSpillNotice(text)`。两者共用分隔符，省略信息校验复用 `describeOmitted`，不复制其文案。格式化函数逐字节保留持久化拼写；现有 Session 结果字节保持不变，不更改 Session 格式，也不执行迁移。

## 考虑过的替代方案

**保留对嵌套调用的一律拒绝。** 不予采用，因为嵌套不会移除 terminal model 已消费的原始事实。这会隐藏可用的 shell 输出，而同一调用位于根时却可渲染为 terminal。

**启用所有嵌套结构化卡片。** 不予采用，因为其他 card model 有独立的元数据要求与子调用限制。本修复只改变 terminal 适用性。

**解析 spill 后缀附近的退出标记。** 不予采用，因为截断可能移除真实状态；保守的通用输出避免从不完整结果猜测成功。

**维护独立的 UI 通知正则表达式。** 不予采用，因为它复制生产方的文本约定，可能与持久化输出偏离。共享的浏览器安全模块统一负责格式化与识别，无需在浏览器中加载 Host 插件。

## 后果

行与 Details 对嵌套调用共享 terminal 派生，不增加第二个渲染器或展示提示字段。通用回退与已完成持久 shell 的行为仍独立于 terminal 卡片适用性。父子关系仍控制树中的位置，而非 terminal 渲染。文本识别无法认证输出来源：工具也能打印相同的提示。匹配结果只选择保守的通用展示，不能证明 spill 来源或进程状态。

## 验证

[Terminal 卡片测试](../../../../packages/client/ui-tool/tests/terminal-card.client.spec.tsx)覆盖根／子调用适用性、运行中与已完成的 Details 以及回退情况。[组装后的 Code Dispatch 测试](../../../../packages/client/ui-tool/tests/chat-code-subcalls.client.spec.tsx)覆盖经对话树渲染的嵌套 terminal。[通知测试](../../../../packages/spill/spill-policy/tests/notice.spec.ts)使用独立于格式化函数的字面量 fixture（测试前置数据）固定历史拼写。[spill-policy 到 UI 的测试](../../../../packages/client/ui-tool/tests/spill-policy-terminal.client.spec.ts)覆盖真实的根调用与 PTC spill 生成、保持不变的完整文本和程序化值、字节上限、仅含通知的输出以及 terminal 回退。浏览器回放负责验证可见的嵌套卡片变化；非 terminal 子调用行为不属于本修复。
