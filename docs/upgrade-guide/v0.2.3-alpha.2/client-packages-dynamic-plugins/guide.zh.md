---
kind: upgrade-guide
description: "ui-slots、ui-primitives、ui-dockkit 改为带 immediately: true 的动态插件包：推荐写法是 `<包名>/client`，包根在 Node 中是空的 Host 入口，完整 Web 组合必须列出它们的 row。"
---

# 三个 Client 包改为 `immediately` 动态插件包

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，Web 外壳静态链接 `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives` 和 `@deepseek-ai/dsh-client-ui-dockkit`：包根是带 `__$dsh_client_module_manifest` 导出的浏览器 ESM。升级后，每个包都是带 `immediately: true` 的动态插件包，与 `ui-renderer` 相同。它的 row 先于其他插件加载，它的 `./client` 导出 `lib/client.js` 向模块加载器登记本包的模块，因此其他 bundle 可以 require 它的导出。这些 `/client` 实体导出暂时保留，并会逐步缩减。`@deepseek-ai/dsh-client-store` 不变，仍静态链接。

值、类型和 `declare module` 扩展的推荐写法都是 `<包名>/client`。对按包根编写的代码，这几个包调整了导出与类型，DSH 也保留两条兼容承诺，每条都有测试守住：

- **TypeScript。** 代码可以从包根导入类型，用 `declare module '<包名>'` 扩展包根，也可以在同一文件或不同文件中与 `/client` 写法混用：已发布包的根 `types` 与 `./client` types 是同一个声明文件，所以每种写法读到的都是同一个合并后的接口。[`verify-client-package-consumer-types`](../../../../scripts/verify-client-package-consumer-types.ts) 在 NodeNext 与 Bundler 两种解析设置下编译[外部消费者 fixture](../../../../scripts/fixtures/client-package-consumer/)。
- **浏览器。** 已构建插件的 `require('<包名>')` 从模块表拿到的导出与 `require('<包名>/client')` 相同（[单元测试](../../../../packages/client/modules/tests/loader.client.spec.ts)、[浏览器测试](../../../../apps/web/tests/client-package-specifiers.e2e.ts)）。

其余一律按新形态：在 Node 中，包根是只导出空 `apply` 的 Host 入口 `lib/index.js`，不提供其他值；`__$dsh_client_module_manifest` 导出已不存在；只有组合中列出这几个 row 时，Web 客户端才拥有这些包。它们导出的 API 仍属预稳定。[Agent Note](../../../../.agents/notes/implemented/architecture/2026-11-27-client-packages-as-immediately-dynamic-plugins.zh.md) 记录了这一决定。

受影响的有：在 Node 中运行这些包的代码或读取 manifest 导出的测试和工具，以及组合完整 Web 客户端的自定义 `cordis.yml`。

## 迁移

1. 通过 `<包名>/client` 引用这些包，例如 `import { Button } from '@deepseek-ai/dsh-client-ui-primitives/client'` 和 `declare module '@deepseek-ai/dsh-client-ui-slots/client'`。现有的包根 import 和扩展仍能编译，在浏览器中也仍能加载。
2. 在 Node 中运行浏览器侧代码的测试，从 `<包名>/client` import 这些包的值，并像本仓库的 tsconfig paths 那样把它解析到 `src/client/index.ts`；或者把精确的包根别名到 `<包名>/client`。
3. 替换内置 Web 客户端组合的自定义 `cordis.yml`，要在 `ui-renderer` 之前加入这几行，与 [`packages/bundle/web-app/cordis.patch.yml`](../../../../packages/bundle/web-app/cordis.patch.yml) 相同：

   ```yaml
   - id: ui-slots
     name: '@deepseek-ai/dsh-client-ui-slots'
   - id: ui-primitives
     name: '@deepseek-ai/dsh-client-ui-primitives'
   - id: ui-dockkit
     name: '@deepseek-ai/dsh-client-ui-dockkit'
   ```

4. 打开 Web 客户端确认：应用正常挂载，没有启动失败页；页面中的 `window.__DSH_BOOT__.entries` 列出这三个包名，且带 `immediately: true`。
