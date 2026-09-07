# Agent Note: Client Settings、Locale 与 Theme 分层

Status: rejected — closed as a proposal: the shipped ui-settings, locale, and ui-theme packages and their READMEs own the design

[English](2026-07-25-client-settings-locale-theme.md) | 中文

## 问题

浏览器端已有的 Settings 直接写在 Sidebar 内，语言和主题也由组件本地状态直接改 DOM。这使 Settings 无法由独立插件扩展，偏好状态没有稳定的跨插件服务约定，主题注册表同时承担状态与呈现职责。

## 提案

**协作导向（后续所有模块接入 Settings 的方式）：功能属主自注册。** Settings 壳是纯组合面：只声明 slot、渲染 chrome 结构，零文案、不依赖 locale、不 import 也不枚举任何功能；一个功能要出现在 Settings 里，由它自己的插件向对应 slot 注册——locale 注册 Language 行，ui-theme 注册 Appearance 行，ui-settings-models 注册 Models 一级面板。不为「某功能的设置页」单开 `ui-settings-*` 包：设置面属于功能包本身（做 Theme 功能，Theme 的设置选择就随 ui-theme 一起交付）。不属于任何单一功能的内容（trigger/标题/close 的 chrome 文案、General 目录与骨架行、`settings` 字典）由 `ui-settings-general` 拥有——它是「无主文案」的属主，不是功能卫星包。

Sidebar 声明 `sidebar.settings` single slot，`ui-settings` 占用它并声明四个 slot：`settings.trigger` / `settings.header` / `settings.close`（chrome 内容座，single）与 `settings.section`（一级页面，list）。无障碍名称全部解析自 slot 内容：trigger 的无障碍名称即其文本内容，dialog 经 aria-labelledby 指向 header 内容节点，close 是视觉隐藏文本座。每个 section 由功能插件贡献；壳只从 slot ledger 读取 entry metadata 生成导航，通过 `only` 渲染当前 section。General 由 `ui-settings-general` 注册（order 0）并声明 `settings.general.item` list slot，功能插件的偏好行按 order 排入。

Settings 入口是 sidebar Foot 的 Settings 行，点击直接打开 1080×700 居中浮层（黑 24% 遮罩）；close 按钮、点击遮罩、ESC 均关闭。无任何中间菜单形态。

`@deepseek-ai/dsh-client-locale` 提供 `ctx.locale`，`ui-theme` 提供 `ctx.theme`。两个服务都以 getter 读取、setter 写入并用 typed Cordis 变更事件发布不可变快照；服务自己持久化偏好（只存 id，无效值回退默认）。

功能行的 apply 层各自订阅自家变更事件（locale 订 `locale/change`，ui-theme 订 `theme/change`），把快照投影到该行注册时声明的 slot store。React 组件只读 `useStore`、写注入的 setter callback，不读取 ctx 或服务。

Theme 偏好三态：`light`、`dark`、`system`，默认 `system`（无持久化偏好或无效值时）。system 的解析属主题领域：ThemeRuntime 持有 `prefers-color-scheme` matchMedia 监听（环境感知，非 DOM 呈现），偏好为 system 且系统配色变化时重发快照；快照同时携带 `preference` 与解析后的 `active` 定义。

Theme 服务不操作 DOM。`ui-layout` 初始读取 Theme getter，随后订阅 `theme/change`，由 Layout 持有的 presenter 按 `active` 更新 `body[data-ds-dark-theme]` 和主题 token；presenter 不感知 system，只消费已解析结果。

### 首期注册面

| 注册面 | 属主插件 | 首期内容 |
|---|---|---|
| chrome 内容（trigger/header/close）| `ui-settings-general` | 设置入口行图标+文案、面板标题、close 隐藏文本 |
| General section（order 0）| `ui-settings-general` | Permission、Tool Call 视觉骨架（无写操作）+ `settings.general.item` slot 声明 |
| Language 行（item order 0）| `locale` | Selector 下拉，中文/English 真实可切 |
| Appearance 行（item order 10）| `ui-theme` | Light/Dark/System 三 cube 真实可切（选中态看 preference） |
| Models section（order 10）| `ui-settings-models` | 仅导航项，内容区为空；后续模型管理功能落在该包 |
| 插件 | 无 | 首期不做，导航不出现该项（后续插件功能包注册 section 即自动出现） |

首期只对 Settings 浮层内文案进行本地化；字典就近存放——chrome + General 骨架归 `ui-settings-general` 的 `settings` namespace，功能行文案归各功能包（`settings.locale`、`settings.theme`、`settings.models`）。

### slot 拓扑

```text
root
└─ sidebar
   └─ sidebar.settings                   single/root
      └─ ui-settings（壳，零文案）
         ├─ settings.trigger             single/root  ui-settings-general 注册
         ├─ settings.header              single/root  ui-settings-general 注册
         ├─ settings.close               single/root  ui-settings-general 注册
         └─ settings.section             list/root
            ├─ general (order 0)         ui-settings-general 注册
            │  └─ settings.general.item  list/root
            │     ├─ language (0)        locale 注册
            │     └─ appearance (10)     ui-theme 注册
            └─ models (order 10)         ui-settings-models 注册
```

