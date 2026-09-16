# Agent Note: Composer 与 DraftEditor 隔离的两阶段重构

Status: proposed

[English](2026-09-14-composer-model-and-draft-editor.md) | 中文

## 问题

同一个 Client 需要在不同视图中编辑同一个 Session 的草稿和待发送附件。Lexical 的一个 editor 只能绑定一个 DOM root；多个呈现位置需要多个编辑实例，但不能各自拥有互不相干的草稿和上传任务，也不能让 Session Controller 理解光标、输入法或 DOM。

当前 [SessionInputShell](../../../../packages/client/ui-conversation/src/client/input/facade.ts) 同时包含 Lexical 操作、草稿投影、提交状态机和失败恢复。[InputBar](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx) 同时包含编辑区呈现、DOM 绑定、附件入口和发送控件。直接在这两个文件中实现多实例会让代码提取与行为差异混在一起。

附件实体和上传任务已经由 [ConversationController](../../../../packages/client/ui-conversation/src/client/service.ts) 集中管理，shell 只保留有序附件 IDs。skill（技能）选择插入普通 `/name` 文本，高亮由词表派生；文件和 Session 的原子引用则使用带来源身份的 chip。共享草稿不能只同步文字而丢失这些引用，也不需要复制附件实体。

本提案细化 [#3951](https://github.com/deepseek-ai/deepseek-harness/pull/3951) 的编辑器隔离，遵循 [Client Session 与 UI 所有权](../../implemented/architecture/2026-08-20-client-session-conversation-ownership.zh.md)。Session 活跃视图、驻留状态与回收策略独立设计；[#4138](https://github.com/deepseek-ai/deepseek-harness/pull/4138) 仅作为 Host 生命周期参考。本提案不实现这些功能，也不重复 #3984 的 Conversation 组件拆分。

## 提案

采用两个独立 PR（Pull Request）。第一阶段集中既有编辑实现，为行为改动准备明确位置；第二阶段只修改行为。`DraftEditor` 专指草稿编辑区，Composer 指包含附件和发送控件的完整编写区域。保留 `input/`、`skeleton/`、`InputBar`、`InputHub` 和 `SessionInputShell`，不以改目录或改名作为重构成果。

### 第一阶段：五处机械职责提取

以下 ui-conversation 路径相对 `packages/client/ui-conversation/src/client/`。每个新文件必须承载当前已经执行的逻辑，不建立占位接口或未来功能。

| 原位置 | 提取位置 | 后续行为修改的落点 |
|---|---|---|
| `input/facade.ts` 的 Lexical 创建、注册、投影、节点操作和清理 | `input/editor/runtime.ts` | 单个 editor 的实现及其创建、绑定和释放 |
| `skeleton/InputBar.tsx` 的文字区域 JSX | `input/editor/DraftEditor.tsx` | 单份编辑区的呈现，不包含附件栏和提交编排 |
| `InputBar.tsx` 的 focus、selection reveal、wheel、keymap、picker 绑定函数 | `input/editor/view-binding.ts` | 单个挂载视图的 DOM 交互和编辑器绑定 |
| `contract/input.ts` 的范围、引用、键盘接口类型 | `contract/draft-editor.ts` | 编辑器对外数据与操作类型；提交和共享状态仍留原文件 |
| `ui-attachment/src/client/ComposerAttachments.tsx` 的 document drop effect 实现 | `ui-attachment/src/client/drop-events.ts` | document 拖放监听的注册、路由和清理 |

`runtime.ts` 内部对象由现有 shell 创建并委托调用。它保管原 editor、NodeKey 映射、投影和 Lexical 注册；不复制这些状态，也不独立决定能否编辑或提交。shell 继续持有 SubmitMachine、draft revision、附件 IDs、通知、attempt、序列化以及成功/失败恢复决策。

同时涉及判断和节点操作的方法在原位置保留判断。例如 beginCommand 的 span/phase 检查、节点替换、machine dispatch 的顺序不变；失败恢复的批次排序、revision 保护、恢复标志和 history 清理时点不变。editor 更新仍在原同步位置回调 shell 发布状态，不增加 Promise、effect 或通知轮次。

`DraftEditor.tsx` 是无额外 DOM 包装的呈现提取。所有既有 React 钩子、refs、依赖数组和 effect 相对顺序仍留在 InputBar；effect 只在原调用位置委托普通函数。CSS 文件、class keys、React keys、placeholder 与 decorator 顺序均不变。新组件不接管 editor 创建或持有另一份草稿。

`contract/draft-editor.ts` 移入 `TokenSpan`、`ReferenceInsert`、`ArbitrateKey`、`ArbitrateOutcome`、`ComposerKeyboard`、`EditSelection` 和 `Occurrence`。名称和成员不变，所有消费方从实际声明处导入；既有公开出口保持原名称和可见集合。`ComposerKeyboard` 仍暂时依赖共享 `InputState`，这不是独立受控编辑协议。

#### 第一阶段不变项

- InputHub 仍按 Session 创建一个 shell 和一个 editor，创建、复用、dispose（资源释放）的时点及次数不变。
- 草稿真值仍在 Lexical，Undo/Redo、NodeKey 身份、span 检查和 revision 规则不变；不增加第二份文档或存储。
- `useInput`、`inputActions`、Slot、事件、inject 及公开 API 的名称、载荷和行为不变；不改 Host 协议和持久化格式。
- 附件选择、上传时机、图片预览、提交批次、成功清空、失败恢复及通知规则不变。
- document drop 仍在每个原组件的同一 effect 中注册；单 picker、重复 drop、单 editor/root 的限制原样保留。
- 测试只修改实际需要的类型导入；不改测试文件名、断言、录制 Session 或预期输出，不刷新快照。
- 不搬已有文件，不改已有私有名字，不改 CSS，不增包、依赖、renderer scope 或通用状态框架。

#### 第一阶段实际隔离程度

| 内容 | 完成后的状态 |
|---|---|
| 编辑器实现 | 节点和投影操作归 runtime，呈现归 DraftEditor，DOM 绑定归 view-binding |
| 提交与附件编排 | 仍由原 shell 和 ConversationController 管理，不落入 DraftEditor |
| 不同 Session 的状态 | 继续按原规则隔离 |
| 同 Session 的共享状态 | 继续复用原 shell；没有双份附件或上传任务 |
| 同 Session 的独立编辑实例 | 未实现，仍共享一个 Lexical editor |
| 独立 selection、IME、Undo 和菜单来源 | 未实现；代码位置分开不代表运行时归属已改变 |
| picker、focus、document drop 的多视图路由 | 未实现；绑定代码已有单独修改位置 |

### 第二阶段：只调整行为

第二阶段直接在上述位置实现共享草稿和多编辑实例。禁止移动已有文件或目录、纯改名、纯提取 helper/class/component、重排已有测试，以及格式或注释清理。新增行为需要的新类型、实现和测试可以增加，但不得复制旧代码到新文件后删除原文来规避约束。

如果行为实现仍需要结构准备，必须先补第一阶段：未合入时修改第一阶段 PR；已合入时单独增加机械前置 PR。行为 PR 以该机械结果为 base，不能夹带机械准备。

#### 最终状态归属

共享 Composer 模型是现有 SessionInputShell 的职责演进，不要求再次改名。Session Controller 继续只管理会话业务，不 import DraftEditor、Lexical 或共享草稿文档。

| 状态 | 最终 owner | 多视图要求 |
|---|---|---|
| 草稿正文、语义引用、内容 revision | Session 关联的共享 Composer 模型 | 任一处编辑后，通过同一个响应式来源发布给所有视图 |
| 有序附件 IDs、认领、提交 attempt 和失败恢复 | 共享 Composer 模型 | 每个提交只结算一次，任一视图的操作作用于同一批输入 |
| File、Blob URL、上传任务、进度和凭证 | 既有附件管理 owner | 不随视图复制；卸载一个视图不取消其他视图所用资源 |
| Lexical、DOM、NodeKey 映射、selection、IME preedit | 各 DraftEditor 实例 | 两个独立 editor/root；卸载一处不解绑另一处 |
| 菜单锚点、文件对话框和焦点 | 发起操作的视图 | 按操作来源路由，不以 Session 唯一 picker 代替来源 |
| Session 历史、running、queue | Session Controller | 继续读取现有来源，不复制进草稿模型 |

React 钩子仍由 renderer 从裸 observable 绑定，业务组件通过现有标准 props 读写。共享模型不接收 DOM、Lexical NodeKey 或输入法中间态；DraftEditor 不接收 Session/Context 或上传服务，只接收草稿数据、显示数据与编辑/意图回调。

#### 共享内容和同步要求

草稿内容必须能独立于 Lexical 表示普通文本、换行和带完整 `ReferenceInsert` 信息的原子引用。引用的共享身份不能依赖某个 editor 的 NodeKey；各实例私有映射到自己的节点。skill 保持普通 `/name` 文本，两处从同一文本和词表派生高亮，不引入额外的已选 skill 列表或改变 Host 识别规则。

草稿文本量小，可以使用完整语义文档同步，不要求协同编辑算法。共享模型负责接受编辑、分配 revision 和发布，编辑器区分本地产生的变化与外部呈现，避免回声循环。旧 revision、旧模型生命周期和已卸载视图的回调不能覆盖新内容。提交冻结、成功清空、失败恢复和附件变化必须通过同一共享来源到达所有视图。

IME preedit 属于本地实例，远端视图更新不能直接破坏正在组合的文本。来自另一视图的修改、发送清空和模型释放如何与组合态相遇，必须在第二阶段定义并验证。Undo/Redo 也必须作用于同一份逻辑草稿，不能让两份 Lexical history 互相恢复陈旧整篇文档；具体同步与历史实现不属于机械阶段。

程序化插入、菜单选择、文件选择器和焦点恢复要携带发起视图的临时身份。视图关闭后不能把迟到的 UI 操作转发给另一个同 Session 视图。document drop 必须明确一次拖放选哪个目标并保证仅处理一次；来源路由和去重均是第二阶段行为。

刷新后的既有文字草稿恢复应保留，但不默认新增结构化引用、File 或跨浏览器协作的持久化承诺。Session 活跃视图及 LRU/时限策略不与这份编辑协议绑定。

## 考虑过的替代方案

**仅把 input 改名或平移到 composer。** 不能分离 Lexical 操作、视图绑定和提交决策，后续行为实现仍需从大文件中提取旧代码，因此不作为第一阶段成果。

**让一个 Lexical editor 同时挂两个 DOM root。** 与 Lexical 的单 root 模型冲突，不能用 React 复制呈现来获得两个可独立交互的编辑器。

**每个 Composer 独立草稿和附件。** 不满足同一 Session 共享编辑的要求，还会引入附件和提交所有权分歧。

**机械阶段直接实现共享 DraftDocument、Undo 或 drop 去重。** 改变真值、生命周期或事件处理次数，无法作为行为不变的前置改动审查。

## 验收标准

第一阶段必须完成五处提取及必要导入、JSDoc 和 README 更新；逐项核对原方法体、分支、回调次序、Hooks、DOM 和清理。现有编辑、引用、认领、附件、提交、失败恢复和卸载测试继续通过；用构建产物运行针对性浏览器回归，预期输出不变。类型和文档检查覆盖移动后的声明与双语配对。不以新双实例功能作为第一阶段验收条件。

第二阶段必须用同一 Session 的两个真实挂载 Composer 验证双向文字和 chip 同步、skill 高亮、共享附件和进度、发送清空/失败恢复、IME/Undo、来源路由，以及任一视图卸载后另一处继续工作。其差异必须仅包含行为实现及相应测试，不包含机械整理。

## 风险

无状态 JSX 提取仍可能改变 ref 或 effect 时序；因此 Hook 和 ref 的宿主保持不变，DOM 不增加包装。Lexical 提取可能改变嵌套 update、projection 缓存或 history 清理顺序；因此保留原操作体并对照执行次序，而非重写算法。

第一阶段仍不能同时挂载同 Session 的两个编辑器，且保留原 picker/drop 限制。后续若误把目录隔离当成状态隔离，会造成 root 相互解绑、重复附件接收或错误焦点路由；这些限制必须由第二阶段的双实例行为测试关闭。
