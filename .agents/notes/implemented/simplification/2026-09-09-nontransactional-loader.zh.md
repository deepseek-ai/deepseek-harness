# Agent Note: 保持 Loader 更改非事务化

Status: implemented

[English](2026-09-09-nontransactional-loader.md) | 中文

## 问题

事务化配置重载会在编辑失败后保留旧插件代次，但要求 Loader 负责候选导入、生命周期结算、回滚、选项对象身份和 Include 串行化。这些更改使 vendor 实现与固定来源产生显著差异。应用启动和 profile patch 监视也隐式依赖该结算行为。

## 决策

撤销 #932 中的五个提交，解决包移动冲突并保留后续独立行为。记录的合并提交属于更大的 #936 依赖链；撤销其第一父提交差异还会删除无关的仓库插件支持。[Vendor 修改记录](../../../../vendor/README.md#local-modifications) 按不变的固定来源记录每项保留的源码更改。

Loader 立即更改条目选项。EntryGroup 并发启动同级条目并记录应用失败；EntryTree 等待未完成的工作，但不因失败的 fiber 而拒绝。两者均不恢复旧插件或配置。Include 保留解析校验和 patch 重应用，但插件失败可能留下部分应用的配置树。

应用消费者负责完成检查。CLI 在安装实时 patch 监视器前等待其回退 HMR 服务。目录选择器检查其挂载的条目。选择器和浏览器包运行器在移除条目前取得首次 fiber 释放的结果，并等待该结果后才报告拆卸完成。预设挂载等待其子树，并报告导入、激活和缺少服务的失败。[应用启动](../../../../packages/boot/app-boot/README.zh.md) 负责精确 patch 文件监视、激活检查和部分上下文清理。Web 启动在打印 URL 或打开浏览器前检查激活状态。这些适配维持应用反向补丁后已有的消费者行为。

Fiber、Entry 和 isolate 保持上游的更新返回行为。App boot 通过现有的 `internal/update` waterfall 观察被丢弃的重启 promise，并在检查 patch 重载前等待 fiber。游离的导入完成观察器处理 fiber 的两种结果；fiber 仍保留失败信息供显式检查。Include 的持久写入在删除子条目前后均排空，防止后续拆卸写入掩盖更早的终止性写入失败。

保留两项 #932 专属 vendor 改动：Include 中等待初始文件创建并强制重新读取，以及 Schemastery 条件导出。恢复 #932 前的防抖写入和读取顺序，会在缺失文件初始化测试中复现 `ENOENT`。保留这两行可以维持已有 `initial` 选项，而无需在应用侧增加文件写入器或另一份 YAML 序列化逻辑。移除 Schemastery exports 后，Web preset 测试在启动时复现 `ERR_REQUIRE_ESM_RACE_CONDITION`：并发 ESM 导入使 Node 回退到 CJS 入口。HMR 注入装饰器、条件 patch 克隆及更新返回值采用 #932 前的行为。显式 `workspace:` 依赖使 #932 的 workspace 链接开关与专用锁文件检查不再必要。

## 考虑过的替代方案

**保留事务化 Loader 更新。** 它们能从被拒绝的插件候选自动恢复，但会保留本次删除的 vendor 生命周期机制。解析失败可以独立于插件回滚进行处理。

**逐字恢复所有 vendor 文件。** 这还会删除延迟注入配置求值、条件禁用条目、生命周期释放修复、持久写入和模块加载器兼容性。这些更改具有独立消费者，并继续记录在 vendor 修改记录中。

**将通用回滚移入应用启动。** 这会在另一归属下保留相同的候选代次与恢复义务。应用改为报告失败，并允许后续有效编辑恢复。

## 后果

插件激活失败可能保留新选项和失败的 fiber。要求插件处于激活状态的调用者必须在结算后检查；仅等待 `Loader.create()` 不能证明激活。自动插件回滚需要后续独立决策，并证明其恢复收益值得额外的生命周期实现。

[实时 patch 测试](../testing/2026-09-09-user-patch-hmr-test-delivery.zh.md) 保留受控事件投递和原生监视覆盖，同时断言不回滚时的失败报告。[终端释放策略](../bug-fix/2026-07-31-fail-loud-releases-the-terminal.zh.md) 仍适用于致命错误和部分启动拆卸。Web preset 组合与真实 CLI webhook 创建的模型 Session 提供手动挂载插件之外的应用级验证。
