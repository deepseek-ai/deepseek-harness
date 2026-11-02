# Agent Note: Settings-driven MCP server manager

Status: implemented

[English](2026-08-31-mcp-manager-plugin.md) | 中文

## 问题

一台 MCP 服务器就是 `cordis.yml` 里的一条 `dsh-mcp-client` 行。这对组合钉死的服务器是对的，但与产品目标相悖：要从 Web 界面在运行时添加、修改、测试、启用、停用、删除并恢复服务器，且每台服务器的连接状态可见。客户端插件除日志外没有任何状态出口，激活继承了无界的 SDK 启动等待，也没有任何"不挂载就测试一份配置"的途径。对六个同类 agent 产品（Claude Code、Codex、OpenCode、Kimi Code、DeepSeek-Reasonix、Pi）的调研收敛到同一形态：配置注册表、管理门面、带"状态到动作"映射的连接状态机，密钥绝不回读到界面。

已安装的应用插件也会带来自己的服务器。每个插件都必须在不编辑用户配置、不依赖其他应用的前提下加入服务器，停用或卸载插件时还必须撤回该服务器的工具。

## 决策

`packages/mcp/mcp-manager` 是一个服务插件（`ctx.mcpManager`），拥有 volatile `servers` 配置并对一支普通 `dsh-mcp-client` 子实例编队做对账；`packages/mcp/mcp-client` 拥有连接监督、状态、探测与逐次启动预算。

**配置由 volatile Config 提供，CRUD 不需要新 API。** Settings 按管理器条目的 Loader id 展示其 Config；ConfigEditor 拥有 profile 持久化、继承和 revision 检查。Settings 编辑保留继承的服务器，重置继承条目会恢复其基层值。直接编写 profile patch 会替换完整 `servers` 映射。Loader 先提交引用，再通知管理器现有的协调队列。

**插件以副作用注册服务器。** `register(name, entry)` 为调用方插件的生命周期加入一台服务器，并返回该副作用的释放函数；条目接受除 `enabled` 外的全部配置字段，并通过相同校验。因此插件管理器已有的启用、停用和卸载操作决定插件的服务器何时存在；注册的释放会等待实例卸载，插件的释放完成时工具已撤回。注册名与配置名共用一个命名空间：注册拒绝已配置的名字，设置写入拒绝已注册的名字。注册不进入 Settings。

**扁平条目 schema，跨字段校验。** 条目是带 `transport` 判别字段的扁平结构，写入期校验在写入处强制逐传输要求与拒绝（缺 `command`/`url`、跨传输字段、模板写错）——schema 合法但不可执行的条目永远不会被存下，且拒绝会点名出错字段，union 的形状错误做不到。

**子实例是插件实例，不是库调用。** 每个启用条目经 `ctx.plugin()` 在管理器 fiber 下挂载 `dsh-mcp-client`。这复用了经过测试的激活/销毁语义，让 `serverName` 预留与静态组合实例正确冲突（以带可操作消息的 `failed`/`load` 状态浮出），并让管理器销毁经普通 fiber 收卷解除每个实例及其工具。

**整条目决定实例；`enabled` 控制挂载。** 条目变化会重建子实例，停用或删除条目会销毁子实例。对账与 `restart` 在同一操作队列中串行执行。探测独立运行，配置变更先取消受影响的探测，再由队列中的清理操作等待它们结束。管理器保留清理失败记录，并在 Host 重启前拒绝替换，防止服务器生命周期重叠。

**状态属于子 Fiber。** 监督器发布经 `connectionStatusOf(fiber)` 读取的状态单元。同一 Fiber 重载时保留该单元，最终销毁时移除观察者，但单元仍可读取。Fiber 身份直接区分不同注册作用域中的实例，无需在状态载荷中加入身份令牌。管理器聚合为 `list()` 和 `mcp-manager/status` 事件，吸收相等状态并在销毁后停止发出事件。配置已删除但清理未完成的条目仍以 `configured: false` 列出。首次对账等待管理器自身 Fiber 激活，因为严格服务读取要求 Fiber 已激活。

**模板让密钥不进入配置。** 存储的 env 和 header 值仍可读，必须隐藏的值应使用模板。管理器把原始模板传入子 Fiber。mcp-client 显式启用模板展开后，从当前 provider 解析 `${credential:REF}`；其本地实现也读取继承的环境变量，因此没有单独的环境变量模板。缺失值使非严格客户端等待凭据，相关凭据通知可恢复连接。值变化时，连接只有在清理成功后才会替换；同值通知保留当前连接和重试预算。诊断、工具调用失败与 `isError` 结果保留上游文本，其中每个已解析的值都替换为 `[redacted]`，模型因此能依据服务器的错误行动，又看不到实例发送过的密钥。