section/item contribution 使用 `ctx.slots.inject()`，不依赖 client manifest（元数据清单）的 apply 顺序；本地化 label 走 [全量接入 Note](../../archived/architecture/2026-07-30-client-locale-full-rollout.md) 的 label thunk。SlotMap 类型分家：trigger/header/close/section 正家在 ui-settings 约定（消费方 general/models 均依赖壳，无环）；`settings.general.item` 正家在 locale 包——它是全部 item 注册方的最低公共依赖（设置行必带文案），而声明方 general 的约定对 locale/ui-theme 不可达（会成环）；ui-theme 经 re-export 出口消费。

### slot 声明是一等可注入等待对象

`SlotRegistry.inject()` 直接等待有类型约束的 ledger key；它不会将声明桥接为合成的 `slot:<name>` Cordis 服务。回调会跟随声明折叠与重新声明，而其控制器仍归贡献方插件 fiber 所有；直接向未声明 slot 注册仍会直接报错。这删除了基于陈旧 disposer 的在位状态机，以及容易因拼写错误出错的平行服务命名空间。完整的生命周期与失败约定见 [slot 声明注入决策](../../archived/architecture/2026-08-05-slot-declaration-injection.md)。

### 服务约定

```ts
export type ThemePreference = 'light' | 'dark' | 'system'

export interface ThemeDefinition {
  id: string
  colorScheme: 'light' | 'dark'
  tokens: Record<string, string>
}

export interface ThemeSnapshot {
  preference: ThemePreference
  active: ThemeDefinition            // system 已解析为具体 light/dark 定义
  themes: readonly ThemeDefinition[]
  revision: number
}

export interface LocaleDefinition {
  id: 'zh' | 'en'
  label: string
}

export interface LocaleSnapshot {
  active: 'zh' | 'en'
  locales: readonly LocaleDefinition[]
  revision: number
}

export interface Events {
  /** @param snapshot - Current locale registry snapshot. @mode emit */
  'locale/change'(snapshot: LocaleSnapshot): void
  /** @param snapshot - Current theme registry snapshot. @mode emit */
  'theme/change'(snapshot: ThemeSnapshot): void
}
```

Locale 内置中文和 English；`setLocale`/`setTheme` 是唯一写入口，未知 id 失败。

## 曾考虑的替代方案

**由 app shell 统一订阅偏好并重渲染 root slot tree。** 语言和主题变化只需要更新实际消费方；全树刷新放大影响面，也把业务偏好接入 shell。

**Theme 服务直接修改 DOM。**注册表服务因此依赖呈现环境，生命周期与全局样式所有权不清；Layout 已经拥有页面根呈现边界。

**system 由 Layout presenter 解析。** presenter 需自带 matchMedia 订阅并在 themes 列表里挑选具体定义，呈现层被迫理解偏好语义；解析放服务侧则所有消费方拿到一致的已解析快照。

**Settings import 并枚举各 section。** 新增页面必须修改壳插件，破坏「每个功能由自己的插件占用 slot」的组合模型。

**按功能为每个 section 单开 `ui-settings-*` 卫星包。** 设置面与功能本体分家：改 Theme 行为要动两个包，包数随设置项线性膨胀，且卫星包反向依赖 locale/theme 服务，形成纯粹为拆包而生的中间层。功能属主自注册下不存在这层：preference 行随功能包交付；`ui-settings-general` 只收无主文案（chrome 与 General 骨架），不承载任何功能的设置面。

**把 Locale/Theme 快照直接注入 React。** inject 结果按 entry identity 缓存，易变值会陈旧；为每个服务自造 React 钩子也绕开 slot store 的统一绑定。

## 验收标准

- Settings 壳只依赖 slot ledger，不依赖任一功能实现；General 的 item 列表同样只依赖 ledger。
- 新增一个设置项 = 功能包自己注册（section 或 general item），零壳改动。
- Locale 与 Theme 的写入只走 setter，持续同步只走变更事件。
- 功能行 store 初始化走 getter，后续由自家变更事件更新并局部重渲染。
- Layout 独立应用 Theme 快照，Theme 服务不访问 DOM；presenter 不出现 system 分支。
- 中文/English 与 Light/Dark/System 能切换并刷新后恢复；偏好为 system 时系统配色变化即时生效。
- Models 只有导航项与空内容区；Permission、Tool Call 骨架无写操作。
- 浮层经 close 按钮、遮罩点击、ESC 均可关闭。

## 风险

slot 声明与 contribution 的 apply 顺序不固定，所有 section/item 注册方必须使用 `ctx.slots.inject()`，而不能以服务或本地 disposer 作为在位信号。service event 可能早于行首次渲染，功能行 store 的 init 与 inject attach 都必须从 getter 对齐当前快照。`settings.general.item` 的重复合并副本（locale、ui-theme）与 ui-settings 正家必须逐字一致，漂移即三处一起改。Layout 卸载时必须清理自己设置的全局属性，ThemeRuntime dispose（资源释放）时必须移除 matchMedia 监听，避免 HMR（热模块替换）后残留。
