# Agent Note: Workspace 依赖发布范围

Status: implemented

[English](2026-09-22-workspace-release-ranges.md) | 中文

## Problem

DSH 包共享同一次产品发布。Cordis、其 vendored 库和 Node Addon System 独立发布；消费者需要接收它们的补丁更新，而不自动接纳新的次版本。

## Decision

每个 workspace 消费者对 DSH 目标使用 `workspace:*`，对 `vendor/` 下或 `native/system` 包族中的目标使用 `workspace:~`。规则覆盖根目录工具、应用、peer、开发依赖以及原生入口的可选平台依赖。消费者不因目录位置而获得豁免。

打包时替换为目标包的当前版本：Cordis 为 `4.0.3` 时，`workspace:~` 转为 `~4.0.3`；Node Addon System 为 `0.1.2` 时转为 `~0.1.2`。DSH 引用仍为精确版本。原生包族的成员仍以同一版本发布，但已安装的入口可以解析到后续的平台包补丁版本。

这套范围策略细化了 [npm 发布序列](2026-08-10-npm-release-sequences.zh.md)和[发布依赖门面](2026-08-26-published-dependency-faces.zh.md)。它们的独立发布族和依赖区段分类保持不变。

## Alternatives considered

**Vendor 使用 caret 范围。** 对 Cordis 这类稳定版本的包，caret 范围也会接纳后续次版本。

**Vendor 和 native 使用精确范围。** 每次接纳补丁发布都需要修改消费者的依赖声明。

## Consequences

Vendor 和 native 的补丁发布必须保持面向消费者的 API 和二进制接口兼容。范围转换不改变本地 workspace 链接及锁文件解析结果。Workspace 门禁拒绝 DSH 的 tilde 范围，以及 vendor/native 的 caret 或精确范围；打包清单测试校验最终输出的版本。
