# Agent Note: 在打包时验证 Desktop 发布兼容性

Status: implemented

[English](2026-09-09-desktop-build-release-validation.md) | 中文

## 问题

壳与运行时描述文件一起发布。每次启动比较其中的发布信息会重复打包检查，却不能证明已安装的可执行文件字节与描述文件一致。

## 决策

打包验证器负责描述文件 schema、shell 版本、平台、架构、声明的 Host 协议版本，以及 Node/pnpm semver 验证。启动读取准备 profile 所需的字段，并保留共享包记录和 Host 入口检查。实际 Host ready 消息仍然验证其协议版本。

本决策部分取代[内置运行时决策](2026-09-08-desktop-bundled-runtime-and-external-plugins.zh.md)中的启动发布兼容性检查。该记录继续负责包归属与分发的理由。

## 考虑过的替代方案

重复比较描述文件能更早诊断混装，但不能证明可执行文件完整性。重新引入这些比较需要具体的安装故障，且打包验证和实际 Host 诊断无法充分解释该故障。

## 后果

启动不会仅因描述文件声明的发布 schema、目标或 Host 协议不同，或 Node/pnpm 版本字符串不是 semver 而拒绝运行。打包仍拒绝这些情况和 shell 版本不匹配。测试区分启动读取与打包验证。
