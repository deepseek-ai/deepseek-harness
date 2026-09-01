# Agent Note: Settings-driven MCP server manager

Status: implemented

[English](2026-08-31-mcp-manager-plugin.md) | 中文

## 问题

一台 MCP 服务器就是 `cordis.yml` 里的一条 `dsh-mcp-client` 行。这对组合钉死的服务器是对的，但与产品目标相悖：要从 Web 界面在运行时添加、修改、测试、启用、停用、删除并恢复服务器，且每台服务器的连接状态可见。Web 面被刻意设计为不能编辑 loader 条目（插件清单只读），客户端插件除日志外没有任何状态出口，激活继承了无界的 SDK 启动等待，也没有任何"不挂载就测试一份配置"的途径。对六个同类 agent 产品（Claude Code、Codex、OpenCode、Kimi Code、DeepSeek-Reasonix、Pi）的调研收敛到同一形态：配置注册表、管理门面、带"状态到动作"映射的连接状态机，密钥绝不回读到界面。

## 决策

`packages/mcp/mcp-manager` 是一个服务插件（`ctx.mcpServers`），拥有 `mcp` 设置命名空间并对一支普通 `dsh-mcp-client` 子实例编队做对账；`packages/mcp/mcp-client` 补上了管理器需要的三个原语——状态面、探测与启动预算——其重连语义不变。

**配置即设置命名空间，CRUD 不需要新 API。** 管理器经 `installSection` 注册 `mcp`：自身组合条目是基层（可被用户文档覆盖、停用，但不可删除），用户层添加与覆盖条目，管理界面的每次写入都是带 revision 围栏的普通设置变更。外部 `settings.yaml` 编辑与 Remote 写入走同一条提交后 watch 的路径。

**扁平条目 schema，跨字段校验。** 条目是带 `transport` 判别字段的扁平结构，`validateServers` 在写入处强制逐传输要求与拒绝（缺 `command`/`url`、跨传输字段、模板写错）——schema 合法但不可执行的条目永远不会被存下，且拒绝会点名出错字段，union 的形状错误做不到。

**子实例是插件实例，不是库调用。** 每个启用条目经 `ctx.plugin()` 在管理器 fiber 下挂载 `dsh-mcp-client`。这复用了经过测试的激活/销毁语义，让 `serverName` 预留与静态组合实例正确冲突（以带可操作消息的 `failed`/`load` 状态浮出），并让管理器销毁经普通 fiber 收卷解除每个实例及其工具。

**整条目即身份；`enabled` 是唯一例外。** 任何字段变化都重建实例（实例配置在插件加载时捕获，原地更新不存在）；`enabled` 只切换挂载与否。所有生命周期操作——对账、`restart`、凭据重建——串行在一条操作尾巴上，挂载在异步模板解析后把条目与当前配置复核一致，解析中途被删除的条目不会留下孤儿实例。

**状态是按作用域的句柄，不是广播。** mcp-client 的监督器发布一个状态单元（带载荷的 `connecting`/`connected`/`reconnecting`/`failed`），随 `serverName` 预留一起注册，经 `connectionStatusOf(ctx, name)` 读取——与预留同样按作用域取键，Agent 作用域实例绝不泄漏进全局面，归属也无需在载荷里塞身份令牌。管理器把单元聚合为 `list()` 加 `mcp-manager/status` 事件（吸收相等状态、丢弃配置已不含的名字、销毁后静默）；其不变量伴生断言每次发出都点名活管理器所列出的服务器。首次对账等待管理器自身 fiber 激活，因为严格服务读取只对激活的 fiber 作答。

**模板让密钥不进文档，而文档保持可读。** 存储的 env 与 header 值不做 wire 脱敏：编辑器回显文档里存的原文，必须隐藏的值应写成模板。 `${env:NAME}` 与 `${credential:REF}` 在挂载时解析；引用缺失让那一台服务器失败并在消息里给出修复方式。凭据轮换通过静态扫描原始配置（而非追踪已挂实例的引用）来定位受影响服务器，因此那台因凭据缺失而挂载失败的服务器会在凭据存入时被治愈。

