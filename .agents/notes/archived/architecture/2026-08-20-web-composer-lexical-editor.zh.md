# Agent Note: Web 输入框改为 Lexical 编辑器（chip 为原子节点）

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-web-composer-lexical-editor.md) | 中文

> 范围：输入框文本表面（ui-conversation input/editor）、InputMachine 瘦身后余下的 SubmitMachine，以及喂给原封不动的 ui-input-trigger 管线的投影契约。取代[输入状态机 note](2026-07-25-web-input-machine-and-slash-pipeline.zh.md) 中 draft/occurrence 的那一半；其提交面、slot 与 trigger 管线部分仍然有效。

## 问题

textarea 输入框用三个耦合层绘制文本（隐藏自增高 mirror、装饰 backdrop、文字透明的 textarea），且草稿存在两份（textarea 字符串与状态机的 occurrence 表）。两处耦合各自产生结构性 bug：occurrence 对齐依赖字符串 diff 猜测编辑位置，贪心扫描滑进引用内部会在序列化守卫运行前把它静默降级（#2813）；扫描推导的装饰没有身份，在其前方打字每一击都重建它的 DOM（#2793）。层叠戏法还对每种 chip 样式征税——任何改变字形 advance 的样式都不可用，于是没有背景、内边距、圆角，也无法截断标签。

## 决策

每个会话壳持有一个 Lexical 编辑器，取代三层结构与状态机的草稿半边。

- **所有权**：`SessionInputShell` 在 React 之外创建编辑器（`createEditor` + `registerPlainText` + `registerHistory`）并持有它到会话结束；React 侧把常驻 contenteditable 绑上去（`ComposerContentEditable`，约 40 行）并 portal 渲染 decorator（`DecoratorPortals`）。刻意不用 `@lexical/react`：其 composer 在 React 内部创建编辑器，与 per-session 壳所有权冲突，还会拖入用不到的依赖树。
- **chip 是原子 `DecoratorNode`**（`ReferenceChipNode`），携带所有者插入时的投影。NodeKey 即 occurrence 身份；`getTextContent()` 回答剪贴板投影，因此原生复制/剪切与草稿镜像不再需要展开代码。
- **一棵树，三个投影**：检测投影（chip = 1 个 U+FFFC）供 `detectTrigger` 与 TokenSpan 坐标使用，恢复了 #2769 打破的不透明引用不变量；剪贴板投影（chip = clipboardText）供 `InputState.draft`、持久化与提交面决策使用；模型形式在提交时逐 chip 经所有者 codec 产出。`span-map.ts` 是数字 span 映射回 Lexical point 的唯一场所。
- **状态机瘦身为提交面**（phase/claim/attempt）；它不再持有草稿——事件携带剪贴板投影（`enter`、`submit-settled`），claimed 完整性监视跑在 `draft-changed` 上。清空草稿变成 shell 在编辑器里执行的 `commit-draft` 效果（含后缀保留），随后 `CLEAR_HISTORY_COMMAND`。
- **契约稳定**：`TokenSpan {start, end, draftRev}`、`ReferenceInsert`、`CommandClaim`、四个 `slash/input-*` bail 事件、所有 trigger source、controller 与 MenuView 一律未改。`draftRev` 现在是编辑器 update 计数。
- **claim token 保持字面文本**，前缀叶子由 transform 上色（退格删 token 仍是退出手势）；纯文本引用走 `registerLexicalTextEntity`（`TextRefNode`）；ghost hint 是 CSS 变量 `--dsh-composer-hint` 生成内容。

## 随重构退役

mirror/backdrop 层及其 CSS 耦合规则；Safari 软换行修复（2026-08-13 note 的 workaround——表面已无可与之分歧的 mirror）；mirror-Range 光标测量；状态机的 undo 环与打字合并时钟（Lexical history，保留 1000ms 合并窗口）；手写的边界 Backspace/Delete 整段删除（原子节点原生）；手写复制/剪切展开；`EditRange`/`diffEdit`/`reconcile`。粘贴尝试面（`paste-begin` components、`paste-upgrade`、`invalidate-paste`）与 `set-invalid` 事件**全仓没有任何生产者**，直接删除而非移植；`Occurrence.invalid` 保留在节点与投影上，待未来出现生产者。

## 刻意的行为变化

