# 6. 组合与 HMR（热模块替换）

[English](06-composition-and-hmr.md) | 中文

到目前为止构建的每项能力都是插件，`cordis.yml` 则选择应用的插件树。本章会改变这种组合、热重载一个插件，并诊断始终无法加载的插件。

## Cordis 配置项不只有名称

Cordis 配置项除了 `name` 和 `config`，还接受其他元数据：

```yaml
- id: greeter          # stable identity for this entry
  name: './greeter.ts'
- id: consumer
  name: './consumer.ts'
  disabled: true       # keep the entry, skip mounting it
```

`id` 为 Cordis 配置项提供稳定标识，使 loader 能区分修改现有 Cordis 配置项与先删除再添加。`disabled: true` 会卸载插件而不删除其 Cordis 配置项；改回原值后，插件以及所有因依赖其服务而处于 PENDING 的插件都会再次加载。

组可以嵌套一份 Cordis 配置项子列表，并将其作为一个单元加载和卸载；`isolate` 则为一个组提供某项服务名称的独立实例，因此两个组可以各自看到配置不同的 `shell` 提供方，互不影响。[Cordis 入门](../cordis-primer.zh.md)和[服务隔离示例](../user/develop/framework/service.zh.md#service-isolation)介绍了详细内容。

## 热模块替换

卸载会释放 effect（[第 2 章](02-lifecycle-and-effects.zh.md)），加载则遵循依赖关系（[第 3 章](03-services.zh.md)），因此 HMR 可以先卸载、再加载，以替换正在运行的插件。`@deepseek-ai/dsh-hmr` 插件会监视文件，并在保存时执行这一过程。

在 `tmp/cordis-tutorial` 中编写 `cordis.yml`：

```yaml
- id: logger
  name: '@deepseek-ai/cordis-plugin-logger-console'
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root: ['.']
- id: hello
  name: './hello.ts'
```

列表中增加了两个辅助插件：HMR 通过 Cordis logger 服务记录日志，因此没有控制台导出器时看不到其消息；它还会 `inject` `timer` 服务来实现去抖，如果没有 `@deepseek-ai/cordis-plugin-timer`，它就会永远停在 PENDING，而且不发出任何提示。下一节就讨论这种静默状态。

HMR 通过 Loader 的原生辅助工具读取 Node 的 loader 内部结构。请在 tsx 下运行 Cordis：

```sh
node --import tsx ../../vendor/cordis/bin.js
```

现在编辑 `hello.ts`，修改日志消息并保存：

```
hello from my first plugin
2026-07-22 15:44:36 [I] hmr watching [ '.' ]
2026-07-22 15:44:39 [I] hmr reload plugin at hello.ts
hello from my EDITED plugin
```

旧实例先卸载（其所有 effect 都会回卷），新代码随后加载，`apply` 再次运行。按 Ctrl-C 停止进程。编辑 `cordis.yml` 本身也会触发更新：loader 按 `id` 比较 Cordis 配置项，只挂载、卸载或重新配置发生变化的部分。这就是上述 Cordis 配置项显式携带 `id` 的原因：不带该字段的 Cordis 配置项在每次读取时都会获得一个新生成的 id，所以只要配置文件发生任何编辑，即使自身文本未变，它也会被视为先删除再添加并重新挂载。

## 诊断始终无法加载的插件

依赖驱动加载也有另一面：如果插件的 `inject` 指定了无人提供的服务，它就会一直等待，不输出任何内容。这不是错误，因为 PENDING 是合法状态，提供方可能稍后才挂载。

你可以直接查看这些状态。每个上下文都能枚举插件注册表；创建 `diagnose.ts`：

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'

export const name = 'diagnose'

export function apply(ctx: Context) {
  setTimeout(() => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.state === FiberState.PENDING) {
          console.log(`${fiber.name} is PENDING — a required service is missing`)
        }
      }
    }
  }, 500)
}
```

再创建一个依赖无法满足的插件 `needs-timer.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'needs-timer'
export const inject = ['timer']

export function apply(ctx: Context) {
  console.log('needs-timer loaded')
}
```

```yaml
- name: './needs-timer.ts'
- name: './diagnose.ts'
```

运行它（直接执行 `node --import tsx ../../vendor/cordis/bin.js`，按 Ctrl-C 停止）：

```
needs-timer is PENDING — a required service is missing
```

`inject: ['timer']` 没有提供方。向列表添加 `- name: '@deepseek-ai/cordis-plugin-timer'` 后，插件就会加载。如果插件既不执行任何操作，也不报告任何内容，请检查其 fiber 状态。不加 PENDING 过滤条件进行迭代时，还会看到 loader 自身的插件（Loader、Include）处于 ACTIVE，因为配置文件本身也是通过插件挂载的。

下一章：[进入 harness](07-into-the-harness.zh.md)：把相同模式用于真实的 harness 服务。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
