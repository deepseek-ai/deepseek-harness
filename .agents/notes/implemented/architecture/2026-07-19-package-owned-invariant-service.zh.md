# Agent Note: 包拥有的不变式服务约定

Status: implemented

[English](2026-07-19-package-owned-invariant-service.md) | 中文

## 问题

运行时不变式检查跨越会话轨迹、agent（智能体）状态、作用域 dispatch 和请求重建。如果所有检查都放在一个诊断包中，该包就必须导入彼此无关的产品领域词汇，测试也会离开真正的所有者；任何产品包新增或移除检查时，都要修改中央包。

选择启用诊断的部署还需要比“是否加载一个插件”更细的控制。这类组合会携带已知的不变式贡献，同时允许全局关闭或按包选择诊断。包稍后加载或在 HMR（热模块替换）下重载时，选择结果必须保持稳定；被过滤的贡献也不能让两个插件静默占用同一个包名。

已发布的包所有权必须机械完整。若没有仓库规则，包可能暴露不完整的 companion、依赖或发布映射，并一直保持损坏，直到维护者发现；不发布 companion 的包则必须在 README 中保留可评审的原因。

## 决策

### 一个注册表服务，贡献归包所有

`@deepseek-ai/dsh-invariants` 是与产品无关的 Cordis 服务插件，注册 `ctx.invariants`。它只负责配置、注册唯一性、子 fiber 生命周期和带包归属的失败；不导入 session、agent、scope 或 agent-loop 包，也不包含这些包的检查。

只有拥有可独立观察的事件或可变数据关系时，工作区包才发布 `./invariant` 伴随插件；该 companion 会注册自己完整且准确的 npm 包名。没有该关系的包会省略 companion 与发布接线，并在 README 中记录原因；[运行时约定 Agent Note](2026-07-19-package-invariant-runtime-contracts.zh.md) 与[省略决策](../simplification/2026-08-28-omit-unneeded-invariant-companions.zh.md)禁止生成占位符、空 installer 和合成 API 形状断言。包的根入口不会隐式导入或注册诊断，因此加载根包不会改变运行时检查，也不要求不变式服务存在。

### 配置与选择

```ts
interface Config {
  enabled?: boolean
  package_allowlist?: string[]
  package_blocklist?: string[]
}
```

默认值为 `enabled: true`、`package_allowlist: []` 和 `package_blocklist: []`。对完整注册名的选择规则为：

```ts
export function selected(enabled: boolean, package_allowlist: RegExp[], package_blocklist: RegExp[], packageName: string): boolean {
  return enabled
    && (
      package_allowlist.length === 0
      || package_allowlist.some(pattern => pattern.test(packageName))
    )
    && !package_blocklist.some(pattern => pattern.test(packageName))
}
```

blocklist 匹配优先于 allowlist 匹配。每个条目都是区分大小写的 JavaScript 正则表达式源，通过 `new RegExp(pattern)` 编译。除非调用方提供 `^` 与 `$`，否则匹配不锚定；系统不会解析斜杠包围语法或 flags。服务启动会拒绝空白、首尾带空白、无效或同一列表内重复的源。没有匹配当前已加载包的有效源仍然合法，因为注册顺序、稍后加载和 HMR 不应改变配置有效性。

### 注册与失败归属

公开注册边界是 `ctx.invariants.register(packageName, installer)`。即使过滤器禁止安装，它也会为每个完整 npm 包名保留唯一的活跃注册，并返回 effect disposer。卸载伴随插件或服务都会释放注册名及全部贡献状态。

启用的 installer 在服务拥有的独立 Cordis 子 fiber 中运行。`InvariantInstaller.inject` 显式声明该子 fiber 的服务 API；注册表不携带产品专用依赖元数据。服务会在注册成功前等待 installer 返回的 promise，因此异步启动检查仍具有事务性。installer 接收绑定后的 `fail(message)` 报告器。调用它会抛出名为 `InvariantError` 的 `Error` 子类，保留稳定代码 `INVARIANT` 并记录注册方 `packageName`；该错误不继承产品包中的错误基类。

注册启动是事务性的。如果 installer 在注册监听器后失败，子 fiber 会完整释放，并在失败向外传播前解除包名占用。被过滤的注册不创建子 fiber，但会保留占用直到 dispose（资源释放）。伴随插件重载时总会从干净的 installer 状态开始；有状态贡献从其所属服务重建基线。

原有函数式插件入口与单参数 `InvariantError` 构造函数不作为兼容 API 保留。仓库处于预发布阶段，所有调用方会一起迁移到服务和带包归属的错误。

### 首批有状态伴随插件与完整所有权

| 伴随入口 | 注册名 | 所属检查 |
|---|---|---|
| `@deepseek-ai/dsh-session/invariant` | `@deepseek-ai/dsh-session` | 会话序列、轮次/步骤包围关系和同一步骤的调用/结果轨迹 |
| `@deepseek-ai/dsh-agent/invariant` | `@deepseek-ai/dsh-agent` | agent 状态转换 |
| `@deepseek-ai/dsh-scope/invariant` | `@deepseek-ai/dsh-scope` | 作用域事件载体的存在性与主体一致性 |
| `@deepseek-ai/dsh-agent-loop/invariant` | `@deepseek-ai/dsh-agent-loop` | 模型请求重建 |