- 已认领命令的 args 现以剪贴板形式到达 source（引用为规范文本而非展示标签）——可解析的那种形式。
- `InputState.draft` 是剪贴板投影（原为展示文本）。跨包读方只消费 phase/queue 级字段；occurrence 表的外部读方为零。
- chip 删除遵循引擎的原生 decorator 手势；jsdom 缺 `Selection.modify`，键盘路径只在浏览器 lane 断言。
- 文件夹纯文本引用在完整字面 token 前渲染文件夹图标前缀（气泡同款资产的 currentcolor mask）；旧 backdrop 是覆盖绘制 trigger 字符，而 Lexical 文本节点无法表达这种覆盖。
- 输入框的可访问名称改为显式 `aria-label` 镜像 placeholder（div 的 `data-placeholder` 不像 textarea 的 placeholder 那样参与命名）——由 reference-composer 的 aria golden 逮出。
- 纯光标 commit 不发布任何东西：shell 只在投影内容变化时推进 `draftRev` 并重发布 `InputState`。光标移动仍然喂给菜单 tracking，但既不会使快照构造的 CAS span 失效（apply.ts 用已发布的 `draftRev` 构造 span），也不会触发订阅者重渲染。第一版每次 commit 都重发布；review 逮出了与旧机器「仅文本推进版本号」语义的漂移。
- 粘贴是独立的 undo 边界：自定义 PASTE_COMMAND handler 在 `@lexical/plain-text` 有机会打 tag 之前就消费了事件，因此 shell 自己补上 `PASTE_TAG`（经 `$addUpdateTag`——dispatch 路径必然嵌套在命令 update 内部执行）。没有它，history 会把粘贴与 1 秒窗内的输入合并，一次 undo 同时撤销两者。
- claim 装饰对行首 token 席位的优先级高于 text-ref 实体：被 claim 的命令名即使同时在触发 lexicon 上，也保持为普通的警告色 TextNode——因为 Lexical transform 按具体节点类注册，实体捕获会无声吃掉 claim 颜色（加守卫前经探针证实：实体节点胜出、样式丢失）。

## 曾考虑的替代方案

- **给 textarea 打补丁**（记录 beforeinput 时的 selection 收窄 diff，即 #2813 提议的修法）：缩小猜测窗口但保留双事实源与样式税；未来每个装饰都要再交一次。
- **自研 contenteditable 薄层**：被「依赖优先于手搓」政策否决——IME、selection 与引擎怪癖正是 Lexical 已经解决的本职。
- **彻底删除状态机**（编辑器状态为唯一状态机）：提交面（attempt CAS、防倒灌、abort）与文本表示无关且久经考验；重写只买来风险。
- **`@lexical/react`**：其 composer 在 React 内创建编辑器，与 per-session 壳所有权冲突，还拉入用不到的依赖树；它能替代的两个绑定总共约 80 行。

## 后果

- #2813 与 #2793 在结构上不可表达：不存在编辑位置推断，chip DOM 身份随 NodeKey。
- chip 是真实 DOM（图标、胶囊、`max-width` 截断、失效删除线）并进入可访问性树；旧 backdrop 是 `aria-hidden` 的。
- 编辑器及其历史随壳跨会话切换存活；单元测试无头驱动文档，真实键盘手势（删 chip、IME）归浏览器 lane。
- ui-conversation 的 client bundle 携带 lexical（gzip 约 +70KB）；无其他包 import Lexical 值，故无模块表行。
- 提交面、trigger 管线与 slash/input-* 契约对每个 source 插件字节兼容。

## 坑

- 在同一编辑器的 update 内再调 `editor.update` 会**推迟**其 fn（command handler 同步落到这里）；嵌套 discrete 直接抛错。`applyEdit` 在 `editor._updating` 时直接执行 `$` 函数体（command handler 内合法——Lexical 自己对 setEditable 用同款分叉），顶层则 discrete。经包裹嵌套 update 计算的 bail 答案读到的是旧状态。
- Lexical 的组合键/空格检测读 `event.keyCode`（undo `z`=90、空格=32）；合成事件测试必须设置它。
- 历史恢复（`UNDO_COMMAND`）在下一次 flush 才提交，不在 dispatch 内同步生效。
- client bundle 需钉住 `production`/`development` exports 条件（tsdown preset 的 `inputOptions.resolve.conditionNames`）：lexical 的 `node` 条件文件用顶层 await 选择口味，CJS bundle 载不动。
- `registerHistory` 的合并延时在调用时捕获 `Date.now`；fake-timer 测试要么在 shell 构造前装好 mock，要么推进越过窗口。
- chip 的 `isKeyboardSelectable()` 必须为 **false**。取默认值 `true` 时，方向键落在 chip 边缘会创建 NodeSelection，其 DOM 投影坍塌为 element point，而 plain-text binding 的方向键/删除/插入 handler 全都对非 Range selection 直接放弃——方向键、打字与退格在 chip 边死锁，直到鼠标点击才能解除。false 恢复占位符语义：方向键一步跨过，Backspace/Delete 整颗删除（浏览器 lane e2e 钉住该手势；只有真实按键事件能复现——CDP 裸 keydown 不携带引擎默认行为）。
