---
description: "让智能体在侧栏中你能看到的终端里运行长时间命令。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-terminal-bundle

[English](README.md) | 中文

## 概述

为所有智能体添加六个实验性全局终端工具，以及两个读取人自己终端的只读工具。组合包拥有隔离的终端注册表，其后端把每个终端打开为人可以旁观和接管的侧栏标签页。Web 和 Desktop 随附此功能，默认关闭，且不在插件页的组合包列表和详情页显示。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 `$DSH_HOME/profiles/<name>/package.json` 中（home 默认为 `~/.dsh`），将 `@deepseek-ai/dsh-experimental-terminal-bundle` 加入 `dsh.profile.bundles` 即可启用其配置层；从列表移除即可关闭。重启该 profile 后生效，详见 [profile 参考](../../../apps/cli/reference/README.zh.md#profile-boot)。[minimal 预设](../../bundle/web-app/presets/minimal.patch.yml) 独立加载自己的持久 shell，不依赖此组合包。

选中的配置层为 Host 中的每个智能体添加全局工具，覆盖所有预设（包括 minimal）。隐藏管理入口保留已有的启用配置；[升级说明](../../../docs/upgrade-guide/v0.2.1-rc.2/persistent-terminal-controls/guide.zh.md)介绍如何关闭此前启用的配置层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 Host 组 `optional-persistent-terminals`，在全局工具层注册这些工具。其中 `optional-terminal-panel` 行在 Windows 上优先使用 `pwsh`、其次 `powershell`，其他平台使用执行环境的默认 shell。后续配置补丁可以按 id 覆盖其条目。[配置组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序和错误处理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [侧栏终端后端](../terminal-panel/README.zh.md)
- [终端工具](../tool-terminal/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过[终端工具](../tool-terminal/README.zh.md)和[侧栏终端后端](../terminal-panel/README.zh.md)贡献模型上下文和结果。

#### KV Cache 影响

此配置层不直接添加请求内容；能力实现负责工具目录、提示和结果的缓存影响。切换组合包会改变运行中会话的工具列表，使其已缓存的请求前缀失效一次。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 智能体终端需要挂载终端控制器的 Web 或 Desktop 组合；此 bundle 不与其他终端注册表共享。
- [侧栏终端后端的限制](../terminal-panel/README.zh.md#known-limitations-and-deferred-work)同样适用。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
