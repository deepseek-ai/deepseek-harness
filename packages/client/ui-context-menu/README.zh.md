---
description: "无需导入 React 组件即可向右键菜单添加操作"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-context-menu

[English](README.md) | 中文

## 概述

无需导入 React 组件即可向右键菜单添加操作。即使选中项变化，目标仍保留被点击的会话、工作区、文件、文件夹、链接、图片或窗格。贡献项可以异步查询元数据，并在插件卸载时安全移除。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 应用 bundle 挂载此客户端插件。外部客户端插件在 `dsh.client.inject` 声明本包，导入 `/client` 类型，并注入 `contextMenus` 服务。`resolutionTimeoutMs` 限制每个提供方的准备时长（默认 1000ms）；超时后取消并忽略该提供方，显示失败提示。

插件通过 `ctx.slots.provideRoot` 向每个 Slot 作用域注入 `useContextMenu`。组件调用一次 `const { getTriggerProps } = useContextMenu()`，再将 `getTriggerProps(target, handlers?)` 展开到各个触发元素上。该工厂是普通函数，可以在循环中调用；它统一处理右键、Shift+F10、ContextMenu 键、视口坐标及无滚动聚焦。已有处理器先运行，`preventDefault()` 保留其处理权，并防止组合或嵌套绑定重复处理。重复、输入法组合及无关按键保持原状。传入 `undefined` 保留原生行为，也可传入目标解析函数，在手势开始时读取业务状态。解析后的对象会在焦点变化前捕获。普通子组件通过 props 或现有 delegate 接收事件 props 或工厂，无需额外 React Context。特殊编辑器和 Canvas 可直接调用 `ctx.contextMenus.open()`。

### 注册操作

在贡献插件中调用 `ctx.effect(() => ctx.contextMenus.register({ id, target, order, resolve }))`。`resolve` 接收捕获的目标和取消信号；返回本地化操作，包含稳定 ID、可选图标、禁用状态、子菜单和执行回调。贡献项先按 `order`、再按 ID 排序。同类目标的贡献 ID 重复会导致注册失败；操作路径重复会拒绝该提供方的结果。发布前会逐段编码 ID。

动作可通过可选 `commandId` 关联已有快捷键命令。浮层订阅 `ctx.shortcuts.catalog`，跟随已配置、移除和重置的绑定更新；子菜单和底部动作采用相同展示。此关联不会调度命令：选择菜单项只调用该动作捕获的 `run` 回调。菜单插件依赖 `shortcuts` 服务。

贡献可通过 `observe(target)` 声明权限、成员状态或本地化标签的数据源。数据源更新时，针对同一捕获目标重新解析该贡献并替换回调；过期的异步准备会被取消。关闭菜单和卸载插件都会释放所有订阅。

通过对 `@deepseek-ai/dsh-client-ui-context-menu/client` 的声明合并扩展 `ContextMenuTargetMap`，即可增加目标类别；`ContextMenuTarget` 从该映射派生 `{ kind, value }` 联合类型。通过 `ctx.contextMenus.open(target, { x, y })` 打开目标。目标值使用不可变、可 JSON 序列化的标识与元数据。执行回调捕获该值，并在操作前重新检查可变资源。新注册项在下次打开时生效。注销会移除可见操作并取消待处理的元数据查询。

`ctx.contextMenus.resolve(target)` 为其他渲染器提供独立菜单实例。订阅不可变操作视图，选择已发布的 ID，并在所属界面关闭时释放。视图仅包含展示字段。回调保留在注册表中，最多执行一次。关闭和替换菜单会取消元数据查询，已选中操作则自行管理执行与取消。提供方或操作拒绝时由持久的覆盖层提示；操作的本地化 `failureLabel` 提供具体的恢复建议。

`ctx.contextMenus.notify(text, success, action?)` 可通过共享 Toast 附加本地化文字操作。操作提供 `label`、`run` 和 `failureLabel`；点击后先关闭提示再执行，失败时显示对应文案。已关闭或被替换的提示不能再次执行其操作。

共享弹窗等待全部贡献项完成或超时后才显示。同一目标在四个 CSS 像素以内重复触发会关闭菜单；更远的触发以独立淡入淡出替换菜单。`ready` 向自定义渲染器提供同一个准备完成时点。结构化操作的图标按分隔线组对齐；组件贡献保留自己的布局。普通关闭保留弹窗 80ms，替换保留 10ms；打开至少等待 20ms，再用 40ms 淡入。减少动态效果偏好会禁用淡入淡出。

操作携带 `icon?: { key: string; src?: string }`。通过 `ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: 'my-plugin.action' }, Icon))` 注册匹配的图标组件。覆盖层对普通项、子菜单和底部操作都按该 key 调用 `renderSlot`；组件接收已捕获的 `icon` 元数据，包括可选图片 URL。注册随贡献插件和菜单 Slot 声明的生命周期清理。操作视图不包含 JSX 节点。

可选的 keyed Slot `contextMenu.content` 承载组件贡献。现有会话和标签菜单 Slot 名称仍由各自功能适配器维护。键盘菜单键和 Shift+F10 使用焦点触发元素的下边缘定位。`afterContent` 将数据操作放在这些行之后；普通操作排在之前。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

注册表将查询和回调生命周期与展示分离。共享覆盖层复用现有 Menu 原语，处理键盘移动、焦点返回、关闭、子菜单和视口定位。[注册表](src/client/registry.ts) 管理取消与排序；[目标和操作类型](src/client/types.ts) 定义公开字段。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Slots](../ui-slots/README.zh.md) — 组件贡献。
- [文件操作](../ui-file-actions/README.zh.md) — 原始内容传输。
- [本地打开](../ui-open-in-app/README.zh.md) — 内置资源操作。

-----

<a id="model-experience"></a>
## 模型体验

无，因为弹出菜单展示与注册不会构造模型输入。

#### KV 缓存影响

无；贡献操作所属功能负责后续可能产生的模型交互。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 内置渲染器是共享 Web Menu，Desktop 也使用它；未提供原生菜单渲染器。
- 仅有组件形式的旧操作不会出现在纯数据查询 API 中。
- 菜单是窗口内的临时状态，不持久化到会话数据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
