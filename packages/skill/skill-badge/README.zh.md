---
description: "随包附带的「powered by dsh」徽章 skill，供启用、使用或排查该可选徽章提供方的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-badge

[English](README.md) | 中文

## 概述

agent（智能体）可以通过该内置提供方加载官方「powered by dsh」徽章 skill（技能），并遵循其指令，给文档、pull request 以及其他用 DeepSeek Harness 生成的内容添加署名徽章。该提供方没有配置，随附 CLI（命令行界面）组合以禁用状态包含该插件，因此部署方需要显式启用。该 skill 同时提供 Markdown 片段和随包分发的 PNG，供无法可靠导入远程图片的系统使用。

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

启用插件即可让 `dsh-badge` skill 出现在会话 skill 目录中；随后模型可以像加载任何其他 skill 一样加载它，并遵循其指令添加「powered by dsh」徽章。

### 何时选择

当用 DeepSeek Harness 生成的内容应携带官方署名徽章、且部署方希望该徽章 skill 对 agent 可用而无需存入本地 skill 目录时，选择此提供方。当徽章与部署无关时，请跳过——插件默认禁用，启用前不增加任何东西。

### 启用插件

该插件没有配置。把它的组合行加入组合即可；随附 CLI 组合以 `disabled: true` 携带该行，因此在那里需要显式启用。

```yaml
- name: '@deepseek-ai/dsh-skill-badge'
```

启用后，`dsh-badge` 会出现在会话目录的可用 skill 中。该 skill 覆盖远程 Markdown 徽章（基于 Shields.io）和随包分发的 PNG 徽章资源，后者用于无法可靠获取远程图片的目标环境。

### 徽章 skill 提供什么

- **Markdown 片段。** 在文档、pull request 与 merge request 中嵌入官方徽章标记的指令。
- **随包分发的 PNG 资源。** `dsh-badge.png`（726×120 源图，按 121×20 渲染），在无法导入远程图片的环境中可用。

### 可观察的成功与失败

启用插件会使 `dsh-badge` 出现在目录中并可凭名称加载；禁用或省略该行则它不会出现在任何目录中。由于提供方不可变，发现始终成功且恰好返回一个 skill，绝不会报告部分结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释内置提供方如何接线；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是一个不可变、同步注册的 skill 来源：它以 `dsh-badge` 作为提供方名称、按内置 skill rank（600）注册一个固定候选项，把随包分发的 `assets/` 目录作为该 skill 的目录资源基底公开，并在每次加载时从随包分发的 `assets/dsh-badge.md` 文件读取 skill 正文。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口与不可变提供方：一个候选项、资源基底、正文加载 |
| — | 不发布运行时不变式伴生入口；本包只持有一个不可变 provider 注册，注册唯一性与生命周期由 skill registry 负责。 |
| [`assets/`](assets/) | 随包分发的 skill 正文（`dsh-badge.md`）与 PNG 资源（`dsh-badge.png`） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从该提供方注册到的注册表逐步进入 skill 如何到达模型。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——该提供方实现的注册表与提供方约定。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表，以及已加载 skill 的共享渲染。
- [tool-skill 包](../tool-skill/README.zh.md)——徽章 skill 如何到达会话目录与模型。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；该包会把该提供方的目录条目和所选 skill 的正文渲染给模型。

#### KV Cache 影响

该插件默认禁用，不会改变任何请求。启用后，其目录条目和任何已加载正文都会在各自插入点改变提供方的 KV 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明内置提供方不做什么。它们是当前包约束，不是任务积压。

- **固定一个 skill，无运行时自定义**——提供方恰好贡献 `dsh-badge` 这一个 skill；需要其他徽章变体的部署请自行编写 skill。
- **远程 Markdown 依赖 Shields.io**——远程徽章标记内嵌 Shields.io 图片；目标环境无法可靠获取远程图片时，请使用随包分发的 PNG。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
