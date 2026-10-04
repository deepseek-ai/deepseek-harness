---
description: "面向 Claude Code 模组的提示框上方 Web 横幅：从桥接的 Remote 绘制每个会话的模组树，并把按钮点击发回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-claude-code-mods

[English](README.md) | 中文

## 概述

这个可选的浏览器插件绘制 [Claude Code 模组](../claude-code-mods/README.zh.md)在提示框上方渲染的横幅。它挂载桥接的 `claudeCodeMods` Remote，监视每个已打开会话的横幅，并把序列化的 `Box`/`Text`/`Button` 树渲染为输入卡片上方的整行条目；点击按钮会在宿主上运行模组的 `onPress`，横幅随之重绘。没有模组绘制时，什么也不显示。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与桥接和模组一起组合；[可选叠加层](../claude-code-mods/cordis.source.patch.yml)为 Web 配置文件的源码启动完成了这一组合。横幅只在某个模组的 `ui.render` 钩子返回树时出现：首轮之后 Token Weather 的预报、风险命令被持有期间 Blast Radius 的 Proceed 与 Cancel、含编辑的一轮之后 Replay Theater 的提示。颜色按 Claude Code 的终端调色板映射到本主题的令牌；热键显示为标签旁的提示，按下即点击。按下处理期间所有按钮禁用；被宿主拒绝的按下会在横幅下方显示其消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

浏览器入口导入生成的 Remote 贡献并交给 `mountModsBand`，后者通过 `ctx.remote.$mount()` 挂载该贡献并注册一个 `conversation.input.dock` 条目。条目的 `inject` 为每个会话保持一条 `watchBand` 流，置于一个小型可观察存储之后，由槽位渲染器暴露为 `useBand`；`press` 以横幅绘制时的代数调用 `pressBand`，并应用其返回的快照。销毁时结束每条流与 Remote 挂载。[`Band.tsx`](src/client/Band.tsx) 渲染序列化的树：`Box` 为带 `data-direction`、`data-border` 以及来自属性的内边距与间距的 flex 容器，`Text` 为携带 `data-color`、`data-bold`、`data-dim`、`data-italic`、`data-underline` 的 span，`Button` 为没有动作 id 或按下进行中时禁用的按钮。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [桥接](../claude-code-mods/README.zh.md) — 横幅如何绘制，以及哪些模组先绘制。
- [与 Claude Code 模组的兼容性](../../../docs/subsystems/claude-code-mods.zh.md) — 本横幅渲染的元素与属性子集。

-----

<a id="model-experience"></a>
## 模型体验

None, as 横幅由宿主状态绘制，从不进入模型请求；按钮的效果只经模组自身的钩子到达模型。

#### KV 缓存影响

无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 每会话一条横幅；没有停靠的 `Pane`、`TextInput`、热键、焦点或滚动。宿主按 120 列宽渲染，横幅会换行；`width`、`height`、`overflow`、`wrap`、`truncate` 属性被忽略。
- 横幅反映宿主的重绘触发；在触发之外改变状态的模组会在下一次触发时绘出。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
