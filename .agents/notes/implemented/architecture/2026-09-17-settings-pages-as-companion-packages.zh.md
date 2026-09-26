# Agent Note：设置页作为伴生包

状态：已实现

[English](2026-09-17-settings-pages-as-companion-packages.md) | 中文

## 问题

四个官方设置页——终端、Agent 循环、Subagent、网页搜索——都放在一个客户端包 `ui-settings-plugins` 里，与「内置插件」分区挨着。每新增一个内置页面都让这个包再长一截，而想要设置页的社区组合包也找不到"页面与拥有命名空间的插件放在一起"的现成样板。曾考虑把每个页面搬进注册其命名空间的宿主包，但行不通：shell 命名空间由执行器家族在 sandbox 行之下注册，循环包为了一个数字字段要长出浏览器构建，Subagent 的命名空间从子路径行注册，而子路径行不携带浏览器半侧。

## 决策

**社区插件的设置页放在自己包的浏览器半侧。** 它注册进 `plugins.bundle.config` 或 `plugins.row.config`，自己拥有文案和样式，通过 `ctx.settingsScope` 读写。它的 i18n 走客户端 locale 服务，已发布的社区组合包本来就是这么做的。

**内置命名空间的页面放在伴生客户端包里。** `ui-settings-shell`、`ui-settings-agent-loop`、`ui-settings-subagent`、`ui-settings-web-search` 是纯客户端包，宿主 `apply` 为空，各在 Web 组合花名册里占一条裸名行，在 Host 服务其命名空间期间注册进 `plugins.item`。宿主包不含浏览器代码；它们编辑的命名空间以字面量拼写，从不从 owner 导入。

**表单机制搬进 `ui-primitives`。** `SettingsFormModel` 及 `settingsNumberField`、`settingsTextField`，`SettingsValueField` 与 `SettingsSecretField`，以及 `SettingsForm` 框架，是每个页面共同渲染用的套件；框架以 `labels` 接收文案，模型接受结构化的 scope，因此基线包既不依赖任何插件也不依赖其字典。

**`settingsScope.whileServed(namespaces, register)` 是注册规则。** 页面恰好在 Host 服务其某个命名空间期间存在：服务监视共享的 describe 镜像，命名空间出现时执行注册，一个都不再服务时注销，四个包共用一条规则而不是四份副本。

**`ui-settings-plugins` 只保留「内置插件」分区：** 导航项和供功能插件注册标签页的标签行。

## 考虑过的替代方案

**由 schema 驱动的通用表单。** 否决：通用渲染器只覆盖标量字段，碰到第一个动态控件就止步——Subagent 页的实时模型目录、跨字段规则、一次 mutate 提交——而每个例外都会变成一个 schema 本不该承担的 role。每个页面都是代码；没有发页面的社区插件就没有页面。

**内置页面做成双面宿主包。** 因上述原因否决；伴生包给能带半侧的包留了这个选项。

**表单框架的文案放在一本共享字典里。** 否决：那会让每个页面耦合到另一个插件的字典键；每个页面的字典自带那几条框架文案。

## 后果

- 插件页官方分组列出同样四个页面、同样顺序，来自四个包而不是一个；标签与表单未变，页面 golden 保持不变。
- 手册[添加设置页](../../../../docs/cookbook/adding-a-settings-card.zh.md)展示社区路径并点名伴生包模板。
- 客户端模块系统的规则不变：浏览器半侧挂在说明符为裸包名的 Loader 行上，因此拆成子路径行的组合包，其注册的所有页面都留在根行上。
- 终端页在 `plugins.item` 里的 id 是 `shell`，旧包注册的是 `bash`：官方页面上的 `subject.id` 现在是 `plugins.detail.*` 贡献可以据以判断的标识，所以 id 以页面编辑的能力命名，而不是某一个执行器家族。

## 测试

每个伴生包的 `tests/apply.client.spec.ts` 在 Host 服务命名空间时注册页面、停止服务时注销、teardown 时收拢；其 card 与 controller 用例延续原包里的页面行为。`packages/client/ui-primitives/tests/settings-form-model.client.spec.ts`、`packages/client/ui-primitives/tests/settings-form.client.spec.tsx` 与 `packages/client/ui-primitives/tests/settings-fields.client.spec.tsx` 钉住套件；`packages/client/ui-settings/tests/while-served.client.spec.ts` 钉住注册规则。`apps/web/tests/plugin-config.e2e.ts` 走真实链路验证终端页与 Subagent 页。
