# Agent Note: 将实验能力作为可选 bundle 发布

Status: implemented

[English](2026-09-21-experimental-capabilities-as-optional-bundles.md) | 中文

## 问题

Web 插件页只提供两个可选 bundle：Agent Teams 与语音输入。Auto review 与 Inspector 都是已发布的实验包，用户必须按名称安装或手写 profile patch 才能挂载，尽管两者已经声明了 bundle patch 或附带可挂载的 overlay。

## 决策

`OPTIONAL_BUNDLES` 管理安装随附且默认关闭的选项，包括维护中的可选能力与实验性能力。每个 bundle 声明 `icon`，并导出带 `meta.title` 与 `meta.description` 的 `./locale/*.json`；官方分组显示这些元数据。Bundle 的展示方式不决定其[实验性状态](../../../../packages/experimental/README.zh.md#status)。隔离检查校验准入，并继续拒绝非实验 bundle 的实验性依赖。

可选 bundle 的依赖随每次 `dsh` 安装下载。[思考过程翻译](2026-10-05-anonymous-reasoning-translation.zh.md)使用三个实验包，不增加第三方运行时依赖。因此准入需要考虑安装成本，以及开关能否在不增加配置表单的情况下提供可用组合。浏览器与电脑提供方仍使用显式组合，因为它们会增加较大的运行时或要求外部可执行文件。Stagehand 需要模型凭据；Python PTC 替换核心提供方，并与 TypeScript workflow 消费方冲突。演示性钩子、webhook 与模组不进入名单。[Session Inspector](../feature/2026-09-24-session-inspector.zh.md) 管理 Inspector 特有的激活行为。

Bundle 插入普通 Host 行；可选模型工具注册到全局工具层，因此包括 minimal 在内的所有预设都会获得它们。插件管理、profile 组合与重载无需针对 bundle 的特殊行为。搜索、Ralph 与终端在 Host 组内提供自己的隔离服务。搜索按需打开一个内存索引；Host 搜索策略保持不变。徽章技能与标题提供方作用于 Host。切换 bundle 会为运行中的 Agent 注册或移除其工具，后续用户 patch 层继续优先。前一个标题提供方开始清理后，替代提供方即可注册；前一个提供方的迟到结果不会提交。

Claude Code 与 Codex 通过独立的 `ON_DEMAND_BUNDLES` 目录按需安装，其成本、版本与离线发现取舍由[按需原生 bundle 决策](2026-10-05-official-on-demand-bundles.zh.md)管理。

## 考虑过的替代方案

**把所有提供方都做成可选 bundle。** 组合与展示都正确，但会为多数安装从不启用的能力把提供方运行时塞进每次安装；语音输入的 `sherpa-onnx-node` 是唯一被接受的先例。

**在 `dsh-base` 中挂载仅负责注册的 `computer-use` 与 `browser-use` 服务。** 共享组合将携带只有可选提供方 bundle 才需要的行；提供方 bundle 可以从自己的 patch 和依赖插入服务行。

**在运行时注册预设扩展。** 独立注册路径需要自己的排序、模块解析、代际更新与检查行为。Profile patch 为启动、配置导出、校验和用户覆盖保留同一个有效组合。

**用 `preset` patch 操作向指定预设插入行。** 只把工具限定在完整预设中，需要在 profile 组合、重载、插件管理和插件页中引入第二套 patch 语言，并为保留代际增加删除检查。全局工具通过现有 Host 组合即可到达同样的 Agent。

## 后果

官方发现不表示实验性状态，也不引入不同的插件生命周期。关闭 bundle 保留已安装文件；激活失败保留现有的已保存选择行为。Bundle 行是普通 Host 行，使用常规开关。独立与组合测试覆盖 Host 行及每个预设的工具目录；实时切换与已记录 Session 覆盖激活和模型可见行为。
