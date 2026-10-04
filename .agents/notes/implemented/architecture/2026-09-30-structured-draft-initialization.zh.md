# Agent Note: 草稿初始内容与结构化引用恢复

Status: implemented

[English](2026-09-30-structured-draft-initialization.md) | 中文

## 问题

新任务入口需要把一段尚未发送的内容放入输入框。草稿不仅包含文字，也包含用户已经选定的文件、目录和 Session 引用；只保存引用的文字投影，会在输入对象销毁后丢失胶囊的来源、目标和展示字段。页面挂载后的填字也不能保证第一次读取输入模型时已经得到完整内容。

## 决策

保留现有 `SessionInputShell`、`DraftEditorRuntime`、Conversation store 和 Session 引用生命周期。普通文字与结构化草稿统一经过输入模型导入；初始导入在 `InputHub.shellFor()` 返回对象前完成，不由 React effect 恢复文字。已存在的输入对象不重新恢复。React 只挂载同一编辑器，并绑定现有持久化回调。

`startSession(workspaceId?, options?)` 的第二参数保留 `prompt` 与 `clearPreviousDraft`。`prompt` 仅接受字符串；结构化草稿只用于内部恢复和工作区携带。无选项时维持原流程。不清空时保留已有内容，空稿才采用 prompt；显式清空作用于目标 Session 的文字文档，不删除附件，也不修改其他 Session。预填不自动发送、执行命令或改变 `blank`。

### 数据模型

`DraftSnapshot` 由 `text` 和 `references` 组成。每个引用保留 `offset`、`length`、`source`、`ref`、`label`、`appearance`、`clipboardText` 及已有的无效标记；位置使用 JavaScript 字符串坐标。引用位置必须有序、不重叠，且对应的正文片段与 `clipboardText` 一致。不保存 Lexical NodeKey、DOM、运行时 occurrenceId、函数或临时高亮。

字符串等价于不含引用结构的输入；不会据模糊的 `@` 查询擅自选中某个文件。公开的 `SessionInput.setDraft` 与 `InputActions.setDraft` 仅接受文本。内部结构化恢复直接复用编辑器已有的引用恢复能力，无需查询文件目录或读取文件内容。恢复普通文字、文件胶囊、目录胶囊和 Session 胶囊都经过已注册的编辑器变换和投影流程。

现有 `dsh.conversation.<sessionId>` key 保留，`draft` 可读取旧字符串，也可读取新的结构化值；新写入保存结构化值。仍由原 Conversation store 写整个记录，不增加第二个同 key 写入者。引用变化即使没有改变显示文字，也必须进入持久化快照。

### Class 与方法

| 位置 | 改动与职责 |
| --- | --- |
| `UiWorkspace`／`UiWorkspaceService.startSession` | 第二参数类型为 `StartSessionOptions`；在原 `beforeOpen` 准备点向准确的目标 binding 传入初始化请求。创建、复用与导航取消路径不变 |
| `SessionInputResolver`／`InputHub.requestDraftInitialization` | 接收 binding 和 options，交给该 binding 的输入对象，不重新查找全局当前 Session |
| `InputHub.shellFor` | 新对象登记及清理接线后，读取该 Session 保存的草稿，通过输入模型导入，然后返回；复用对象不再恢复 |
| `stores.ts` 的 `readConversationDraft(sessionId)`／`draft.ts` 的 `parseStoredDraft` | 只读原存储 key；兼容字符串并检查结构化引用的位置和字段，不创建 store 或增加写入者 |
| `SessionInputShell.setDraft` | 具体类的内部方法接受字符串或 `DraftSnapshot`，向编辑器发送一次文档导入；公开输入方法仅接受文本。两条路径均不模拟键盘事件、不提交内容 |
| `SessionInputShell.requestDraftInitialization` | 在已经恢复的模型上执行清空／保留／填入规则；提交中拒绝修改，失败前不先清稿 |
| `SessionInputShell.draftSnapshot`／`persistCurrentDraft()` | 按内容修订号缓存不含运行时 ID 的快照；`InputActions.persistDraft()` 委托显式保存方法；`bindDraftPersistence(write)` 仍只绑定回调 |
| `DraftEditorRuntime.restoreDraft` | 接受引用的语义字段，重建 ReferenceChipNode；既有发送失败恢复继续使用同一实现 |
| `SessionInputShell.refreshLexiconSubscription()`／`DraftEditorRuntime.refreshLexiconSubscription()` | `InputHub` 拥有 Session scope 的 `inject` 回调，在缓存输入对象后连接词典，服务到达或替换时重接，销毁时退订。连接和词典更新都会重扫当前 editor，不覆盖旧文本；`setDraft` 不负责建立订阅 |
| `ConversationStoreState`／`createConversationStore` | draft 支持兼容旧字符串的结构化输入，View 状态及原 key 保持 |
| `DefaultConversationViews` | 删除恢复／预填 effect；保留持久化回调的绑定和解绑。初始保存只能读取 owner 的当前快照，不能把 render 时的旧文字写回 |
| `apply.ts` 中现有 `selectWorkspace` 回调 | 沿用原有跨工作区携带规则，但传递 `draftSnapshot` 而不是纯文本，防止携带时再次丢失引用 |

