---
description: "通过 Playwright MCP 操作 Chromium，为每个活动 Session 保持独立浏览器状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-playwright-mcp

[English](README.md) | 中文

## 概述

通过 Playwright MCP 的上游工具检查网页并操作 Chromium。提供方在 Session 创建或恢复完成前初始化其 MCP 连接，并跨轮次保留连接。可以启动独立浏览器，也可以让一个 Session 接入已有浏览器，使用其现有标签页和登录状态。本包以实验状态发布，仅在显式挂载后启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在创建或恢复 Session 前，将以下条目挂载到已提供 Agent、工具和系统提示词的 profile 组合中。加载或重新加载此提供方不会接管已经活动的 Session。浏览器安装遵循上游运行时；使用 `executablePath` 选择已有 Chromium 安装。

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: launch
    headless: true
```

使用 `mode: attach`，并在 `endpoint` 中设置 HTTP(S) 调试 URL 或 WS(S) 浏览器端点，即可操作已有浏览器。新的活动 Session 在初始化时占用附加连接，并持续保留直到卸载。如果连接已被占用，本次激活不使用该浏览器，但继续运行，后续轮次不会重试。连接释放后，新创建或恢复的激活可以获取它。其他 Session 的直接调用会失败。清理只断开连接，保留外部浏览器及其页面。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | 必填 | `launch` 或 `attach`，在本次提供方激活期间固定 |
| `headless` | `true` | 启动时不显示窗口 |
| `executablePath` | 上游发现 | 启动使用的 Chromium 可执行文件 |
| `endpoint` | attach 时必填 | 已有浏览器调试端点 |
| `toolCallTimeoutMs` | MCP 客户端默认值 | 单次调用超时，单位为毫秒 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-browser-use-playwright-mcp)列出接受的字段。浏览器模式由 profile 或 preset 选择。子进程会清空继承的 `PLAYWRIGHT_MCP_*` 选项，避免其替换该配置。

为整个进程配置系统提示词的 `toolOrder` 时，将浏览器工具留在 `<unlisted-tools>` 中。显式列出浏览器工具名称可能导致未获得浏览器连接的 Session 无法组装提示词。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

提供方解析固定版本 npm 包的可执行入口，并使用当前 Node 启动。服务进程之前可能运行临时协议探测进程。[共享运行时](../browser-use-runtime/README.zh.md)负责等待 Agent 初始化、逐 Session 串行执行与清理；[MCP 客户端](../../mcp/mcp-client/README.zh.md)负责传输、发现和结果投影。提供方不维护独立的连接观测，因此不发布运行时不变量配套入口。

只要活动 Session 保持连接，浏览器状态就会跨轮次保留。销毁会等待服务器关闭，再释放资源。重新加载后恢复 Session 会创建新的浏览器运行状态；已保存的对话历史不会还原 Cookie 或页面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [浏览器使用](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 所有权。
- [浏览器使用服务](../../browser-use/browser-use/README.zh.md) — 提供方独占注册。
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — 上游安装与浏览器行为。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具与截图

#### 模型可见内容

工具以 `mcp__playwright-mcp__<tool>` 命名，保留上游描述和 JSON schema。文本与截图通过常规工具结果流程进入 Session 日志。截图需要附件存储及支持图片输入的模型路由；其他路由会收到 MCP 图片诊断。MCP 客户端还提供资源工具和注明服务器来源的指导。只有当前 Session 拥有连接后才显示浏览器指导；针对该服务器的资源请求执行相同的所有权检查。

#### Token 影响

工具目录、资源工具和服务器指导会增加工具定义与提示词文本。调用会向 Session 历史加入参数、文本和获准输入的图片。内联图片字节不进入模型可见历史。

#### KV Cache 影响

不变的工具目录会保留工具定义前缀。结果追加到历史；更换提供方或目录可能降低前缀复用率。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

本集成保留固定版本服务器的浏览器与工具限制。

- 仅支持 Chromium；不可选择 Firefox 或 WebKit。
- 启动失败或取消会拒绝 Session 创建或恢复，并触发客户端清理。断开的客户端不会重试；修复原因后，创建新 Session，或卸载并恢复已有 Session。
- 连接独占仅在此提供方实例内有效。其他进程与浏览器用户仍可修改相同页面。
- 共享资源服务器目录可以显示继承的服务器名称，但不会授予对其他 Session 浏览器的访问权限。
- 取消不会撤销已发送给浏览器的导航、点击或其他操作。
- 工具 schema 跟随固定的实验依赖版本，不承诺 DSH 稳定性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
