---
description: "基于 `ctx.fs` 的独立 str_replace_editor 工具：供组合 Claude Code 风格文件编辑能力的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-str-replace-editor

[English](README.md) | 中文

## 概述

`dsh-tool-str-replace-editor` 提供基于 `ctx.fs` 的独立面向模型 `str_replace_editor` 工具：`view` 显示带行号的文件内容或浅层目录列表，`create` 创建新文件，`str_replace` 应用唯一的字面量替换，`insert` 在选定的边界处插入行。它可以与持久 Bash、一次性 Bash、沙箱 Bash 或其他终端接口组合。修改操作遵守与 fs 家族其余部分相同的编辑前读取策略与沙箱围栏，具体由所挂载的后端与策略插件强制执行。当部署需要 Claude Code 风格、使用绝对路径的单一编辑器工具时选择它；`dsh-tool-fs` 包提供替代的 `read`/`write`/`edit` 套件。

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

当模型应通过熟悉的 `view`/`create`/`str_replace`/`insert` 命令词汇在绝对路径上编辑文件时，把工具与 `ctx.fs` 后端（以及需要防护变更时的策略插件）一起挂载。

### 最小组合

一个后端、可选地加策略插件，然后是工具；编辑器可与任何终端接口组合。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxOutputChars` | `16000` | 文件和目录查看结果保留的前缀字符数 |
| `description` | `Custom editing tool for viewing, creating and editing files`（多行） | 面向模型的工具描述 |

### 命令

`view` 返回从 1 开始编号的文件内容（保留制表符，因此显示的文本仍可作为有效的字面量替换输入）或忽略隐藏、依赖与 Python 缓存条目的两层目录列表。`create` 创建新文件，并拒绝覆盖现有文件。选定命令不使用的专用字段可以包含 `null` 占位符；必填字段仍保持必填，`view_range: null` 选择完整视图，`str_replace.new_str: null` 会被拒绝，因此删除内容必须省略该字段。`str_replace` 要求字面量唯一匹配，错误只使用公开的 `old_str` 词汇；`insert` 遵循所选的零基插入边界，不会隐式补尾换行。修改操作会保留请求编辑范围之外的制表符。

### 失败与恢复

`view`、`str_replace` 或 `insert` 发生元数据未命中时，工具会在返回 `FS_NOT_FOUND` 前记录确认缺失，因此后续 `create` 可以通过已挂载策略的防护创建流程恢复外部删除的路径；缺失状态绝不会授权 `str_replace` 或 `insert`。防护变更继承策略插件的错误码与恢复指令——`FS_NOT_OBSERVED`（先读取文件再重试）、`FS_STALE_VERSION`（先重新读取再重试）——沙箱拒绝则表现为 `[sandbox: file access denied under <mode> mode]` 标记。路径必须是绝对路径；相对路径会被拒绝并给出提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释编辑器工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该工具是基于 `ctx.fs` 的单一 schema、四个命令。修改操作绝不带着自己的假设直接触碰提供方：每个操作都运行 `fs/write-intent` 或 `fs/edit-intent` waterfall 以取得策略插件的防护，在已挂载的 `ctx.fs` 实施沙箱限制时解析按调用沙箱策略，并把强制执行委托给提供方。`str_replace` 与 `insert` 还会重新读取文件，并在没有策略插件提供防护时把观察到的版本作为比较并交换的基础。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 整个工具：schema、命令分派、查看渲染、修改策略 |

### 各命令如何运行

每个命令都先解析绝对路径；修改操作随后遵循同一条共享流程——策略防护、提供方强制执行、成功后记录 `fs/observed`——而 `view` 只执行 stat 并渲染。整个工具——schema、命令分派与查看渲染——都位于 `src/index.ts`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具逐步进入它所组合的约定、策略与后端。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [dsh-fs](../fs/README.zh.md)——本工具消费的 `ctx.fs` 约定。
- [tool-fs](../tool-fs/README.zh.md)——替代的 `read`/`write`/`edit` 工具套件。
- [fs-observation-policy](../fs-observation-policy/README.zh.md)——通过 `fs/*` 事件防护变更的策略插件。
- [fs-sandbox](../fs-sandbox/README.zh.md)——围栏变更的沙箱强制后端。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-str-replace-editor)——本包注册的穷尽式 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

生成的 [`str_replace_editor` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-str-replace-editor)，包含配置的 `description`。本插件不贡献独立系统提示词段。

#### Token 影响

`str_replace_editor` 可见时产生固定的 schema 成本。

#### KV Cache 影响

配置的描述与 schema 不变时前缀稳定。

### 工具结果

#### 模型看到的内容

查看操作返回带行号文本或浅层目录列表。调用会提供文件位置，创建/替换调用还会向展示层提供 diff 卡片。修改操作返回简洁确认。长查看结果保留前缀并追加截断提示。

#### Token 影响

随数据变化，并受 `maxOutputChars` 与固定截断提示约束。

#### KV Cache 影响

工具结果以追加方式位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明编辑器工具何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用编辑器对比或任务积压。

- **操作面向 UTF-8 文本**——不支持二进制文件。
- **`str_replace` 刻意拒绝零匹配或多匹配**——它没有 `replace_all` 参数。
- **每个修改操作都会经过已挂载的策略与沙箱**——`fs/write-intent` 或 `fs/edit-intent` 解析当前会话的沙箱策略，并把强制执行委托给已挂载的文件系统与策略插件，因此未挂载它们的部署会得到无条件变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。tool adapter 不持有独立持久状态；filesystem mutation 关系属于 provider 与 policy 插件。
