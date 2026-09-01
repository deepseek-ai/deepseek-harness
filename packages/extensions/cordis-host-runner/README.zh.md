---
description: "动态 Cordis 包的 host 半说明，供选择、组合或排查注册表、沙箱与运行往返的 agent 与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cordis-host-runner

[English](README.md) | 中文

## 概述

`dsh-cordis-host-runner` 让动态包在本进程中可运行：模型用 `cordis_define` 记录的定义留在这里，host 半在 `node:vm` 沙箱中运行，带浏览器半的包会等待人在页面上批准或拒绝，模型也可以在这里检查实时运行时及其定义。面向模型的工具在 `@deepseek-ai/dsh-tool-cordis` 中，浏览器半经 `@deepseek-ai/dsh-cordis-client-runner` 装载。定义只存在于进程内存中，因此 DSH 重启即清空，也不会向磁盘写任何东西。唯一的配置字段 `vmTimeoutMs` 限制同步沙箱求值的时长。

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

在任何一个应当支持动态包的组合中挂载本插件——它支撑模型的 `cordis_*` 工具，而带浏览器半的包还需要在客户端组合中额外挂载 client runner 与 UI 包。常用路径是显式的：加载本包，按需设置 `vmTimeoutMs`，其余交给工具与浏览器。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    vmTimeoutMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `vmTimeoutMs` | `5000` | host 半在 vm 中同步执行的那部分被中止求值前可运行的毫秒数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-cordis-host-runner)是每个受支持字段的穷尽式真源。

### run 会做什么

定义由 `cordis_define` 记录、由 `cordis_run` 激活。只有 host 半的包直接在本进程中激活：它的代码在沙箱中运行。带浏览器半的包变成一次请求：它一直等到有人在一个页面上允许或拒绝，或提问的轮次被取消；作答页面随后先装载 host 半、再装载浏览器半。`mode: "run"` 启动当前包或重启它，`mode: "update"` 切换到另一个包版本。`cordis_stop` 结束一次存活运行——移除该包的 handler 与任何已装载的浏览器 UI——同时保留可再次运行的定义；`cordis_undefine` 停止并忘掉它。

### 定义的去向

定义以会话为界、以进程为本：包只对定义它的会话可见，其他会话读起来是不存在，DSH 重启后一切都消失。会话日志保留一次 define 调用的参数——包括它提交的代码——以及回执；解析出的定义只存于内存注册表。浏览器半只能经一次运行到达页面，因此刷新后的页面手上什么都没有，直到有人再次运行该包。

### 信任立场

沙箱隔离全局变量，但不是安全边界：Node 全局变量不存在，或重定向到 Cordis 服务（`ctx.fs`、`ctx.web`、`ctx.bash` 与定时器 helper），host 半收到的是不含框架内部机制的 façade，但它声明的服务仍会触达存活运行时。对待动态包要像对待 bash 访问一样，参见[自引用工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 runner 背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

runner 建立在两个分离之上。**注册表与沙箱是同一个服务。** `DynamicCordisRunnerService` 拥有定义注册表、vm 沙箱、host 半 fiber 生命周期与 invoke handler 表，因此一个定义的整个生命周期只有一个 owner。**版本是不可变的包。** 插件持有 `define` 之后永不变化的包；`currentPackageId` 与 `nextPackageId` 指向运行中与目标版本，`mode: "run"` 与 `"update"` 编码目标是否等于当前版本。浏览器往返之所以存在，是因为浏览器半只能由页面执行：服务 emit 请求并挂起，由页面的结论结算，调用方的 `AbortSignal` 是唯一的另一条出路。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：`Config`、注册表接线、生命周期动词、steer 消息 |
| [`src/registry.ts`](src/registry.ts) | 定义存储：插件与包标识、运行尝试、审批请求 |
| [`src/sandbox.ts`](src/sandbox.ts) | `node:vm` 求值：全局变量、Node API 陷阱、define 时语法预检 |
| [`src/guard.ts`](src/guard.ts) | 注册边界：schema 规范化、沙箱 `ctx` façade、插件形态检查 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 在 `cordis-dynamic` fiber 组下启动 host 半 |
| [`src/inspect-registry.ts`](src/inspect-registry.ts) | `ctx.cordisInspect` 注册表：host provider 加镜像的 client manifest |
| [`src/types.ts`](src/types.ts) | `dynamicCordisRunner` remote namespace 与转发事件共享的 client 安全载荷形态 |

### 一次 run 的流程

`define` 对元数据做首尾去空白与必填校验，用编译预检每一半的语法（不执行任何代码），铸出插件与包标识，并把定义登记在发起调用的会话名下。`run` 对照 `currentPackageId` 与 `nextPackageId` 解析目标：纯 host 包在沙箱中求值并立即提交，带浏览器半的包则挂起一次审批请求、emit `cordis/request-run` 并挂起。作答页面依次走 `runHostHalf`、`getClientCode` 与 `resolveRequestRun`；命名存活 revision 的成功会提交激活、设置 `currentPackageId`，`cordis/request-run-resolved` 让其他每个页面撤下待作答入口。`stop` 回退存活下发——handler disposer、fiber dispose 与 `cordis/dynamic-retract` 广播——并让定义保持可运行。四条转发事件（`cordis/request-run`、`cordis/request-run-resolved`、`cordis/dynamic-package`、`cordis/dynamic-retract`）声明在 client 安全的 `./types` 子路径上，并由 `@deepseek-ai/dsh-api-remotes` 的白名单准许投递——正是这一点让浏览器能经 `ctx.remote.$on` 收到它们。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 runner 逐步进入调用它的工具、应答它的浏览器半与生成的表面。

- [工具包](../tool-cordis/README.zh.md)——调用本服务的模型侧工具。
- [Client runner](../cordis-client-runner/README.zh.md)——应答运行请求并装载浏览器半代码的浏览器半。
- [UI 包](../ui-cordis/README.zh.md)——用户批准并操作运行的面板。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-cordis-host-runner)——每个受支持配置字段。
- [extensions 子系统](../../../docs/subsystems/extensions.zh.md)——生成的 `ctx.cordisInspect` 与 `ctx.dynamicCordisRunner` API 及 `cordis/*` 事件。
- [自引用 Cordis 工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)——沙箱语义、生命周期与组合的理由。

