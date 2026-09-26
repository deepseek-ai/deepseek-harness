---
description: "通过声明式 preset 选择 Agent 的工具、提示词和技能。同一进程可以运行多种组合。配置失败会显示在列表中；现有 Agent 保留已经使用的组合。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-preset-registry

[English](README.md) | 中文

## 概述

通过声明式 preset 选择 Agent 的工具、提示词和技能。同一进程可以运行多种组合。配置失败会显示在列表中；现有 Agent 保留已经使用的组合。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 最小配置

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `default` | 必填 | 未显式指定时使用的 preset ID |

Web 内置定义来自 `dsh-web-app` bundle。定义使用普通插件行；注册表不扫描目录，也不接受 preset 路径。`agent-preset-registry` 条目的 volatile 字段 `selectedDefault` 保留用户默认值，新会话优先使用它而不是部署 `default`。profile patch 仍可能带有已废弃的 `modeSelectionEnabled` 字段；注册表未声明该字段，既不读取也不重写它。

注册表不写入任何声明。`read` Remote 把一条声明的子插件列表按 entry-list YAML 方言（含 `!!js` 条件）渲染回来，供客户端展示 preset 的组成；没有任何接口接受 YAML 写回。新建 preset 或覆盖内置 preset 都是 bundle 补丁：插入一行 `@deepseek-ai/dsh-agent-preset`，或按该行 id 写覆盖补丁，再用 `plugin_manager` 安装到 profile；创造模式在对话中编写这类 bundle。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每个声明在启动时创建注册表拥有的 scope 和内存 Loader 树。更新或移除声明会让旧代际退役；Agent、子 Agent 和临时历史读取各自持有引用，最后一个引用释放后才销毁插件树。插件注册继承 preset scope，Agent scope 的父链接决定可见性；Agent loop 仍由宿主共享。

激活审计检查导入失败、缺失服务和向全局泄漏的服务。导入失败、激活失败和泄漏会拒绝挂载。等待 Host 服务的行保持挂载，每次读取和绑定都在 Host Loader 树结算后重新审计，因此启动顺序不决定结果。失败只禁用该定义的新绑定。会话日志保存 preset ID 和空白会话的切换记录；重启恢复使用该 ID 的当前定义，缺失时拒绝恢复。

| 文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 注册、代际与 Agent 绑定 |
| [mount.ts](src/mount.ts) | 隔离插件树与激活审计 |

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope](../../core/scope/README.zh.md) — 注册隔离。
- [Agent](../../core/agent/README.zh.md) — 会话运行时。
- [Cordis](../../../docs/cordis-primer.zh.md) — 插件配置与生命周期。

<a id="model-experience"></a>
## 模型体验

### Preset 选择

#### 模型看到的内容

没有直接内容：所选 preset 的 `plugins` 拥有模型可见的工具和提示词片段。

#### Token 影响

本包自身没有；每个挂载的 `plugins` 行声明自己的工具和片段。

#### KV Cache effect

已有 Agent 保留插件和提示词。新 Agent 从当前定义构建前缀。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- preset 不是安全沙箱：YAML 及插件可以执行 Host 代码。用户覆盖替换完整子插件列表，不自动合并内置列表的未来更新。进程退出后不保存旧代际的插件实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

**运行时不变量：** companion 检查挂载后泄漏到全局的服务，以及模型请求前尚未绑定 preset 的 Agent。
