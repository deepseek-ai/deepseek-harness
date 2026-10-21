# Agent Note: 已认领命令作为输入框原子 chip

Status: implemented

[English](2026-10-09-composer-command-chip.md) | 中文

## 问题

[Lexical 输入框决策](../../archived/architecture/2026-08-20-web-composer-lexical-editor.md)把已认领命令保留为行首字面文本。一个 TextNode transform 给 token 加样式，并把输入进去的溢出文字拆出来；提交状态机在草稿字符串以 token 开头时保持认领。token 交界处的每次编辑都会经过这个 transform。Lexical 会在溢出节点自身的 transform 执行前合并样式相同的相邻节点，于是拆分与合并循环往复，直到 Lexical 以错误码 14 中止这次更新，DOM 与编辑器状态随之分叉（issue #4490）。PR #5480 针对报告的手势清除了被复制的样式；认领后粘贴图片和 IME 组字会进入同一个 transform，仍未验证。纯文本引用实体也需要一条优先级规则来避开已认领的 token。

## 决策

认领把行首触发区间替换为 `CommandChipNode`（一个原子 inline `DecoratorNode`），其后是作为普通文本节点的 token 参数分隔符。

- 节点携带 `CommandClaim`，包括其 submit 闭包。历史记录恢复节点时连同字段一起恢复，因此撤销 chip 删除会恢复认领。JSON 导出写入 token 文本；闭包没有 JSON 形式，因此 JSON 导入得到纯文本节点。
- 检测投影把 chip 计为一个 U+FFFC，触发检测不会再读到命令名。剪贴板投影是不含分隔符的 token。chip 不是引用 occurrence。`EditorProjection.command` 是位于文档开头的 chip 所携带的认领。
- 在提交事务之外，状态机的认领跟随文档：`draft-changed` 携带行首 chip 的认领，因此删除或挤开 chip 会释放认领，历史恢复会重新进入 claimed。命令提交失败后按同一规则结算，只要行首仍有 chip 就回到 claimed；Enter 时从输入文本裁决出的认领没有 chip，回到 plain。
- 节点 transform 让 chip 保持在行首位置。前面有兄弟节点或位于后续块中的 chip 会变回字面 token，并像在旧 token 前输入那样释放认领。chip 自身的 transform 覆盖兄弟节点插入和跨块移动；段落 transform 覆盖在 chip 所在块之前插入块的情况，因此没有任何更新需要遍历整个文档。
- 删除分两步。从折叠光标出发、方向触及 chip 的字符删除先把它标记为选中（宿主元素上的 `data-selected`；根元素的 `data-composer-chip-selected` 隐藏光标），同方向的下一次删除才整体移除它。字符删除命令和删除类输入事件都会参与判断，因为 iOS 处理带范围的 `deleteContentBackward` 时不经过该命令。分发过程中没有产生字符删除的按键、点击、失焦或光标离开 chip 会清除标记，因此 macOS Ctrl+H 这类平台删除快捷键会保留它。编辑器选区保持为折叠的 range，`isKeyboardSelectable()` 仍为 false，原因与引用 chip 记录的相同。Escape 仍不释放认领。
- 持久化的草稿记录行首 chip 的认领 token（`DraftSnapshot.command`），从不保存认领本身。恢复时输入框调用触发管线的 `resolveClaim`，它轮询可选的 source 钩子 `matchClaim`：等待 source 的目录就绪，只应答认领，与 Enter 的 `matchEnter` 不同，从不调用或执行命令。chip 只在恢复产生的那个版本上重建，并合入种子的历史条目；在此之前发生的编辑、无人认领的 token 或目录加载失败都会保留字面 token，Enter 仍会对其裁决。
- 删除 `claim-decor.ts` 和文本引用的优先级规则。

`slash/input-*` 事件、`CommandClaim`、`InputState.claim` 与触发源的字段保持不变。`CommandClaim.token` 仍以分隔符结尾，命令参数仍从其后的剪贴板文本读取。

## 考虑过的替代方案

**保留字面文本并逐个修复手势。** 如 #5480 所示，每个触及交界节点的手势都需要单独证明，与文本引用之间的优先级规则也仍然存在。

**复用 `ReferenceChipNode`。** 引用 chip 是在提交时经 owner codec 序列化的 occurrence；命令不是模型内容，不能进入 `occurrences`。

**把分隔符放进 chip 文本。** inline decorator 位于块末尾时，Lexical 会在其后追加受管换行，由 `p:last-child::after` 渲染的空参数提示会移到下一行。独立的文本节点让提示留在 chip 所在行。

**用 NodeSelection 选中 chip。** 纯文本绑定的方向键、输入和删除处理器都会忽略非 range 选区，这些手势在 chip 处都需要单独处理。

**在 shell 中用按 NodeKey 索引的表保存认领。** 该表重复了节点已携带的字段，并且每次清空历史时都需要修剪。

## 影响

- Backspace 不再逐字编辑命令名并重新打开菜单。在 chip 边缘按两次 Backspace 或 Delete 会删除 chip，参数保留为普通文字。
- 刷新后，命令目录加载完成即恢复 chip；在此之前以及恢复不适用时，草稿显示字面 token。
- 通过真实按键整体删除 chip 只能在浏览器 lane 中观察，因为 jsdom 缺少 `Selection.modify`；`lifecycle-chrome.e2e.ts` 固定了删除分隔符、选中、删除这三次按键。