-----

<a id="model-experience"></a>
## 模型体验

### 转达给所属会话的运行结果、拒绝与诊断

#### 模型看到的内容

没有直接可见的内容：本包不注册任何工具，也不注入提示词。当一次 run 结算时，它会 steer 所属会话——成功时点名当前包并指示继续，用户拒绝时指示不要再次请求同一激活，技术性失败则给出原因、版本指针与「检查—修正—更新」路径。它还会在结算后 steer 渲染失败（槽位、条目是否已被移除）、host guard 拒绝与 host handler 失败。面板上的停止与移除手势会注入一条 user 角色消息，说明用户做了什么。`run` 或 `stop` 的拒绝还会经调用它的工具结果到达模型。

#### Token 影响

有条件且随数据而定：消息只在事件发生时到达，每条都携带一段有界的说明；没有固定的每请求成本。

#### KV Cache 影响

本包自身没有。注册工具的 host 半会改变下一次请求的工具视图，从第一个变化的 schema token 起使前缀复用失效；运行或停止一个不注册任何工具的包对前缀不产生影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 runner 何时需要特别小心。它们是当前包约束，不是任务积压。

- **run 成功不等于 UI 渲染成功**——只要作答页面已装载浏览器半，`run` 就会返回；React 是随后才渲染的，因此抛异常的组件不可能出现在 run 回执里。该失败经 steer 与 `cordis_inspect_self` 诊断浮现。
- **带浏览器半的包在没有页面连接的地方挂起**——headless 与 ACP（Agent Client Protocol）部署会把 run 一直挂到提问的轮次被取消；纯 host 包不受影响。
- **挂起的 run 请求没有超时**——它一直等人，直到提问的轮次被取消，因此无人值守的自动化用不了带浏览器半的包。
- **`vmTimeoutMs` 只约束同步求值**——async 的 host 半函数体会逃出该上限，这与工具集基于协作的信任立场一致。
- **陈旧成功的拒绝会让请求继续挂起**——作答页面点名的 revision 已被注册表越过时，该结论会被拒绝（`accepted: false`），请求保持可作答，直到另一个页面作答或调用方取消；浏览器半不读这个 ack。
- **运行播报不携带服务声明**——浏览器半声明的 `inject` 是从它在页面里返回的插件上读出的，因此 `cordis/request-run` 只携带元数据，绝无代码或服务清单。
- **`zod` 是生成的 Typert 契约面的运行时依赖，不是 `src` 的依赖**——`./typert` 与 `./remote` 解析到未打包的 `lib` 文件，其中带有裸的 `import { z } from 'zod'`，所以即使 `src` 里没有任何代码 import zod，本包也要声明它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。definition registry 是无事件流的进程内存；运行 definition 与 host-half fiber/handler table 的关系在单个 awaited verb 内建立和释放。
