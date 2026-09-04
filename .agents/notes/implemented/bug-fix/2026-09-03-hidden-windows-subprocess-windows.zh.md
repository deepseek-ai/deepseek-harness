# Agent Note: 隐藏 Windows 子进程窗口

Status: implemented

[English](2026-09-03-hidden-windows-subprocess-windows.md) | 中文

## 问题

本地 subprocess provider 可以在没有可见控制台的 GUI 或服务宿主中运行。宿主未提供控制台时，Windows 会为子进程创建新的可见窗口，因此普通命令或 `taskkill` 辅助进程可能闪现并抢占焦点，即使 harness 并未为该进程提供面向用户的 terminal。

## 决策

provider 对每次非 terminal `spawn` 以及两处同步 `taskkill` 调用都设置 `windowsHide: true`。主子进程只在 Windows 执行路径使用此选项；`taskkill` 本身只用于 Windows。terminal 进程继续采用 PTY 实现拥有的可见性与控制台行为。

该选项会隐藏控制台窗口，以及遵循 Windows 进程启动可见性设置的 GUI 窗口。调用方不能选择此行为，因为本地 provider 负责决定其后台进程管理是否创建宿主窗口。

## 考虑过的替代方案

**只隐藏主子进程。** 不予采纳，因为取消、超时升级、terminal 拆卸与宿主退出清理仍可能启动 `taskkill` 并闪现控制台窗口。

**暴露调用方选项。** 不予采纳，因为消费方无法可靠判断本地宿主是否拥有控制台，不一致的选择会重新引入抢占焦点的进程管理窗口。

**只隐藏控制台程序。** 不予采纳，因为 Node 只暴露一个 Windows 启动选项，无法在 spawn 前可靠区分可执行文件类型；探测目标还会增加平台特定竞态，却不能保留有用的产品行为。

## 后果

后台 subprocess 操作不会创建可见的 Windows 子进程或 `taskkill` 窗口。直接启动且遵循启动可见性设置的 GUI 程序也会以隐藏方式运行；需要交互式可见应用的消费方必须使用拥有该用户交互的能力，而不是后台 subprocess provider。

单元测试注入进程 launcher，固定主子进程和两条 `taskkill` 路径的 `windowsHide`，且不会创建宿主全局窗口或终止真实进程。
