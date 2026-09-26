# Agent Note: One Messages transport for the official DeepSeek route

Status: implemented

[English](2026-09-19-deepseek-messages-only.md) | 中文

## 问题

官方 DeepSeek 路由需要 Messages 思考回放、图片上传与历史内更新。选择第二种传输会重复序列化器、流处理、Files 协议格式、配置分支与夹具，却没有为这条路由增加必需能力。

## 决策

`dsh-llm-deepseek` 仅使用 Messages。一个适配器解析请求局部的配置快照并执行请求。配置暴露一个端点，不提供协议选择器。Files 客户端直接使用 Messages 认证、元数据与分页；配额清理扫描全部页面后再选择最旧的自有文件。

[Messages 适配器决策](../feature/2026-09-07-deepseek-messages-adapter.zh.md)继续拥有原生思考回放、系统消息位置、图片恢复与请求扩展接受规则。回放判别值和上传索引命名空间标识持久数据，并保留现有值。独立的 pi-ai 适配器保留各提供方协议。

## 考虑过的替代方案

**在可选选择器后保留 Chat Completions。** 即使官方路由只需要 Messages，这仍会保留重复实现与测试矩阵。

**保留只有一个实现的通用协议分派器。** 分派器增加第二种依赖表示，并转发每个适配器操作，却没有进行任何选择。

## 后果

官方路由要求兼容 Messages 的端点。其基于 mock 的恢复、Loader、CLI 与 Web 测试使用 Messages；移除一种协议实现不会移除这些行为检查。已提交的 Session 代际继续通过提供方无关内容与保留的 Messages 回放元数据读取。
