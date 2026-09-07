# Agent Note: Web 输入区共享宽度轴与控制行打磨

Status: implemented
Archived: 2026-09-04

[English](2026-08-04-web-composer-shared-width-axis.md) | 中文

## 问题

Web 会话列的各个区域各自独立设定尺寸：transcript（文本记录）列、输入卡片、todo/goal/queue 停靠卡片、ask-question/approval/plan-review 接管卡片各自硬编码 max-width（736/752/776/800px 等变体）与各自的侧边内边距。这些区域在全宽下彼此漂移几个像素，在窄视口下偏差更大——有的面板保留了到屏幕边缘的间隙，有的却贴边。另外，输入卡片的控制行没有自适应行为——窄卡片下权限触发器的文字标签会挤压整行；锚定在卡片上的浮层菜单也可能渲染得比卡片更宽，越过其右边缘。

## 决策

一个内容宽度变量控制整列。`--dsh-chat-content-width`（748px）声明在 ConversationRoot 的 `.root` 上——transcript 与 composer 座位是兄弟子树，声明必须放在共同祖先上，CSS 自定义属性才能通过继承同时到达两者。其他几何全部由它推导：输入卡片上限为 `content + 32px`（`--dsh-composer-card-max-width`），停靠卡片从卡片宽度中减去四个停靠 inset（4 × 8px）正好回到内容宽度，接管卡片直接使用内容宽度。窄视口不变式以结构而非数值表达：内容宽度的区域每侧 pad `calc(var(--dsh-composer-side-clearance) + 16px)`，而输入卡片只留裸 clearance（16px），因此「输入卡片 = 内容 + 32px」在任意视口宽度下都成立，而不只是在上限处。

卡片内的控制行是一个 `container-type: inline-size` 容器，权限触发器在 460px 容器查询下收起文字标签（保留图标 + 下拉箭头）。查询刻意匿名：CSS modules 按模块哈希 `container-name`，InputBar 样式表里声明的名字永远无法匹配 PermissionSelect 样式表里写的查询——两个哈希后的名字悄然不同，查询永不触发。只有带模式图标的触发器才收起（`:has(.triggerIcon)`）；没有图标的宿主自定义模式保留文字作为其唯一标识。

锚定在卡片上的浮层菜单（slash 菜单、command popupSelect）钳制到锚点宽度（`max-width: min(<design cap>, 100%)`），过长的行以省略号截断而不是溢出卡片。Tooltip 气泡在钳制中保留 12px 的视口边缘安全距离（ui-primitives Tooltip）。

## 考虑过的替代方案

**保留各区域独立宽度，手工对齐数值。** 否决：本次改动消除的漂移正是手工对齐常量的残留；未来任何宽度调整都需要五处协同编辑，且没有任何机制强制这组关系。

**把变量声明在 `.composerStack` 上。** 尝试后否决：接管面板在 composer 座位中是 stack 的兄弟节点，transcript 更是完全不同的子树，变量根本到不了它们；共同祖先（`.root`）是唯一正确的家。

**用命名容器查询实现标签收起。** 经实测否决：CSS modules 按模块作用域化 `container-name`，跨模块名字永不匹配，查询是死的。匿名查询解析到最近的祖先容器，在这里没有歧义（该行是唯一的容器）。

**用 JS ResizeObserver 实现标签收起。** 否决：容器查询是声明式的，无需监听器生命周期，而 460px 阈值无论哪种方案都是设计选择。

## 后果

修改列宽现在是一行编辑，比例关系由构造保证——736 → 748 的重调已经验证了这一点。代价是间接性：五个区域的宽度不再能从各自的样式表直接读出，需要沿变量链追到 ConversationRoot。容器查询收起增加了一个约束：InputBar 的行必须保持为尺寸容器；删掉那条声明会静默禁用权限触发器的自适应行为。匿名查询也意味着未来若在行与触发器之间出现第二个容器，它会截获该查询——届时查询必须迁移，或避免中间容器。
