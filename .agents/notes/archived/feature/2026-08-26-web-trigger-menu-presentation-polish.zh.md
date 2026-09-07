# Agent Note: Web 触发菜单呈现打磨

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-web-trigger-menu-presentation-polish.md) | 中文

## Problem

Web composer 的 `/` 与 `@` 触发菜单存在多处呈现缺陷，使引用流程更难阅读和操作。候选行用本地化文字前缀标注类型（`Folder · name/`、`Session · label`），既与 section 标题重复又把名称挤向右侧。指针悬停用 CSS `:hover` 着色，而键盘导航驱动 reducer 持有的高亮，两行可能同时呈现焦点态。可下钻文件夹的操作标记是裸文本 `›`，与 composer 中其他 chevron 不一致，且没有任何提示告诉用户 Tab 可以下钻高亮的文件夹。来源加载中状态是一行"正在加载…"文字。下钻留下的可编辑 `@dir/` 文本在 `@` 前渲染文件夹图标，对一个并非 settled chip 的 token 形成视觉双重标记。composer 的 placeholder 从未提及 `/` 和 `@` 的存在（[#3080](https://github.com/deepseek-harness/deepseek-harness/issues/3080)）。

## Decision

候选行以领域图标开头，不再用文字前缀：`InputTriggerCandidate.icon` 从 `string` 收窄为封闭联合 `InputTriggerCandidateIcon`（`file | folder | session`），菜单视图将其映射到 `ReferenceIcon`，`ui-reference` 只输出裸名称（`folderx/`、session 标签）。删除 `candidate.file`/`candidate.folder`/`candidate.session` 三个 locale 键；session section 标题改为 `对话`/`Sessions`。菜单与 composer 卡片左右等宽（`left: 0; right: 0`），加载中的来源渲染两条与候选行同尺寸的呼吸骨架条，替代加载文字行。

指针与键盘共享单一高亮，后到者优先：新增 `hover` MenuEvent 把 reducer 持有的高亮停在某个就绪行上，`MenuView` 从 `onMouseMove` 路由（不用 `mouseenter`，避免键盘滚动把新行送到静止指针下时抢回高亮），CSS `:hover` 着色整体移除。

高亮文件夹行上的下钻标记改为库内 `IconChevronRightOutline14`，使用访问模式 chevron 同款的弱色 `--dsw-alias-label-caption`，左侧为本地化"进入目录"文字加 `Tab` 键帽提示，仅当该行持有共享高亮时显示。

仍带触发符的 token 是可编辑文本而非 settled chip：text-ref 装饰只做染色，领域图标专属于 settled 的 `ReferenceChipNode`。原有的 appearance 通道（扫描的 `appearance` 字段、`TextRefNode.__appearance`、`data-ref-appearance` DOM 属性、CSS `::before` 图标）端到端删除。

composer placeholder 同时提示两个触发符（`描述你想要构建的内容… / 调用指令 @ 文件或对话` / `Describe what you want to build... / commands, @ files or sessions`），并将 `ui-chat`、`ui-conversation`、`ui-goal`、`ui-input-trigger` 中命令的中文文案统一为"指令"。

## Alternatives considered

**保留 CSS `:hover` 着色与键盘高亮并存。** 被否：两行可能同时呈现焦点态，而 `aria-activedescendant` 只指向一行；Enter 作用于键盘行，视线却可能停在悬停行上。

**从 `mouseenter` 路由悬停。** 被否：方向键把新行滚动到静止指针下方时，每个进入指针的行都会重新触发 `mouseenter`，抢走用户刚移走的高亮；`mousemove` 只在指针真实移动时触发。

**保留可编辑 `@dir/` 文本上的文件夹图标。** 被否：触发符前的图标对 token 形成双重标记，抹掉了"仍可编辑的文本"与"settled chip"之间的视觉区分；图标专属于 chip 才能让两种状态一眼可辨。

**在所有可下钻行上常驻 Tab 提示。** 被否：空闲行常驻键帽增加噪音；提示恰好在其生效时出现——该行正是 Tab 将作用的行。

## Consequences

过去每行用文字拼写的类型信息现在由图标和 section 标题承载；未来新增候选类型必须扩展 `InputTriggerCandidateIcon` 并选定图标，而非传任意字符串。指针移动经 reducer 往返（`hover` 对已高亮行是 no-op，mousemove 风暴不会搅动状态）。下钻的可发现性依赖高亮：空闲文件夹行在被悬停或键盘到达前只显示 chevron。延后的跟进项——精确匹配 token 的空格 settle、`name` 与 `name/` 标签——仍记录在 [#3154](https://github.com/deepseek-harness/deepseek-harness/issues/3154)；候选 description 内容、下钻后的回退导航与引用搜索延迟由 [@ mention 发现与行内容笔记](2026-08-27-web-at-mention-discovery-and-row-content.zh.md) 结清。
