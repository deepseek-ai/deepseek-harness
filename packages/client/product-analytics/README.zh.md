---
description: "配置桌面端产品埋点、身份字段和事件时机，不采集 Web 使用情况。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-product-analytics

[English](README.md) | 中文

## 概述

桌面端默认通过现有 OTel 产品导出器上报指定交互，不提供用户操作入口。普通 Web 客户端不会提交这些事件，缺失的登录身份字段会省略。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

桌面端同时装配 Analytics 与必需的 Telemetry 导出器。`product-analytics` settings 命名空间持有动态 `enabled` 字段，默认 `true`，通过现有 Cordis Config / settings 机制配置，暂不提供用户操作入口。普通 Web 不装配这两个服务。关闭后不读取埋点身份、不接收新事件；导出器仍保持挂载，已入队事件可以继续导出。会话反馈遥测采用独立策略。

渲染端和 Electron 通过现有认证流订阅 Host 策略变化及重连后的值；Electron 在原生启动上报前还会读取初始策略。欢迎窗口通过 IPC 获取当前策略。Host 在接收事件及读取身份后都检查当前 volatile 配置。`DSH_PRODUCT_ANALYTICS_OTLP_URL` 可覆盖导出目的地，用于隔离的接收端。[导出器](../../host/product-telemetry-otel/README.zh.md)负责批量发送、重试和退出时的交付。

公共字段为 `device_id`、`user_id`、`os_version` 和 `app_version`。设备身份复用现有登录记录，不会生成新标识。Host 通过 `deepseekAccount.getDeviceIdentity()` 读取不含凭据的设备、账户和操作系统字段。缺失值会省略；API key、账户令牌、提示词和模型回复都不是事件字段。

Electron 将构建内联的 `DSH_CLIENT_VERSION` 传给 Host；埋点与导出器复用这一客户端版本，导出器要求该值存在。[桌面组合](../../bundle/web-app/README.zh.md)负责批量发送与超时配置，包括达到关闭期限时的取消行为。

认证事件仅覆盖原生欢迎页；通过 API Key 进入工作区后再登录的场景不在采集范围内。[事件类型](src/events.ts)定义名称和允许的字段。页面曝光按实际进入可见页面计数，包括重新显示的原生欢迎窗口；onboarding 短暂进入加载状态不会重复计算同一页面曝光，关闭 onboarding 弹窗上报 `button_name=close`。有余额时的继续按钮使用 `continue`。消息提交保留最初发生时间，并在异步命令裁决前采集 `msg_type=default|queue|steer`、模型、显式思考强度和 `run_mode`；仅普通消息路径在引用序列化之前上报，已处理或认领的命令不计入。后续序列化、附件处理或发送失败不撤销此次计数，排队后的执行也不重复计数；纯附件提交遵循相同规则。计划模式优先于活跃目标。采集和上报异常不会中断提交。消息提交以及模型或思考强度切换在空白会话中均省略 `session_id`。模型与插件切换仅在变更被接受后上报。分叉事件携带已创建的子会话 ID 和来源 ID，在可选的子会话标题更新前上报；创建失败不产生事件。

只有 `plugin_toggle` 携带 `plugin_type`：插件条目使用 `plugin`，插件包使用 `bundle`。安装通过 `is_success` 表达结果；取消使用 `is_success=false` 和 `error_reason=user_cancelled`，恢复查询确认无结果时使用 `is_success=false` 和 `error_reason=unknown_result`。耗时单位为毫秒，从点击安装开始，到最终结果结束，包含校验、检查输入和内部源重试。`input_value` 仅保留 registry 包标识和普通版本；Git 输入记为 `[git]`，其他 URL 记为 `[url]`，路径及无法识别的输入记为 `[path-or-other]`。点击和结果均使用脱敏后的值。重新打开已隐藏的安装弹窗会再次计为 `plugin_add_button_click`。`is_builtin` 表示由安装供应（`installed=false`），不表示 profile 是否显式依赖该包。显式批准构建后的重试开启新的一次尝试。需要重启视为成功。临时断线保留待定操作；只有恢复查询确认没有结果时才上报 `unknown_result`。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

展示组件接收回调。共享 Client 服务读取可选的桌面埋点发送器，后者要求同时存在原生 preload 标识和 同步的 Host 采集策略。发送器在被其他插件调用时保留自身的 RPC 上下文。原生操作使用已认证的 Host API，其生成的 Typert 校验器只接受类型中声明的事件字段。Host 在入队前补充身份信息，并监听实时压缩事件，不重放会话历史。

</details>

<a id="model-experience"></a>
## 模型体验

无；埋点不增加模型上下文或会话事件。

#### KV 缓存影响

无；采集不修改模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

交付采用尽力而为的方式。

- 关闭只停止新采集，不清空导出器队列。
- 渲染进程的发送失败会被丢弃，导出器没有持久化待发队列或数据仓库确认。
- 原生启动事件等待 Host 认证完成；若进程在 Host 就绪前失败，则无法上报启动事件。

### 开发备注

无。
