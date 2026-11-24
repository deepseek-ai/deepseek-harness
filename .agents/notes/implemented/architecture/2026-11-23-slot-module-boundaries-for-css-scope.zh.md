# Agent Note: 让 slot 样式只匹配提供内容的包

Status: implemented

[English](2026-11-23-slot-module-boundaries-for-css-scope.md) | 中文

## 问题

包 A 使用包 B 注册的 `Tree` 组件工厂（Factory），并为 `tail` 提供一个按钮。A 的按钮样式不能影响 B 自己的树，但在树内仍要能匹配 A 提供的按钮。包 C 也可以为同一个 `Tree:tail` 提供按钮。两次调用的位置相同，提供内容的包却不同。

## 决策

客户端样式表默认全局生效。要为某个动态加载的客户端插件测试隔离，无论内置还是外部插件，操作者都可以在 `cordis.yml` 中该插件的 [Loader 配置项](../../../../packages/client/modules/README.zh.md#script-isolated-packages)上设置 `__unstable_enable_client_isolation`。`style` 和 `scriptandstyle` 只限制该包自己的编译样式表，不影响依赖包的样式表；`script` 只选择 JavaScript Realm。

每个模块记录携带所属包加载时的隔离声明。[样式安装器](../../../../packages/client/ui-renderer/src/client/styles/document-styles.ts)按记录选择是否包装 CSS。[已有的 Slot 根元素](../../../../docs/subsystems/slots.zh.md#slot-style-ownership)只用 `data-plugin` 标明实际供应包，而非显示名称或 CSS 设置。未知提供方或框架错误使用空包名；共享列表出口不标包名。

安装器将选中包的每张样式表放进原生 `@scope`，并把包名按 CSS 字符串处理。例如，`pkg-a` 的按钮样式安装后是：

```css
@scope ([data-plugin="pkg-a"]) to ([data-plugin]:not([data-plugin="pkg-a"])) {
  .probe { padding-left: 11px; }
}
```

作用域不包含终点元素及其下方的内容。A 里面另一个带标记的 A 根**不是**终点：以外层 `:scope` 为起点的选择器仍可匹配它。换成 B 的根（无论 B 是否开启隔离）或提供方未知的根，这条路径就被截断。B 里面如果还有一个 A 根，A 的样式可从那里重新生效，但以最外层 A 为起点的选择器不会越过 B。要选中作用域根本身，使用 `:scope`。

未开启隔离的样式表仍按原文安装，因此未隔离的公共主题能匹配所有包的内容。包名标记不区分哪些包开启了隔离。

### Factory 中的 A → B → A

假设 A 是 `single` 类型的 `panel` 当前选中的包，并在这里调用 B 的 `Tree`。Factory 本体使用块级根，局部位置 `tail` 单独声明了 `inline: true`。无论这两个包是否开启隔离，实际结构均如下（省略 `display: contents`）：

```html
<div data-slot="panel" data-plugin="pkg-a">
  <button class="probe">A1</button>
  <div data-slot-factory="Tree" data-plugin="pkg-b">
    <button class="probe">B</button>
    <span data-slot-factory-children="Tree:tail" data-plugin="pkg-a"><button class="probe">A2</button></span>
  </div>
</div>
```

A 的规则匹配 A1 和 A2，不匹配 B 的按钮。即使 B 没有开启隔离，它的根仍然会截断 A。如果改由 C 选择 `tail` 组件，局部根仍叫 `Tree:tail`，但标记的包名变成 C。默认局部组件没有单独的根，仍在 B 的范围内。已注册的 Factory 或已挂载的替换组件返回 `null` 时会保留空根；只绑定替换组件而不挂载，不会产生根。移除定义时 Factory 根也会移除，这与普通 slot 在声明移除后仍可保留空出口不同。

谁有权渲染子 slot，和谁在这次调用中提供内容，是两件事。如果 A 选中的局部组件用 `renderSlot` 渲染 B 的 Factory 所声明的子 slot，渲染器仍按 B 的声明检查权限，但 A 传入的 `children` 或后备内容属于 A。[组件工厂](2026-09-10-component-factories-and-local-slots.zh.md)定义了声明与选择规则。

### HOC 转发 `children` 的两种情况

在高阶组件（`hoc`）类型的 slot 中，包在 `{children}` 外面的出口标记**里面这份内容**的提供方，而不是写下 `{children}` 的那一层。

**同一 slot 有两层。** A 把“保存”按钮传给 `frame`。B 包裹 C，C 再包裹 A 的按钮；B 和 C 各自在渲染 `children` 前添加一个按钮。两个 `children` 出口都叫 `frame`，里面所属的包却不相同：

```text
[data-slot="frame"][data-plugin="pkg-b"]
├─ button#b-extra
└─ [data-slot-children="frame"][data-plugin="pkg-c"]
   ├─ button#c-extra
   └─ [data-slot-children="frame"][data-plugin="pkg-a"]
      └─ button#save
```

**两个 slot 各有一层。** 这里 `outer.frame` 只有 B 一层，所以 B 收到的 `children` 是 A 的“保存”按钮。B 添加自己的“更多”按钮，把两者一起传给 `inner.frame`；后者只有 C 一层，原样返回这份内容：

```text
[data-slot="outer.frame"][data-plugin="pkg-b"]
└─ [data-slot="inner.frame"][data-plugin="pkg-c"]
   └─ [data-slot-children="inner.frame"][data-plugin="pkg-b"]
      ├─ [data-slot-children="outer.frame"][data-plugin="pkg-a"]
      │  └─ button#save
      └─ button#more
```

C 返回的是 B 组装的这组内容。“更多”留在 B 的范围内；“保存”仍在里面那个属于 A 的原出口中。多次调用可以共用一条编译好的层链，但末端的包名取自每次调用，不能固定为第一个调用方。某层舍弃 `children` 就没有对应出口；转发空内容则保留空出口。层崩溃时回退到原本带有标记的内层内容。[HOC 层](../../../../docs/subsystems/slots.zh.md#hoc-layers)原有的错误处理和重新挂载规则仍然适用。

### 混合不同包的列表

假设在 A 的根内，未开启隔离的 P 和开启隔离的 A 各为 `tools` 提供一个选中的列表项。P 的 `[data-slot-item][data-plugin="pkg-p"]` 只在 P 这一支截断 A。共享的 `[data-slot="tools"]` 没有模块属性，因此从外层 A 开始的规则仍可匹配 A 的列表项。即使只有一个选中项，例如指定 `{ only: 'actions' }`，标记位置也不变。组件返回文本、Fragment 或空内容时，与返回按钮一样，也各有自己的列表项。

只要同一注册项仍被选中，重排兄弟行或在全列表与 `only` 之间切换都不会重新挂载该行及其控件。过滤掉这行或更换胜出的注册项则结束这次挂载。没有匹配的 `id` 时，调用方的后备内容直接放在出口内，出口标记调用方。如果匹配的 `id` 下所有注册都已失败，出口下的直接子元素是框架的错误占位，而非后备内容。[列表项根元素](../../../../docs/subsystems/slots.zh.md#list-item-roots)说明了所用标签及各类空内容的区别。

## 考虑过的替代方案

**从 slot 名或最近的出口推断包名。** `Tree:tail` 对 A 和 C 表示同一位置；转发后的两个按钮最近的出口也可以同为 `inner.frame`，但它们属于不同包。同一次选择的结果同时决定内容和标记，不靠查询位置名或额外运行一次 `chain` 选择器推断提供方。

**添加包装元素，或要求组件透传属性。** 在需要标记的位置，渲染器已经有可以使用的元素；列表项也能容纳文本、Fragment 和 `null`。再包一层会改变直接子元素和兄弟选择器的匹配关系，而只返回文本的组件根本没有自己的元素可以标记。

**标记有行的列表出口，而不标列表项。** 一个包名无法代表多个提供方。即使只在出口加一个空的 `data-plugin`，也会截断外层 A 通向 P 旁边 A 那一行的路径。两种列表模式都标在同一行，既不更换其 DOM 祖先，也不重置局部状态。

**用 Shadow DOM 做双向隔离。** 这会改变宿主主题和公共样式作用于插件内容的方式。这里需要限制的是某个包的选择器可以匹配哪里，不是单独的文档或安全边界。

## 影响

只需检查选中包自己的选择器。例如，若该包的深色样式依赖作用域外的 `body`，可改用继承下来的主题变量，或将相关状态放在包自己的内容上。宿主开启隔离后，再长的选择器也不能跨到另一包的列表项；由宿主控制的布局应放在宿主自己的元素上，或使用双方约定的公共规则。为一个内置包开启隔离，不要求同时改动其他内置包或全局主题。

`@scope` 不阻断属性继承（包括字体、颜色和自定义属性），不隔离资源名，也不改变 JavaScript 的执行方式。层叠中其他条件相当时，作用域根的远近可能决定哪条规则胜出。Portal 依实际挂载位置的 DOM 匹配样式：挂载到无标记 `body` 时，不会从 React 父级带过去 A 的作用域。在 props 中任意搬运 JSX、直接导入普通组件，也都不会自动标明内容来自哪个包。

样式遵循[模块的生命周期与依赖顺序](2026-11-05-client-module-metadata.zh.md)，而非组件的挂载周期。已加载的入口及其后续分片保留自己的声明；换入的包按当时的图注册。新的 Slot 注册只声明供应包。若宿主文档无法按原生 `@scope` 解析样式表，安装器会报告并跳过该表，不会退回全局安装。

## 验证

**构建后的 Web 应用。** [Chromium 集成测试](../../../../apps/web/tests/client-style-scope.e2e.ts)比较 A → B → A 三处元素的非继承属性。全局表为三处增加 7px 内边距；B 的隔离表使左外边距依次为 0、23、0px。Host 改为全局设置时，已加载包保留原表和按钮状态，随后加载的分片也沿用该包的设置。重新打开页面或重建包后，替换记录生成全局样式。

**渲染器与安装器回归。** [DOM 归属测试](../../../../packages/client/ui-renderer/tests/module-anchors.client.spec.tsx)检查切换 `only` 后保留列表控件、HOC 转发和崩溃回退、同一 Factory 局部组件的不同调用方，以及错误元素不带包名。[样式表测试](../../../../packages/client/ui-renderer/tests/module-styles.client.spec.ts)覆盖生成函数缓存、依赖包的全局样式、同一路径上的样式冲突，以及无法隔离的样式表。

这些检查不代表所有浏览器的行为、样式重算成本或每个包的宿主布局都已验证。给某个宿主包开启隔离时，测量控件本身，而不是没有布局盒的[列表项](../../../../docs/upgrade-guide/v0.2.3-alpha.2/list-item-roots/guide.zh.md)：例如，[会话面板的指示点](../../../../packages/client/ui-session-panel/src/client/SessionPanelToggle.module.css)应为 6px，[设置列表最后一条分隔线](../../../../packages/client/ui-settings-general/src/client/GeneralSection.module.css)的位置取决于哪些行实际有内容，[文件栏的空操作行](../../../../packages/client/ui-sidebar-files/src/client/FilesBody.module.css)也不应留出多余间距。