这四个所有者提供了首批有状态检查。后续所有者会为真实事件或可变数据关系增加 companion，没有该关系的包则省略 companion 并记录原因。每个已发布伴随入口都是单独打包的 `./invariant` export，具有独立声明和对 Loader 安全的命名空间插件形态。

`verify-package-invariants` 会发现每个工作区包，接受完整省略，并拒绝不完整的 companion 接线、生成标记、空 installer、缺少或不使用失败报告器的 installer、外部或无法解析的注册名、缺失的 `./invariant` export 或发布文件、缺失的不变式对等依赖（peer dependency）、开发依赖及项目引用，以及遗漏已发布伴随入口的自定义构建配置。

### 作用域事件语义映射

生成的作用域事件主体解析表位于 `dsh-scope`，与消费它的约定和不变式相邻。`gen-scoped-events` 使用根 TypeScript Program 枚举 `this: Scoped<Base>` 声明，从真实 `scopeTarget(base, key)` 调用推断路由键类型，并要求唯一、无歧义的 payload 主体或显式 unsupported 标记。提交的运行时映射不导入事件所有者包，因此语义完整性不会扩大服务包或 scope 包的运行时依赖闭包。

### 示例组合与 SDK 输出

`dsh-sdk-minimal` patch 将该服务与四个有状态配套子路径作为显式配置行挂载。子路径配置行会添加可安装的根 npm 包，而不会把子路径误当成包名。根据[交付配置决策](../simplification/2026-08-03-omit-invariants-from-shipped-config.zh.md)，交付的、基于 base 的配置树会省略该服务及其配套插件。

Workspace 约束识别独立的不变式 bundle；包 exports、项目引用、构建配置、依赖声明和 lockfile 描述同一份发布元数据。生成的配置目录、模块图和 API 文档都从这些源派生。

## 测试

服务测试覆盖默认值、全局关闭、allow/block 选择、blocklist 优先级、锚定与非锚定匹配、大小写敏感、无效配置、零匹配模式、延迟注册、重复所有权、dispose、回滚和 HMR 重新注册。具备可执行检查的所有者会把正向与负向行为保留在 companion 源码旁边。

组合测试覆盖标准主干转发和生成的 SDK 条目。Loader 测试固定每个伴随命名空间，构建后的纯 Node 冒烟测试覆盖编译子路径 export。作用域事件新鲜度门禁会重新执行语义 Program 分析。

每个 Vitest 配置都会加载测试宿主；在普通 Cordis 根上下文启动第一个插件之前，宿主会挂载显式启用的服务，并在当前测试包存在伴随插件时添加它。一个完整拓扑会一次挂载所有已发布伴随插件；服务与所有者的聚焦测试自行构建不变式拓扑，从而在不发生重复所有权冲突的前提下覆盖关闭、过滤、回滚与重载。门禁测试还会执行每个已发布伴随插件的 `apply` 函数，并验证它调用 `register` 时使用 manifest（元数据清单）中的包名，而不是只检查源码文本。

## 考虑过的替代方案

- **把所有检查保留在 `dsh-invariants`。** 不予采纳，因为注册表仍要导入所有被检查的产品领域，所有者变更仍需中央编辑，测试也继续远离被保护的约定。
- **当 `ctx.invariants` 恰好存在时，让根包入口隐式注册检查。** 不予采纳，因为根入口行为会依赖组合顺序与可选服务是否存在，诊断无法独立选择，而且包加载会隐藏一个不在显式伴随插件中的注册 effect。
- **在运行时自动发现所有 `invariant.ts` 文件。** 不予采纳，因为文件系统或包发现不是运行时所有权约定，会让 bundle 发布含义不清，也无法表达显式 Cordis 加载顺序或依赖安装。构建期生成与校验以及测试宿主可以枚举源码树，因为它们验证的是仓库完整性，而不是组合已发布的部署。
- **根据当前已加载包集合验证 allow/block 条目。** 不予采纳，因为零匹配模式可能有意指向稍后加载或 HMR 加载的贡献；当前加载顺序不能决定配置有效性。

## 后果

- 产品包拥有并测试自己的关系断言，服务保持与产品无关。
- 只有具备有意义运行时关系的所有者才承担 companion 的发布、依赖、listener 或 trace 状态成本；其他包在 README 中记录省略原因。
- 挂载诊断的组合无需改变插件树即可关闭全部检查或按包名选择。
- 显式伴随条目让诊断成本和所有权在 Cordis 配置与包 export 中可见。
- 每个选中贡献增加一个子 fiber 及其 listener/状态成本，被过滤注册则只保留包名占用。
- 正则表达式源属于部署配置，在服务重载前保持固定。
- 当前测试包发布伴随插件时，普通 Vitest 根上下文会安装其中被选中的伴随插件；一个完整拓扑只支付一次全部子 fiber 成本，用于覆盖整个仓库的注册。
- 会话存储验证、快照、冻结、引用的源事件验证与 surface 接受规则始终启用，不受不变式选择影响。
