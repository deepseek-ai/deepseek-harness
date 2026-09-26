---
description: "由操作者控制的 Windows 网络故障与恢复，仅针对已验证的安装版更新测试应用。"
---

# 测试应用网络故障

[English](README.md) | 中文

## 摘要

仅中断已安装验收应用的出站流量，再移除该准确规则后重试更新。工具绝不禁用网卡、VPN、代理或防火墙配置文件。真实流量中断仍须由操作者观察；测试替换了全部防火墙命令。

## 目录

- [准备](#prepare)
- [阻断与恢复](#operate)
- [证据与局限](#evidence)
- [开发备注](#dev-note)

<a id="prepare"></a>

## 准备

按照[演练指南](../README.zh.md)完成版本 1 安装包验证并安装该版本。提供已安装可执行文件，而非解包产物。在仓库根目录准备计划：

```powershell
node --import tsx apps/desktop/scripts/prepare-installed-update-network.ts "<run.json>" "<installed-test.exe>" "<verification/result.json>"
```

准备器要求版本 1 身份与签名证据、准确的测试文件名以及匹配的可执行文件字节。它解析 Windows 短路径，拒绝物料批次目录内的可执行文件。它独占写入 `network-fault/plan.json`，不改变网络状态。保留原始计划，它标识唯一可移除的规则。安装注册仍须操作者独立验证。

<a id="operate"></a>

## 阻断与恢复

以下是待执行的人工步骤，不是真实防火墙验收通过报告。使用管理员终端，并在阻断前准备第二个终端及 Restore 命令。每次调用写入新记录。`Status` 是默认动作，不改变防火墙状态。执行策略选项只影响本次 PowerShell 进程，不修改系统策略。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-update-network.ps1 -Plan "<plan.json>" -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-update-network.ps1 -Plan "<plan.json>" -Action Block
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-update-network.ps1 -Plan "<plan.json>" -Action Restore
```

启动 Block，停留在确认提示，再开始下载。出现正进度后，输入提示中的 `BLOCK <run-id>` 确认。脚本再次检查可执行文件字节与规则不存在，再创建一条指定程序的出站阻断规则。观察并截取实际下载失败；仅创建规则不够。执行 Restore 并输入 `RESTORE <run-id>`，移除匹配规则，再亲手点击重试。Status 必须报告规则不存在。绝不修改无关规则来强行制造失败。

<a id="evidence"></a>

## 证据与局限

脚本将带时间的阶段及最终成功/失败刷入 `network-fault/records/<id>/events.jsonl`。出错即停，绝不重试，也不在创建失败后静默删除规则。结果不确定时显式运行 Restore。恢复检查规则名、归属说明、方向、动作和准确程序路径，不要求可执行文件仍存在。规则不存在时安全地不操作；不会移除匹配名称的外来规则。

Windows 支持[指定程序的出站规则](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure-with-command-line)。本地策略、已有连接或确认前下载已结束，都可能使预期中断没有发生。PersistentStore 中有规则不证明流量确实被阻断。保持应用打开，观察其失败以及后续成功重试；任一现象缺失都将本次尝试记录为未完成。规则会持续存在直至移除，重启也不会自动删除。保留计划和恢复终端；测试规则仍存在时绝不安装更新。

<a id="dev-note"></a>

## 开发备注

本地计划验证与实际 PowerShell 控制流程已有无网络改动测试。真实规则创建、有效中断与恢复须由操作者在获准的已安装应用演练中执行。
