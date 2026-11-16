---
kind: upgrade-guide
description: Client 产物元信息和静态库 manifest 要求重新构建自定义浏览器 bundle，并更新直接消费静态产物的代码。
---

# Client 模块元信息

[English](guide.md) | 中文

## 变更

Client bundle 注册可在 `id`、`factory` 和可选 `chunk` 之外携带 `meta`。factory 仍返回插件或库的导出。元信息可包含 `stylesheets`，即以样式在所属包内的路径（如 `src/client/App.module.css`）为键的字典；每份描述具有 `text(context)`，由 `context.asset()` 解析载体资源 URL。编译后的样式 import 不再在 JavaScript factory 执行期间安装 DOM 节点。

静态 Client 库的 index 产物保留原有具名导出，并增加一个携带相同 manifest 的导出 `__$dsh_client_module_manifest`；其 factory 返回不含 manifest 的库导出。ESM import 和动态 import 仍留给最终 Web 构建。

`staticLinked` 库（包括 `dsh-client-ui-primitives` 和 `dsh-client-ui-dockkit`）的样式不再进入 Web 外壳的 CSS 文件，改由 renderer 在应用挂载时安装。它们的 CSS Modules 类名从 `_<local>_<hash>` 变为 `<hash>_<local>`。生成的 style 元素仍以 `data-plugin` 携带所属包名，新增以 `data-path` 携带的包内样式路径，不再带 `data-plugin-css`。

用本预设构建的 bundle 可以在较早的 DSH 版本上加载，但没有样式，因为较早版本会忽略 `meta`。用较早预设构建的 bundle 仍自行插入 `<style data-plugin>` 元素，Modules 不再删除它们：禁用或实时替换这类插件后，其样式保留到页面刷新；替换版本同样由较早预设构建时，页面保留旧样式文本。

默认启动顺序不变：Modules 从原有加载 hook 建立 Main 环境，prefetch 在 Loader 激活前运行，renderer 在 React 根之前安装已物化模块的样式。Realm Registry 与 iframe 提供方是可选的；本次没有 Isolation 或 Shadow DOM 配置。

## 迁移

1. 使用配套版本的 `clientBundle` 预设重新构建自定义 Client bundle。自定义产物生成器通过 `meta` 提供编译 CSS 的描述；没有元信息的产物可省略它。不要把元信息加入 `factory()` 返回的业务导出。
2. 同时重新构建 `staticLinked` 库和消费它的外壳。外壳组装读取 `__$dsh_client_module_manifest` 导出；插件代码保留原有包标识符，通过模块加载器的 `require` 取得导出。枚举静态库命名空间的代码会看到这个新增的键。
3. 生成样式文本时通过 `context.asset()` 保留载体资源解析。DOM 安装交给 renderer，模块 factory 不再拥有生成的 style 标签。
4. 确认登记不会求值元信息、CSS 在应用根渲染前出现、lazy 元信息只在对应模块物化后出现，以及模块替换会移除或更新旧样式。[模块参考](../../../../packages/client/modules/README.zh.md)和 [renderer 参考](../../../../packages/client/ui-renderer/README.zh.md)定义所有权与失败行为。
5. 自定义 CSS、用户脚本和测试中匹配生成类名的选择器（如 `[class*="_header_"]`）改用 `data-*` 属性或无障碍角色，`style[data-plugin-css]` 改用 `style[data-plugin][data-path]`。
6. 把重新构建的插件在 `engines.dsh` 中声明的最低版本设为包含本变更的 DSH 版本。禁用或更新用较早预设构建的插件后，刷新页面。
