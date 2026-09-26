# 实践指南：即时配置表单

[English](adding-a-settings-card.md) | 中文

在插件 Config schema 中声明即时字段，并通过产品所属的设置卡片提供编辑入口。导出的 `Config` 接口描述插件收到的值，包括每个 `Volatile<T>` 引用。

## 1. 声明即时字段

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  endpoint: Volatile<string | undefined>
  retries: Volatile<number>
}

export const Config = z.object({
  endpoint: z.string().volatile(),
  retries: z.number().step(1).min(0).default(3).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.on('loader/volatile-update', () => {
    ctx.logger.info('Retry limit: %d', config.retries.get())
  })
}
```

在操作开始时读取 `.get()`。需要一致快照的请求一次性捕获所需值。使用 `.check()` 进行跨字段 Config 验证；这些检查在持久化前由 Host 执行，不进入序列化的表单 schema。

## 2. 组合插件

为每个实例分配唯一的 profile 条目 id。基础组合包挂载 settings 和 config-editor。自定义 profile 挂载这些服务前，请阅读相应包的 README。

`role('secret')` 阻止值进入表单响应。对于凭据域管理的值，使用凭据引用。普通字段不进入设置 schema。

## 3. 验证编辑

在插件页面修改字段并保存。验证 profile patch、消费者下一次操作、插件实例标识不变，以及重启后的恢复。提交无效值，并确认文件和即时值均未改变。

自定义插件页面从 Plugins 页面所有者接收 `form.state` 和 `form.mutate(operations, expectedRevision)`。Host 校验完整 Config，并通过 ConfigEditor 和 volatile HMR 应用修改。[插件设置包](../../packages/client/ui-settings-plugins/README.zh.md) 提供现有卡片示例。

## 4. 向其他插件的页面贡献内容

对某个不属于自己的组合包、行或官方插件有话要说的插件，注册进 `plugins.detail.actions`（页头的控件）、`plugins.detail.badge`（标题旁的标签）或 `plugins.detail.section`（页面自身内容之下的区块）。每个条目都以页面的 `subject` 渲染——`{ kind: 'bundle', pkg }`、`{ kind: 'row', pkg, row }` 或 `{ kind: 'item', id }`——对无话可说的 subject 返回 null：

```tsx ignore-check
ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
  name: 'plugins.detail.badge',
  id: 'acme-update',
  locale: 'acmeUpdate',
}, ({ t, subject }) => subject.kind === 'bundle' && hasUpdate(subject.pkg) ? <Tag tone="info">{t('update')}</Tag> : null))
```

## 5. 浏览器半侧挂在哪里

浏览器半侧由[客户端模块系统](../../packages/client/modules)送到页面：它扫描已启用的 Loader 条目，找出声明了 `dsh.client` 的包，送出每个包构建好的 `./client` 导出——但它只把一个包的半侧挂在说明符恰为裸包名的那一行上。从子路径导出挂载的行永远不带半侧，因此把一个包拆成多行的组合包，其半侧留在根行上，它注册的每个页面都随根行关闭而消失。需要在其他行关闭时仍保留页面的子插件，应作为独立的包发布。

构建出的 `./client` 文件必须是客户端模块系统的 lazy-CJS factory 格式：一段脚本，向页面的模块加载器登记包名和一个 `factory(require)`，见[客户端模块系统的 README](../../packages/client/modules/README.zh.md)。生成它的 `clientBundle` tsdown 预设位于 `packages/client/tsdown.client.ts`，而不在任何已发布的包里，因此仓库之外的包要自己复刻这一步构建。

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
}
```

内置命名空间的伴生包就是同样的浏览器半侧放在一个纯客户端包里，宿主 `apply` 为空，列入 Web 组合的插件花名册（[`packages/bundle/web-app/cordis.patch.yml`](../../packages/bundle/web-app/cordis.patch.yml)），并通过 `ctx.configForms.whileServed` 注册进 `plugins.item`，页面因此恰好在 Host 服务该命名空间期间存在。