不新增草稿服务、存储 key、通用任务框架或另一套 Session 创建入口；不改 SlotRenderer、Host Session 日志、命令执行和文件发现 RPC。`InputActions` 保留统一输入操作入口，组件不单独注入另一条内容初始化回调。

调用参数依次为 `startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions)`、`requestDraftInitialization(binding: SessionBinding, options: DraftInitializationOptions)`、`SessionInputShell.requestDraftInitialization(options)`，以及内部的 `SessionInputShell.setDraft(input: string | DraftSnapshot)`。`StartSessionOptions` 直接引用 `DraftInitializationOptions`，字段为 `prompt?: string` 和 `clearPreviousDraft?: boolean`；进入异步创建前浅拷贝这些值，结果只作用于最终保留的 binding。初始化结果区分已应用、保留原稿和提交期间拒绝；拒绝不先清空，导航被后续操作取消时不写稿。

### 数据流

```text
stored draft / startSession options
  → DraftInput
  → SessionInputShell.setDraft
  → DraftEditorRuntime → Lexical → InputState
  → InputHub.shellFor returns
  → React mounts the editor

user edits / input actions
  → editor → projection
  → DraftSnapshot
  → Conversation store
```

### 异步 skill 匹配

skill 是可编辑文字，不转为文件胶囊。词典尚未返回时不锁草稿；斜杠名称先保持普通文字，词典提供匹配名称后才高亮。提供方缺席、词典不可用或名称不匹配时不显示 skill 高亮。数据到达后通过现有订阅机制重匹配当前文档，而不是保存请求发出时的文字并回写。此过程不修改正文和结构化引用，不抢光标、不增加用户 Undo 步骤。命令仍只在用户提交时走既有校验和执行路径。

## 考虑过的替代方案

**挂载后调用 setDraft。** 首次模型读取与显示仍可能为空，清空还可能被稍后的旧稿恢复覆盖；初始化责任不能依赖 React effect 的先后顺序。

**只保存 clipboardText，再重新搜索引用。** 文字不足以表达引用的来源和展示字段；搜索候选也不等于恢复用户已经作出的选择。已有结构应直接恢复。

**等待所有远程词典再开放输入。** 文件引用已有数据，skill 高亮也不是编辑前提；让网络查询阻塞草稿会引入不必要的等待。

**拆分持久化 key 或新增草稿管理服务。** 现有输入 owner 和 store 已能承担职责，只需统一输入数据与导入路径。

## 验证

数据模型的核心约束是：有效草稿经过导入、导出和 JSON 往返后语义相等，运行时节点 ID 不参与比较；初次获取输入对象即具有完整文档；选区和 skill 高亮变化不改变草稿快照。[文档模型用例](../../../../packages/client/ui-conversation/tests/draft-document.client.spec.ts)覆盖字符串、空稿、多行与 Unicode、文件／目录／Session 引用、重复引用、无效标记、占位字符净化和非法存储跨度；[输入生命周期用例](../../../../packages/client/ui-conversation/tests/draft-hub.client.spec.ts)验证首次读取、复用、词典服务到达／卸载／重连和旧 binding 失效。提交中拒绝初始化，词典重匹配不增加 Undo 步骤。

[导航用例](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts)验证初始化作用于准确的保留对象、参数在异步创建前复制、导航取消不写稿、拒绝时保持原选择。[组合用例](../../../../packages/client/ui-conversation/tests/apply-inject.client.spec.tsx)验证现有工作区携带路径不把引用变成纯文本。相关回归共 44 个文件、708 项通过；共享草稿模块归位后，受影响的三个模型与组合文件再验证 66 项通过。

[浏览器 e2e](../../../../apps/web/tests/draft-initialization.e2e.ts)通过已有模块加载观测方式取得实际 Workspace API，调用公开 `startSession` 传入文本选项，不新增测试插件。结构化 fixture 经既有已存草稿路径恢复。用例覆盖缺省、空字符串和非空提示词，明确传入及沿用当前工作区，保留与清空、创建与复用、真实界面的 Session 多轮切换和编辑、刷新、旧字符串及工作区选择器携带。延迟创建响应的两种返回顺序都保持较新的目标选择，并且不改动另一份草稿。延迟返回的真实 skill 目录只重匹配当前文字，不替换胶囊、选区或 Undo 历史。断言检查胶囊字段、文件预览和持久化快照。未点击发送前，Host 日志没有 `user/message` 或 `turn/start`。

## 后果与边界

旧字符串草稿缺失的引用信息不能无损推断，按普通文字恢复；不为兼容旧数据自动查询并猜测文件。附件文件对象、上传状态、跨浏览器同步、多个独立编辑器和完整 Undo 持久化不在本次范围。

本决策与[编辑器隔离方案](../../proposed/architecture/2026-09-14-composer-model-and-draft-editor.zh.md)共享输入 owner 的归属，但不实现其多编辑器目标；[引用预览](../../../../packages/client/ui-input-trigger/README.zh.md)和[Session 引用生命周期](2026-09-15-client-session-references.zh.md)继续各自约束来源路由和代次清理，不被本次决策取代。
