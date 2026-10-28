# Agent Note: 以 Peer 为作用域的建连握手

Status: implemented

[English](2026-10-09-operator-scoped-connect-handshake.md) | 中文

## 问题

让自动化客户端自动订阅转发事件，会使只需调用方法的客户端也收到并回答人机交互。CLI 与 MCP 调用方需要独立参与和清理机制，而不改变浏览器认证或为每个浏览器赋予独立身份。

## 决策

浏览器保留现有签名 Cookie、根路径 launch token 交换、共享 `connection.browserPeer` 和恢复行为。只有 API 调用方通过 `GET /connect?token=<launch-token>&interactions=answer|none` 创建独立 Peer。该端点仅供 API 使用，默认 `none`，非法或重复声明返回 400，并保留 Host/Origin 检查和 token 认证。它返回 302、Remote Mux 目标地址和 API Cookie。

### 接纳与所有权

- Connect 在返回前发布 API Peer。签名 API Cookie 包含 authority、Peer 标识和签发／过期区间；交互参与模式属于有效 Peer，不再重复写入凭证字段。浏览器 v1 Cookie 保持有效，始终选择共享 Peer；API v2 Cookie 只选择已存在的独立 Peer。
- HTTP 校验 Cookie 并查找 Peer，不等待 WebSocket。Connect、HTTP 与 WebSocket 不要求跨传输的就绪顺序。
- 一条 API 生命周期 WebSocket 拥有 Peer。重复关联被拒绝；关闭时在异步释放完成前移除 Peer。之后使用该 API Cookie 的 HTTP 与重连请求被拒绝，调用方负责重新 connect。
- 已受理的 unary 请求保留请求级取消语义。生命周期连接关闭不会取消独立 HTTP 请求或已接受的 Session 工作。
- 浏览器 socket 不拥有共享 Peer。刷新、多标签页、重复打开启动 URL 和 Host 重启不需要每浏览器 Peer 的恢复或凭证复用机制。

### 接受的保留行为

API 调用方可能在 connect 后退出，始终没有建立 WebSocket。如果它没有执行其他工作，Peer 仅保留轻量身份、作用域与登记状态，不持有 socket、订阅或后台任务，可以保留到 Host 退出。不设置首次建联期限、空闲扫描或内存过期定时器；Cookie 过期在接纳时检查，与记录保留无关。反复放弃 connect 会累积轻量记录，这是已认证本地调用方场景下接受的成本。实际操作仍负责清理其获取的资源。

### 事件与 Client 范围

Client 仅在 `answer` 模式创建转发事件机制。Host 首先检查 `peer.signal.aborted`，随后在 `$events` 与 `$events/result` 两处检查 `peer.interactions`：无论 principal 是什么，`none` 都被拒绝。回答型 owner 收到转发的 waterfall，且只能从拥有事件流的同一 Peer 回答；回答型非 owner 仅收到经 RBAC 授权的广播，不能回答 waterfall。只有未取消的 owner 回答流计入在线回答客户端。浏览器仍是同一个共享回答方；本设计明确不区分不同浏览器凭证的身份。

非页面 Client 提供使用同一 API Cookie 与 Host 基址的 HTTP 和 WebSocket 传输。被动客户端独立于 unary 调用打开生命周期连接，也可以调用生成的原始流方法。它们不使用浏览器代际恢复辅助方法 `$stream()`：该方法在 `none` 模式立即拒绝。原始流失败直接结束；调用方负责重新 connect 和重试。既有回答型客户端的代际行为与 Host facts 下发不变，不另建 API 恢复系统。

## 备选方案

**也为浏览器创建独立 Peer。** 为保留多标签页行为，这需要凭证身份、重启重建和重复登录复用。浏览器调用方可以保持为同一方，因此保留原模型。

**升级后才发布，或在 unary 前等待 Mux 就绪。** 两者都会拒绝或延迟先到达的有效 HTTP。Connect 才是发布时机。

**建联期限和 pending/bound 激活状态。** 它们以定时器和状态转换竞争为代价回收轻量空闲记录。未使用的 Peer 可以留到退出。

**为被动调用方适配浏览器流恢复。** 这会把交互模式传入依赖代际的流消费者及其测试。原始流已支持 CLI/MCP 调用，被动调用方自行处理失败。

**仅客户端事件开关或 Host 全局配置。** 两者都不能强制独立参与规则。由已认证 Peer 提供 Host 检查的模式。

## 验证

Connection 测试覆盖 API 发布、Cookie 校验、闲置保留、连接所有权和不变的浏览器接纳。[Loader 测试](../../../../packages/api/gateway/tests/operator-connect.host.spec.ts)覆盖 HTTP 先于 WebSocket、重复关联、慢清理期间及时移除、unary 取消独立性和事件拒绝／所有权。[Node Client 测试](../../../../packages/api/gateway/tests/authenticated-node.client.spec.ts)覆盖认证传输、延迟建联和不使用被动恢复的原始流。

[录制审批场景](../../../../apps/web/tests/approval-composer.e2e.ts)在回答页面旁增加一个被动调用方。完整回放需要可用命令 sandbox 执行写文件；缺少该后端的本地环境无法验证最后一步。本次不改变 Session 格式或模型可见输入。

## 后果

未建联的 API 记录不要求及时回收；若为空闲 Peer 增加重资源，必须重新评估这一取舍。连接关闭或 Host 重启后，API Cookie 不能恢复 Peer。浏览器 Cookie 格式与认证行为保持不变，无需重新认证迁移。API 与浏览器 Cookie 使用同一 authority 专属名称，因此 API 调用方维护自己的 Cookie 存储，不在共享浏览器 Cookie jar 中交换凭证。任何 launch token 持有者都可以请求 `answer`；这是交互参与，不是用户隔离。

[双工流决策](2026-09-19-remote-duplex-stream.zh.md)继续定义 Peer 作用域和流帧格式。[浏览器认证决策](2026-08-24-browser-token-authentication.zh.md)保留浏览器 token、签名、authority 与有效期语义；本记录只增加独立 API 接纳。两份既有记录继续保留。
