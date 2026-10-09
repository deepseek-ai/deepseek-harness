---
description: "创建新的本地 Git 工作树并改变当前 Session 目录的模型工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-worktree

[English](README.md) | 中文

## 概述

从 GUI 插件管理器添加 Git 工作树，让模型通过一次调用创建并进入新的 Git 工作树。此可选 bundle 随 Harness 安装，在选中之前保持关闭。原生工具调用与 PTC 程序获得相同的带类型结果，创建操作沿用现有文件策略。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 GUI 中打开**插件 → 官方 → Git 工作树**并启用开关。此 bundle 一起加载[工作树运行时](../worktree/README.zh.md)与本工具；所有随附 profile 默认关闭它。关闭后会移除 `create_worktree`，已有检出目录与分支会保留。内置 `working_directory` 工具仍然可用。

在显式组合中，将此函数插件挂载到工作树运行时和工具注册表之后。

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

调用 `create_worktree({ name?: string, from?: string })`。成功会返回规范化检出路径 `path`、新分支 `branch`、固定提交 `baseCommit` 和源仓库根目录 `repositoryRoot`，并改变调用 Session 的当前工作目录。离开时调用 `working_directory({ cd: path })`；检出目录与分支会保留。[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-worktree)拥有准确的 schema 与面向模型的描述。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 `worktree` 运行时行与 `tool-worktree` 消费方行。[`src/index.ts`](src/index.ts) 注册一个带类型的工具。运行时创建操作拥有 Git 行为、取消处理与工作目录切换。工具将运行时记录作为规范返回值，并渲染为 JSON；Host 展示使用通用卡片。销毁插件会注销工具。

本包不发布运行时不变量伴随入口，因为工具不保留独立于工作树运行时的状态。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [工作树运行时](../worktree/README.zh.md)——配置、创建语义与写权限。
- [工作目录](../../session/working-directory/README.zh.md)——Session 上下文与离开操作。
- [工具编写](../../../docs/cookbook/adding-a-tool.zh.md)——规范结果与纯展示函数。

-----

<a id="model-experience"></a>
## 模型体验

### 创建工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-worktree)定义 `create_worktree`。每个成功结果包含已创建检出目录的规范路径、分支、基准提交与源检出目录的顶层目录。失败调用报告操作错误。

#### Token 影响

挂载期间，schema 为每次请求带来固定成本。每次调用将参数与有界创建结果或错误追加到普通工具历史。

#### KV Cache 影响

未改变的工具 schema 保留既有前缀。调用追加到先前历史之后；工作目录服务另行记录成功的目录切换，供后续请求使用。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **必须有调用 Agent**——工具改变 Session 目录，没有 Agent 的调用会被拒绝。
- **仅负责创建**——检查、合并、移除检出目录或删除分支不属于此工具；[运行时限制](../worktree/README.zh.md#known-limitations-and-deferred-work)同样适用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
