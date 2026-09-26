# Agent Note: 账号提供方与当前请求取消

Status: implemented

[English](2026-09-17-account-provider-signout.md) | 中文

## Problem

根据登录态选择凭证会改变现有提供方路由的计费身份。退登也需要停止依赖账号的任务，不能根据请求或工具运行期间可能已经改变的设置判断归属。

## Decision

`deepseek-official` 和 `deepseek-account` 是独立路由，共享 DeepSeek 协议实现。每个适配器仅有一个凭证解析器和认证请求头模式。两条路由均不回退到另一凭证。账号服务保留[登录决策](2026-09-14-deepseek-account-login.zh.md)定义的来源及签发方校验。

账号取消读取运行中 Agent 最近的 `Session.requestContext()`，不维护额外提供方字段。该已记录值在工具和重试阶段保留，随下一次绑定请求更新；空闲 Agent 不计入。新轮次首次准备期间，它仍可能指向上一轮的账号路由，因此退登也可能打断尚未绑定新请求的 API key 轮次。没有历史上下文的首请求若缺少账号凭据，会在传输前失败。

本地退登成功后发布账号事件。Platform 账号提供方安装账号模块的监听器，遍历 Agent 注册表，通过 `Agent.cancel` 取消匹配的账号路由并保留收件箱。账号控制器的退登确认复用同一判断函数。每个已注册子代理独立分类；生命周期绑定到已取消父代理的子代理仍受现有父级取消规则约束。现有 HTTP 信号将取消传递到传输层。

## Alternatives considered

历史提供方集合会在轮次切换到 API Key 路由后仍错误取消它。当前设置会误判更早的在途请求。额外的提供方字段或模块级全局映射重复保存请求上下文中已有的信息。登录级取消信号重复现有 Agent 与 HTTP 取消链路。

## Consequences

模型选择展示两条路由，即使存在 API Key，选择账号路由仍要求登录。两个路由分别由 `llm-deepseek-account` 和 `llm-deepseek-api-key` 注册，拥有独立的模型目录与连接设置，共用 `llm-deepseek` 协议实现。取消保留排队输入，不自动唤醒。已记录的 hook 原因生成本地化对话提示，无须改变持久事件类型。

行为测试覆盖凭证分离、首请求准备、工具阶段取消及路由替换。SDK account-provider-signout 场景启动随附 profile，记录被中断的输出和取消原因。
