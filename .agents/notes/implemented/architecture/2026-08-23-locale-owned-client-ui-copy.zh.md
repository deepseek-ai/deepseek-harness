# Agent Note: locale 归属的 client UI 文案

Status: implemented

[English](2026-08-23-locale-owned-client-ui-copy.md) | 中文

## Problem

typed locale namespace 与双语字典对等性可以证明已注册字典完整，却无法证明展示代码使用了字典。JSX 文本、无障碍属性、格式化函数返回值和 zero-Cordis 原子组件默认值都可能绕过 `t`，而全部 locale 检查仍保持绿色。[最初的全量接入决策](../../archived/architecture/2026-07-30-client-locale-full-rollout.md)中缓做或假定为语言无关的例外逐渐形成混合语言 UI，trajectory 检查面和通用工具卡尤为明显。

## Decision

**所有产品编写的 client UI 措辞都由 locale 字典持有。** 可见文本、无障碍名称、tooltip、placeholder、空状态、状态标签、单位和格式模板必须经 typed `t` 席位或已本地化 prop 到达展示层。由用户、模型、提供方、插件、wire 对端或操作系统编写的值仍是数据并原样渲染；协议 tag、工具名称、路径、URL、JSON/JavaScript 字面量和稳定内部 id 不翻译。

**Cordis-free 原子组件要求完整的本地化文案 prop，且自身不持有语言回落值。** `MarkdownText`、`JsonTree`、`TerminalBlock`、`DiffBlock`、`ReadBlock`、`SearchBlock`、`WebBlock`、`CodeBlock`、`JsonBlock`、`HoverCard` 与 `ConnectionIndicator` 的 chrome 均由功能渲染点传入。这样既保留原子组件包的运行时独立性，也让遗漏成为类型错误，而不是静默选择中文或英文。共享用词进入 `common` namespace；功能专属短语留在决定其语义的功能侧。

**本地化展示文本绝不承担身份。** 模型与存储保留判别字段、稳定 id 和非展示 marker。渲染器先匹配再翻译，请求映射通过稳定的组成员关系进入 trajectory ledger。必须保存在视图模型中的 client 合成错误使用稳定 marker，只在展示时翻译。因此语言切换只改变措辞，不改变选择、分组、搜索身份或生命周期状态。

**`verify-client-ui-i18n` 强制源码归属。** 基于 TypeScript AST 的检查会发现每个包含 TSX 的 package `src/client` 目录树、`packages/client/ui-*` 下的所有辅助 TS 文件和 web 应用源码；它拒绝自然语言 JSX 文本、承载文案的属性与组件 prop、JSX 字面量分支、label/copy 数据、具名文案辅助函数、返回字符串的展示格式化函数和解构默认值。locale 字典 owner 与不可变语言 token 是严格的语法级排除项。发现范围缩窄会直接失败，单元 fixture 固定纳入与排除形态，检查加入静态 CI 与 `hygiene` 图。字典 key 对等性仍由独立检查负责：一道门禁证明文案进入 locale 路径，另一道门禁证明两种发布语言都实现该路径。

[最初接入决策](../../archived/architecture/2026-07-30-client-locale-full-rollout.md)中的产品自产错误与设计字面量例外、原子组件默认文案和 trajectory 缓做均由本决定取代；其 label thunk、typed 席位、浏览器 locale、日期格式化和搜索占位行决定仍有效。

## Verification

AST 检查自身的 Vitest spec 固定直接 JSX、模板分支、语义文案 prop、label 数据、格式化函数返回值、locale key 调用、结构属性和字典 owner。locale 字典对等性固定 `zh`/`en` key 一致。client 组件测试同时覆盖直接翻译席位与 locale prop 适配器；组装 web 回放和规定的真实服务器 GIF 在实际 trajectory 界面上展示发布的语言切换。

## Alternatives considered

**只依赖评审与 AGENTS.md。** 否决。既有规则和 typed 字典与数百个绕过点同时存在；评审者需要在引入行收到源码级失败。

**使用文本正则，或禁止所有字符串字面量。** 否决。TypeScript 与 JSX 中包含 import、CSS class、判别值、事件名、SVG 数据和用户/wire 值。按语法上下文检查可在不扩张文件 allowlist 的情况下保持有效信号，而最小发现数量可防止扫描范围缩小后伪绿。

**为方便直接使用而保留原子组件回落文案。** 否决。回落值本身就是隐式 locale 选择。必填 label prop 让原子组件保持框架无关，并迫使每个产品渲染点明确文案 owner。

**翻译所有进入 DOM 的字符串。** 否决。外部编写的数据和协议/代码 token 并非产品措辞。翻译会破坏证据、标识符、命令、路径、URL 和提供方诊断；只有其周围的产品 chrome 属于 locale 系统。

## Consequences

- 新增或修改 client UI 文案时，必须在两种 locale 中添加 typed 字典 key，并为受影响渲染路径提供行为证据。
- 纯原子组件的显式 prop 类型变大，测试需提供有意选择的 label fixture；这项成本换来无隐藏 locale 行为。
- AST 检查可以抓到产品编写的字面量绕过，却无法证明任意动态字符串 prop 已翻译。类型、字典对等性、组件测试和评审仍共同负责这一语义区分。
- locale 服务之前渲染的 boot 标记和外部编写的运行时数据仍在字典路径之外；locale 激活后，产品 UI 会替换 boot 文案。
