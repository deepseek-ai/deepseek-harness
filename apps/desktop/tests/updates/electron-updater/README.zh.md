---
description: "Electron updater 适配层的平台版本记录与本地验证。"
---

# Electron updater 兼容性

[English](README.md) | 中文

`src/updates/electron-updater/` 中的适配层负责库的渠道策略、缓存撤销和 Electron HTTP 处理。本验证直接调用该适配层；协调器、配置和 UI 回归由常规测试负责。

每个 PR 在 Windows CI 中运行纯 Node 版本检查。`verified-versions.json` 分别记录 Windows 和 macOS 已验证的实际 Electron、electron-updater 及其 builder-util-runtime 版本。缺少记录、`null`（待验证）或版本不匹配都会使检查失败。Git 保留历史记录。此检查不启动 Electron，也不访问网络。

修改这些依赖、适配层或验证脚本后，在每个受影响的原生平台上从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
pnpm --filter @deepseek-ai/dsh-desktop run test:updates:channels --record
```

需要先构建 workspace 依赖（新检出目录运行 `pnpm run build:artifacts`）。最后一条命令重新构建 Desktop，启动不打开窗口的 Electron，并且只在成功退出后记录当前平台。将 JSON 改动与依赖或适配层改动一起提交。不带 `--record` 可只测试、不改记录。轻量检查只比较版本；版本未变不代表修改后的适配层已经通过验证。

fixture 使用独立临时目录、回环 HTTP 服务和惰性载荷，检查渠道清单文件名、降级拒绝、灰度资格、下载缓存撤销、新 updater 实例拒绝旧缓存，以及 macOS 代理关闭。它不执行安装器，也不访问生产更新源。安装依赖可能需要外网。30 秒看门狗覆盖 Electron 启动、测试和退出；超时或失败不会更新记录。签名安装和应用重启另行验证。
