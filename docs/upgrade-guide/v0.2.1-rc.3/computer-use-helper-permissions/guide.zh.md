---
kind: upgrade-guide
description: "Computer Use 需要给自己的 helper 应用授权，启动 DSH 的终端授权不再适用。"
---

# 给 Computer Use helper 授权

[English](guide.md) | 中文

## 变更

macOS Computer Use 通过 LaunchServices 以 `DSH Computer Use.app` 运行。终端或 Desktop 启动器的辅助功能和屏幕录制授权不赋予 helper 权限。源码准备会构建并签名应用；安装版需要预构建的应用及 `current.json` 记录。自定义 `helperPath` 指向裸原生二进制的启动方式不再受支持。

## 迁移

1. Computer Use 改为按需安装。在“插件 → 添加插件”中安装 `@deepseek-ai/dsh-cua-bundle` 并启用；此前选中过内置副本的 profile 也需完成这次安装。按提示重启 DSH。在 Computer Use 插件页按 macOS 提示，给 `DSH Computer Use.app` 授予辅助功能和屏幕录制权限。
2. 删除过时的 `helperPath` 覆盖配置或 `DSH_CUA_HELPER` 值，使用自动准备。使用自定义构建时，将其指向完整应用包内的 `DSH Computer Use.app/Contents/MacOS/dsh-cua-native` 可执行文件。
3. 恢复原生应用任务前，确认权限页显示 `DSH Computer Use.app`，且两项权限均已允许。具体目标应用仍需另行许可。
4. 若终端或 Desktop 启动器的这两项权限只用于 Computer Use，可在系统设置中撤销这些旧授权。给 helper 授权不会撤销其他应用已有的权限；模型运行的程序仍遵循启动器的系统权限和 DSH 沙箱策略。

源码构建使用临时签名，代码变化后可能需要重新授权。正式发布需要保持稳定的 Developer ID 签名身份，并完成分发公证。参见[原生构建说明](../../../../packages/experimental/cua-macos/native/README.zh.md#build-and-service)。
