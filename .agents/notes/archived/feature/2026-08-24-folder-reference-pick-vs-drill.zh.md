# Agent Note: 文件夹引用 pick 即选定；下钻移交给显式 drill 动词

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-folder-reference-pick-vs-drill.md) | 中文

## 问题

`@` 菜单里的目录行用一个动词干两件事。pick 它会插入字面 `@dir/` 文本并保持菜单打开——那是抵达文件的下钻路径——于是想要文件夹*本身*作为上下文的用户永远得不到一个已选定的实体：token 保留触发字符、保持可编辑（继续输入 `123` 会继续筛选子项），与文件 pick 产出的原子 chip 完全不是一个物种。现场反馈附上竞品截图把期望说得很具体：选中的文件夹应当与选中的文件一样"定下来"。

## 决策

把两个意图拆成同一行上的两个动词，键位对齐 shell 补全直觉：

- **选定**（点击行主体 / Enter）：目录解析为原子 folder chip——与文件 chip 完全同语言：文件夹图标、`dir/` 标签、无触发字符、整体删除一个单位——序列化与剪贴板形式为规范 `@dir/` mention。实现上就是文件夹路径从未走过的 `{ insert }` 分支；`appearance: 'folder'` 端到端早已支持。
- **钻取**（Tab / 行尾 chevron）：原行为原样保留——字面可编辑的 `@dir/` 文本，菜单对子项保持打开。

管线上是一个新维度而非平行通路：`InputTriggerCandidate.drill?: boolean` 声明第二动词（只有 `ui-reference` 的目录行设置），`InputTriggerPick.action: 'pick' | 'drill'` 报告实际执行的是哪一个，`ArbitrateKey` 增加 `'tab'`，composer keymap 经与方向键相同的仲裁 helper 注册 `KEY_TAB_COMMAND`——`'consumed'` 才 preventDefault，其余情况原生焦点遍历不受影响。MenuView 只在 drill 行渲染 chevron（option 内的 `role="button"` span，与行同用 mousedown 保住 composer 焦点，`stopPropagation` 把行主体的选定 pick 挡在外面）。

## 曾考虑的替代方案

- **菜单关闭时选定**（菜单消失时把字面 `@dir/` 自动固化为 chip）：否决——可编辑 token 变实体的时机不可见且令人意外；手敲的 mention 保持诚实文本。
- **点击钻取、行内专用按钮选定**（反向映射）：否决——选定是常见意图，应占据主手势；下钻是进阶细化，与 Tab 匹配。
- **对字面文本 CSS 覆盖触发字符**而不引入实体：早先在文件夹图标修复中已因同一原因否决——Lexical 文本节点无法拆出触发字符，而且字面文本本来就不是已选定的实体。

## 后果

- pick 出的文件夹与文件是同一物种：原子、带图标标签、无 `@`、整体删除；手敲的 `@dir/` 仍是带图标前缀的纯文本引用。
- 忽略 `action` 的 `onPick` 实现行为与从前完全一致（既有路径全部报告 `'pick'`）；唯一的行为变化在 `ui-reference` 的目录分支。
- 只有菜单高亮在 drill 行时才拦截 Tab；其余场合浏览器保有该键，由 keymap-routing spec 钉住。
- 覆盖：controller 仲裁（drill / 普通行 / pick action）、MenuView chevron 路由、`ui-reference` 动词分流，以及在真实工作区目录上驱动全部三个手势（Enter 选定、Tab 钻取、chevron 钻取）的真浏览器 e2e。
