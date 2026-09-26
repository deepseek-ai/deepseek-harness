# 5. 配置

[English](05-config.md) | 中文

`cordis.yml` 中的每个 Cordis 配置项都可以携带 `config` 块，插件则声明一个 schema，在运行 `apply` 前验证该块。错误配置会导致加载失败，并给出准确的错误：插件绝不会在配置不完整时启动。

## 可配置插件

创建 `config-demo.ts`，并将其放在 `tmp/cordis-tutorial` 中：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'config-demo'

export interface Config {
  greeting: string
  targets: string[]
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})

export function apply(ctx: Context, config: Config) {
  for (const target of config.targets) {
    console.log(`${config.greeting}, ${target}!`)
  }
}
```

导出的 `Config` 既是 TypeScript 接口，也是同名的运行时 schema：消费方获得类型，Cordis 获得验证器。本仓库使用 [Schemastery](https://github.com/shigma/schemastery) 定义 schema；Cordis 本身接受任意 [Standard Schema](https://standardschema.dev/) 验证器，因此将普通对象导出为 `Config` 无法工作。

对其进行配置：

```yaml
- name: './config-demo.ts'
  config:
    targets: ['alpha', 'beta']
```

运行：

```
Hello, alpha!
Hello, beta!
```

未提供 `greeting`，因此 schema 默认值会将其补齐：`apply` 始终会收到完整且经过验证的配置。

## 明确报错

现在向它传入无效内容：

```yaml
- name: './config-demo.ts'
  config:
    targets: 'not-an-array'
```

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

插件的 fiber 进入 FAILED 状态，本教程的启动器打印错误后以状态码 1 退出。如果某个插件的配置通过了 schema 验证，但其中指定的资源或提供方不可用，该插件也应当在能解析该引用时立即拒绝。

<a id="volatile-fields"></a>
## Volatile 字段

对于插件在每次操作中读取的字段，可以使用 `.volatile()`。字段变化会更新稳定引用，无需重新挂载插件。通过 `.get()` 读取：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  greeting: Schema.string().default('Hello').volatile(),
})

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  ctx.on('loader/volatile-update', () => {
    console.log(config.greeting.get())
  })
}
```

直接调用 `Config(raw)` 也会返回引用。没有默认值的可选字段仍然具有引用；字段缺省时，`.get()` 返回 `undefined`。可以保存引用，也可以在单次操作中保存读取值，包括跨越 `await`，但不能将该值用于后续操作。对象和数组值是脱离输入、递归冻结的普通数据快照；函数、类实例和循环引用会被拒绝。

Loader 比较原始配置时忽略 schema 声明的 volatile 字段。仅 volatile 变化会经目标插件的 `internal/config` 钩子解析并校验；当所有普通字段的有效值仍然一致时，Loader 把新值提交到运行中的引用，并向所属实例发出一次 `loader/volatile-update`，参数是以键数组表示的变化路径，不进入目标插件的 `internal/update`。等值更新不通知。无效候选会记录日志，运行中的引用保持不变，直到下次激活。普通字段有效值变化（包括表达式求值结果变化）以及普通字段同时变化时沿用原更新流程，旧引用不更新也不接收通知。Group/Include 仍分发子条目更新。直接 `fiber.update()`、代码替换和依赖替换保留原有生命周期；`noSave` 仍控制直接更新的持久化。通知使用普通 `emit`，不等待资源重新配置完成。

在固定对象路径上声明 volatile 字段，或将整个对象、数组标记为 volatile。数组、字典、union 或 intersect 分支、lazy、transform 或另一个 volatile 值内部的独立引用会被拒绝。配置文件保存普通值；`simplify()` 会解包引用。序列化 schema 保留字段类型、默认值、角色和 volatile 标记，供基于 schema 的表单使用。现有 settings 消费者继续使用原有 settings 接口。

## 计算得到的配置值

本仓库使用的 loader 支持 `!!js` 标签，用于必须在加载时计算的配置值：

```yaml
- name: './config-demo.ts'
  config:
    greeting: !!js process.env.DEMO_GREETING ?? 'Hello'
```

`!!js` 仅在 `config` 与条目 `disabled` 字段内有效。`disabled: !!js ...` 在每次挂载决策时基于 loader 上下文求值（本仓库的扩展），可以按平台或环境门控一行；其余元数据（`name`、`id`、`inject` 等）保持静态，其中的表达式是普通真值数据。详见 [loader 配置](../cordis-primer.zh.md#loader-configuration)。

下一章：[组合与 HMR（热模块替换）](06-composition-and-hmr.zh.md)：将 `cordis.yml` 视为应用。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
