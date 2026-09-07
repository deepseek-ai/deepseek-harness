# Agent Note: DeepSeek 官方首次使用凭据配置

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-deepseek-onboarding-credential-setup.md) | 中文

## 问题

[web 配置平面](../architecture/2026-07-30-web-config-plane.zh.md)让提供方设置与凭据可以实时编辑，但首次使用的用户仍会进入空白对话 Hero；当随产品提供的 `deepseek-official` 路由缺少凭据时，界面没有给出可采取操作的说明。Models 页能修复该状态，但要求用户自行发现这个入口会削弱首次使用引导。界面不得混淆凭据缺失与适配器缺失：浏览器可以为现有凭据引用存入值，但无法动态挂载 `llm-deepseek` Cordis 插件。

## 决策

**Models 与首次使用引导共享同一个就绪状态投影。**`ui-settings-models` 维护一个 store，把 `llm/listProviders`、`llm/listConfigurableProviders`、共享 settings describe 镜像持有的已脱敏 namespace views 和批量调用的 `credentials/describe` 联接为同一份状态。首次使用投影选取由 `llm-deepseek` namespace 与空 settings path 持有的 `deepseek-official` 可配置提供方条目，读取生效的 `apiKeyEnv`，并检查对应的凭据描述符。同 provider id 但没有匹配可配置提供方声明的存活路由，在首次使用引导中视为适配器缺失。通过进程环境提供的凭据若已配置，则判定为就绪并保持只读。后续的 [settings describe 镜像决策](../architecture/2026-08-17-settings-describe-mirror.zh.md)持有这次 settings 读取及其失效顺序。

**设置外壳只贡献排序，不持有提供方策略。** `ui-settings` 声明一个根作用域的 `settings.onboarding` list slot，并在当前界面为空白 Hero 时，每次只挂载一个有序步骤。当前注册方会收到 `complete()` 和私有 `openSection(id)` 回调；完成当前步骤后，所有权转交给下一项。`ui-settings-models` 通过 `slots.inject()` 注册 DeepSeek 步骤、排在它之前的欢迎声明及 Models 分区，因此所有贡献都跟随同一个 client Cordis 插件的生命周期，两个弹窗也无法堆叠。它们的共用展示由[共用弹窗引导决策](2026-08-13-shared-modal-product-onboarding.zh.md)持有。

**首次使用弹窗行内渲染既有凭据编辑器。** 适配器已挂载且处于活跃状态，其引用可解析、可写但尚未配置时，`ProviderEditor` 会以仅凭据模式渲染在共用引导弹窗中。同一个组件全权负责密码输入框、校验、`credentials.set({ref, value})`、写入失败处理和写入后刷新；仅凭据模式不会发出提供方 settings 变更。「稍后配置」只完成协调器当前这一轮。适配器缺失时仍跳过，因为浏览器不能挂载缺失的 Cordis 插件。

**不可用状态不会占住产品。** 可配置提供方条目缺失、路由不活跃、初始联接失败、部署只读或设置／凭据能力无法解析时，都会直接完成而不渲染该步骤，因为首次使用引导无法修复这些状态。Models 页仍是部署诊断与重试界面。「稍后配置」只会完成协调器当前这一次缺少凭据的步骤，不写入任何完成状态。设置、凭据、提供方拓扑和连接失效事件都会刷新共享联接，因此外部凭据更新无需重新加载页面即可完成已打开的步骤。

## 曾考虑的替代方案

**为首次使用引导单设 store 与就绪状态 RPC 调用序列**：不予采用，因为这会在 Models 页之外，再建立一套客户端解释，用于判定提供方身份、设置路径、secret 槽位的伴随信息、凭据引用及失效事件顺序。

**在首次使用引导中单独实现 API key 表单**：不予采用，因为这会复制 Models 编辑器的 secret 草稿、校验、错误和已配置状态收敛。弹窗改为以受限模式渲染既有 `ProviderEditor`。

**把 API key 写入提供方设置**：不予采用，因为字面量 secret 会进入设置变更路径，而整个分节替换无法安全重建脱敏值。凭据存储已经是产品 seam，并能立即发出失效事件。

**`llm-deepseek` 缺失时仍显示浮层**：不予采用，因为浏览器导航没有任何受支持的操作可以挂载缺失的 Cordis 插件。

## 后果

有序流程从产品声明页开始，无需重启即可进入行内密钥表单：无密钥浏览器测试在隔离的 harness 家目录下启动真实 Web 组合，确认声明后从共用弹窗把生成的密钥存入该目录的 `.credentials.yaml`，验证密钥未进入 DOM、ARIA 或浏览器控制台输出，并确认普通 Models 页面报告已配置。完整的无密钥 Web 回放也固定了同 id 的不可配置回放路由不会阻塞无关流程。纯就绪状态测试与 React 测试固化了受管文件凭据与进程环境凭据、提供方与能力缺失、取消、外部失效和协调器移交。该流程直接继承配置平面已记录的基础限制，不会另加局部的机密存储、脱敏或设置替换变通方案。