**mcp-client 增补。** `startupTimeoutMs`（默认 30 秒）为每次连接尝试加初次工具同步设界，关闭了继承 SDK 超时的缺口；`probeServer()` 连接、读服务器身份、列工具（16 页 / 512 名，超出报告截断）后关闭，不预留名字也不触碰 `ctx.tools`——对已存条目与未保存草稿一体适用的「测试该服务器」。

OAuth 刻意不在本次范围内：凭据记录与 authorization seam 加 MCP SDK 的 `OAuthClientProvider` 是预期归宿，`needs-auth` 状态位为那次变更保留。

## 曾考虑的替代方案

**把服务器作为 Web 可写的 loader 条目管理。** 否决：插件清单按既有决策只读，loader 条目属于组合面（preset、boot 审计）而非用户配置，settings seam 已拥有分层、校验、revision 围栏、脱敏与文件监听。

**把 `startConnection()` 当库调用而不挂子插件。** 否决：这会让生命周期与静态组合实例分叉，丢掉预留冲突检查，还要重造插件已在测试下证明的激活/销毁静默。

**让 mcp-client 以 Cordis 事件广播逐实例状态。** 否决：preset 作用域实例会以相同名字发事件，迫使载荷携带身份令牌；按作用域的句柄以预留自身的生命周期给出精确归属。管理器的单一聚合事件是唯一广播面。

**让管理界面轮询状态。** 否决：Remote 面已转发宿主事件；发货了轮询的同类产品（Reasonix）或缺状态事件的（OpenCode v1）都把它当作待修缺陷。

**为「MCP 管理」开 capability seam（Definition/Provider/Consumer）。** 否决：只有一个实现、没有独立演化的角色；没有第二个 provider 的 seam 是无主的结构。

## 测试

mcp-client 单元（`tests/status.spec.ts`、`tests/probe.spec.ts`，SDK mock）：全部状态迁移含预算耗尽、关闭重连、启动预算两个阶段、连接期即关闭的无错误中断、观察者遏制、销毁移除句柄，以及探测的阶段分类、上限、预算与关闭遏制。管理器单元（`tests/manager.spec.ts`，真 cordis + 真内存 settings/credential provider）：无 settings 时的基层回退、设置驱动的增/重建/停用/删除、restart 语义、模板解析与失败、凭据轮换重建（含治愈挂载失败的用例）、以 `failed`/`load` 浮出的 serverName 冲突、解析中途删除的中止、陈旧激活回调、销毁先解除工具再拒绝操作、排队对账输给销毁时被遏制并记录。不变量 spec 证明发出契约可以失败。真实组合（`tests/composition.spec.ts`）：Loader 启动的 `cordis.yml` 配文件设置 provider——基层服务器挂载，外部 `settings.yaml` 编辑热加第二台服务器的工具。E2E（`mcp-client.e2e.ts`，无密钥）：对真实 stdio fixture 服务器与死命令探测。覆盖率在两个包上保持逐文件 100% 门禁。

## 后果

- 八项管理界面操作分解为：增/改/删/启/停 = 设置写入（无新 API）；状态 = `list()` 加一条转发事件；测试 = `probe`；恢复 = mcp-client 重连加 `restart` 作为 `failed` 终态的手动出口。后续的 Remote 控制器与 Web 分区恰好消费这一表面。
- 被重建服务器的工具会消失到新实例完成首次同步为止；滚动换代（先起新代再销毁旧代）是已知的开放方向。
- 管理器只治理全局面；preset 作用域与静态实例不在其列表内。
- `startupTimeoutMs` 只为启动尝试设界，通知驱动的重同步请求仍走 SDK 请求默认值——已记录为 mcp-client 的限制。
