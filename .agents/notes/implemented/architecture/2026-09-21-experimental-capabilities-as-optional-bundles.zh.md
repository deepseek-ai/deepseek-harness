# Agent Note: 将实验能力作为可选 bundle 发布

Status: implemented

[English](2026-09-21-experimental-capabilities-as-optional-bundles.md) | 中文

## 问题

Web 插件页只提供两个可选 bundle：Agent Teams 与语音输入。Auto review 与 Inspector 都是已发布的实验包，用户必须按名称安装或手写 profile patch 才能挂载，尽管两者已经声明了 bundle patch 或附带可挂载的 overlay。

## 决策

`OPTIONAL_BUNDLES` 列出 Agent Teams、语音输入、Auto review 与 Schedule bundle。每个可选 bundle 都声明 `icon` 并导出带 `meta.title` 与 `meta.description` 的 `./locale/*.json`，官方分组因此能渲染本地化标题、描述和图片；`verify-default-product-isolation` 会拒绝缺少这些声明的可选 bundle。Inspector 的 `cordis.patch.yml` 直接写包名而非构建产物路径，所以同一文件既是 bundle patch，也是已构建 Web 启动的 `--patch` overlay。

可选 bundle 是安装的运行时依赖，其依赖图会随每次 `dsh` 安装一起下载。因此名单只接纳依赖图已在安装闭包内的包；Auto review 不增加任何依赖。Inspector 保留显式安装方式，不在默认插件列表中显示。浏览器操作与电脑操作提供方仍保持显式组合：Playwright MCP、Chrome DevTools MCP 与原生 Cua Driver 运行时二进制会让每次安装多出约 85 MB、21 个包，无论 bundle 是否启用；而随附的 Cua Driver MCP 开关会提供一个安装本身并不携带其可执行文件的能力。这些提供方包保留 locale 显示元数据，供组件行使用。另有两个包因其他原因不纳入：`ptc-runtime-python` 会替换 PTC 运行时，而 `workflow-ptc` 在加载时拒绝非 TypeScript 运行时，且 Web preset 内含 bundle patch 无法触及的 `workflow-ptc` 行；`browser-use-stagehand-native` 在 schema 校验时就要求原生模型名称与 API 密钥，而插件页没有对应的配置表单。

## 考虑过的替代方案

**把所有提供方都做成可选 bundle。** 组合与展示都正确，但会为多数安装从不启用的能力把提供方运行时塞进每次安装；语音输入的 `sherpa-onnx-node` 是唯一被接受的先例。

**在 `dsh-base` 中挂载仅负责注册的 `computer-use` 与 `browser-use` 服务。** 共享组合将携带只有可选提供方 bundle 才需要的行；提供方 bundle 可以从自己的 patch 和依赖插入服务行。

## 后果

官方分组包含四个可选 bundle 条目，每项都因实验包名而带实验性标签。安装的运行时依赖闭包保持不变。浏览器操作或电脑操作提供方仍需在 profile patch 或组合中同时挂载其 Service Definition 与提供方。
