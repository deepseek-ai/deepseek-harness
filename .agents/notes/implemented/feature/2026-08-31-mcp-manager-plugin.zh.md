# Agent Note: Plugin-registered MCP server manager

Status: implemented

[English](2026-08-31-mcp-manager-plugin.md) | 中文

## 问题

已安装的应用插件会带来自己的 MCP 服务器。每个插件都必须在不编辑用户配置、不依赖其他应用的前提下加入服务器，停用或卸载插件时还必须撤回该服务器的工具。管理界面需要显示每台服务器的连接状态，并恢复停止重连的服务器。`cordis.yml` 里每台服务器一条 `dsh-mcp-client` 行无法表达插件拥有的服务器；客户端插件除日志外没有任何状态出口，激活还继承了无界的 SDK 启动等待。

## 决策

`packages/mcp/mcp-manager` 是一个服务插件（`ctx.mcpServers`），依据插件注册对一支普通 `dsh-mcp-client` 子实例编队做对账；`packages/mcp/mcp-client` 拥有连接监督、状态与逐次启动预算。

**插件以副作用注册服务器。** `register(name, entry)` 为调用方插件的生命周期加入一台 Streamable HTTP 服务器，并返回该副作用的释放函数。因此插件管理器已有的启用、停用和卸载操作决定插件的服务器何时存在；注册的释放会等待实例卸载，插件的释放完成时工具已撤回。注册名共用一个命名空间；名字不合法或已被占用时，注册直接抛错。

**子实例是插件实例，不是库调用。** 每个注册经 `ctx.plugin()` 在管理器 fiber 下挂载 `dsh-mcp-client`。这复用了经过测试的激活/销毁语义，让 `serverName` 预留与静态组合实例正确冲突（以带可操作消息的 `failed`/`load` 状态浮出），并让管理器销毁经普通 fiber 收卷解除每个实例及其工具。

**注册决定实例。** 移除注册会销毁其子实例，`restart` 以全新的重连预算替换实例。对账与 `restart` 在同一操作队列中串行执行。管理器保留清理失败记录，并在 Host 重启前拒绝替换，防止服务器生命周期重叠。

**状态属于子 Fiber。** 监督器发布经 `connectionStatusOf(fiber)` 读取的状态单元。同一 Fiber 重载时保留该单元，最终销毁时移除观察者，但单元仍可读取。Fiber 身份直接区分不同注册作用域中的实例，无需在状态载荷中加入身份令牌。管理器把状态单元聚合为 `list()`，并吸收相等状态。注册已移除但清理未完成的服务器仍会列出。

**mcp-client 启动预算。** 独立客户端的 `startupTimeoutMs` 可省略；管理器为每个注册提供自己的 `startupTimeoutMs`（默认 30 秒）。

**管理器自身即 Remote 面。** `McpServerManager` 是 Typert Remote 服务：`watch` 在订阅时以及每次状态或注册变化后推送完整服务器列表，`restart` 调用宿主操作。管理器不提供写入方法，因此浏览器无法定义服务器。

OAuth 刻意不在本次范围内：凭据记录与 authorization seam 加 MCP SDK 的 `OAuthClientProvider` 是预期归宿，`needs-auth` 状态位为那次变更保留。

## 曾考虑的替代方案

**由 Settings 配置服务器。** 否决：经 Settings 编辑的 volatile `servers` 配置还需要 stdio 条目、`${credential:REF}` 模板、写入期跨字段校验、`enabled` 标记、探测，以及供管理页面使用的状态事件。没有产品界面写入这份配置，每个连接器插件都注册自己的服务器。

**把 `startConnection()` 当库调用而不挂子插件。** 否决：这会让生命周期与静态组合实例分叉，丢掉预留冲突检查，还要重造插件已在测试下证明的激活/销毁静默。

**让插件把条目写进管理器配置。** 否决：bundle patch 会替换整个映射，两个插件无法各自带一个条目；插件需要反查管理器的命名空间与 revision；配置写入在对账前返回，插件只能重启条目来等待，导致重复挂载；卸载插件后还会留下仍启用的条目，其工具继续生效。

**让 mcp-client 以 Cordis 事件广播逐实例状态。** 否决：preset 作用域实例可以重名，迫使事件载荷携带身份令牌。Fiber 所有的句柄直接识别实例，由管理器聚合这些句柄。

**让管理界面轮询状态。** 否决：`watch` 推送每次变化；发货了轮询的同类产品（Reasonix）或缺状态事件的（OpenCode v1）都把它当作待修缺陷。

**为「MCP 管理」开 capability seam（Definition/Provider/Consumer）。** 否决：只有一个实现、没有独立演化的角色；没有第二个 provider 的 seam 是无主的结构。

## 测试

mcp-client 单测覆盖状态迁移、启动预算、同一 Fiber 重载、销毁后可读状态、观察者异常遏制、取消，以及独立的关闭和清理结果。管理器测试使用真实 Cordis，覆盖插件注册及其名字冲突、restart、`watch` 流、清理失败保留，以及待完成工作期间的移除或销毁。真实 Loader 组合测试挂载组合内插件注册的服务器，并随该条目撤回。无密钥 e2e 验证真实 stdio 和 HTTP 服务器，包括崩溃恢复。两个包均满足逐文件 100% 覆盖率门禁。

## 后果

- 插件通过注册拥有自己的服务器；管理界面使用 `list()`、`watch` 与 `restart`。重连和 `restart` 恢复连接失败；清理未完成时需要重启 Host。
- 存活判断依赖传输关闭与请求失败；停滞但不关闭的 Streamable HTTP 服务器要等到请求失败时才会被发现。
- 被重启服务器的工具在替换连接完成首次同步前不可用。替换会等待传输确认关闭且本地清理成功。
- 管理器只治理全局面；preset 作用域与静态实例不在其列表内。
- `startupTimeoutMs` 只为启动尝试设界，通知驱动的重同步请求仍走 SDK 请求默认值——已记录为 mcp-client 的限制。