**mcp-client 预算与探测。** 独立客户端的 `startupTimeoutMs` 可省略，管理器明确提供 30 秒默认值。`probeServer(ctx, config, options)` 连接、读取服务器身份、列出工具名并关闭，不预留名称，也不注册工具。探测有独立于运行期启动的预算和可配置的列表上限。探测成功与传输关闭分别报告，因此发现成功不会掩盖清理未完成。

**管理器自身即 Remote 面。** `McpServerManager` 是 Typert Remote 服务：`watch` 在订阅时以及每次状态或条目变化后推送完整服务器列表，`restart` 与 `probe` 调用宿主操作。配置写入仍走 Settings Remote，管理器不提供写入方法，因此浏览器无法定义服务器命令。

OAuth 刻意不在本次范围内：凭据记录与 authorization seam 加 MCP SDK 的 `OAuthClientProvider` 是预期归宿，`needs-auth` 状态位为那次变更保留。

## 曾考虑的替代方案

**把每台服务器作为独立 Loader 条目管理。** 否决：管理器需要包含状态、restart 与 probe 的统一服务器列表。Settings 与 ConfigEditor 已经为其字典提供继承、校验和 revision 检查；运行期子实例不需要独立持久化条目。

**把 `startConnection()` 当库调用而不挂子插件。** 否决：这会让生命周期与静态组合实例分叉，丢掉预留冲突检查，还要重造插件已在测试下证明的激活/销毁静默。

**让插件把条目写进管理器的 Settings 命名空间。** 否决：bundle patch 会替换整个 `servers` 映射，两个插件无法各自带一个条目；插件需要反查管理器的命名空间与 revision；设置写入在对账前返回，插件只能重启条目来等待，导致重复挂载；卸载插件后还会留下仍启用的条目，其工具继续生效。

**把 `mcp-manager/status` 转发给客户端，而不是推送列表。** 否决：Remote 事件载体只转发 `emit` 事件，而 `emit` 不隔离监听器失败；客户端还需要在每次事件后读取 `list()` 才能看到移除与授权状态。

**让 mcp-client 以 Cordis 事件广播逐实例状态。** 否决：preset 作用域实例可以重名，迫使事件载荷携带身份令牌。Fiber 所有的句柄直接识别实例，管理器提供唯一的聚合事件。

**让管理界面轮询状态。** 否决：Remote 面已转发宿主事件；发货了轮询的同类产品（Reasonix）或缺状态事件的（OpenCode v1）都把它当作待修缺陷。

**为「MCP 管理」开 capability seam（Definition/Provider/Consumer）。** 否决：只有一个实现、没有独立演化的角色；没有第二个 provider 的 seam 是无主的结构。

## 测试

mcp-client 单测覆盖状态迁移、独立的启动与探测预算、模板绑定与值替换、同一 Fiber 重载、销毁后可读状态、观察者异常遏制、取消，以及独立的关闭和清理结果。管理器测试使用真实 Cordis、profile 支持的 Settings 和内存 credential provider，覆盖配置变化、插件注册及其名字冲突、凭据轮换、探测取消、`watch` 流、清理失败保留，以及待完成工作期间的删除或销毁。真实组合测试验证继承服务器、profile patch、持久化设置编辑和写入期校验。无密钥 e2e 验证真实 stdio 和 HTTP 服务器，包括探测与崩溃恢复。两个包均满足逐文件 100% 覆盖率门禁。

## 后果

- 管理操作通过 Settings 对配置条目增/改/删/启/停，通过注册加入插件拥有的服务器，通过 `list()`、`watch` 和一条事件获取状态，通过 `probe` 测试。重连和 `restart` 恢复连接失败；清理未完成时需要重启 Host。
- 存活判断依赖传输关闭与请求失败；停滞但不关闭的 Streamable HTTP 服务器要等到请求失败时才会被发现。
- 被重建服务器的工具在替换连接完成首次同步前不可用。替换会等待传输确认关闭且本地清理成功。
- 管理器只治理全局面；preset 作用域与静态实例不在其列表内。
- `startupTimeoutMs` 只为启动尝试设界，通知驱动的重同步请求仍走 SDK 请求默认值——已记录为 mcp-client 的限制。
