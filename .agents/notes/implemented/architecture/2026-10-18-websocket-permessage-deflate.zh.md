# Agent Note: 用 permessage-deflate 压缩 Remote 流 WebSocket

Status: implemented

[English](2026-10-18-websocket-permessage-deflate.md) | 中文

## 问题

Web GUI 的所有实时 Remote 流共用一条物理 WebSocket `/api/remote.mux`：模型 token 增量、session 事件、工具输出、终端输出，以及 `$events` 广播。这条 mux 本身是已实现的 [Remote 双工流](2026-09-19-remote-duplex-stream.zh.md)设计，本 Note 只给它加一个传输选项。Host 的 HTTP 面已经暴露 `compression: 'none' | 'gzip'`；在此选项之前 WebSocket 没有对应能力，链路因此从不压缩。

走隧道、反向代理或被接纳的公网地址时，大 JSON 帧——会话回放、长工具输出、终端滚动历史——占掉的带宽协议本来就能省下来。浏览器在升级握手时本来就会主动 offer `permessage-deflate`，缺的只是服务端这一半。

## 决定

Gateway Config 增加一个字段 `websocketCompression: 'none' | 'deflate'`，默认 `'deflate'`，把解析后的布尔值交给 mux。mux 用以下传输选项构造 `WebSocketServer`，并在发送时逐帧决定是否压缩：

| 选项 | 取值 | 理由 |
|---|---|---|
| 帧压缩阈值 | `1024` 个 JSON 文本字符，由 mux 在发送路径判定 | `ws` 在开启上下文接管时会忽略自己的 `threshold` 选项（[上游 41ae5631](https://github.com/websockets/ws/commit/41ae5631)），因此 mux 逐帧传入 `compress`；少于 1024 个字符的帧（多数 token 级 `item` 帧）不压缩，也不进入 zlib 线程池 |
| `perMessageDeflate.zlibDeflateOptions.level` | `1` | 交互帧优先延迟而非压缩率；本仓库 HTTP gzip 默认也是 `1` |
| 上下文接管 | `ws` 默认（双向开启） | 重复 JSON 压缩率最好，不必逐帧重建字典 |

mux 构造函数接收一个 options 对象，携带 `heartbeatIntervalMs`、`streamInboxBytes` 与 `compression`，因为配置词汇由 Gateway 解析，`stream-server.ts` 不认识 `'none' | 'deflate'`。

客户端零改动：浏览器 API 本来就会 offer 该扩展，Node 载体用的 `ws` 默认 `perMessageDeflate: true`，完全不 offer 的客户端拿到的就是不压缩的升级响应。

### 协商与降级

| 对端 | 结果 |
|---|---|
| 浏览器（`client/connection` 打开原生 `WebSocket`） | 协商成功，双向压缩 |
| Node `ws` 载体（测试、认证的 Desktop 调用方） | 协商成功，双向压缩 |
| 不 offer 该扩展的客户端 | 升级成功但不带 `Sec-WebSocket-Extensions`，帧与不压缩连接一致 |
| 新 Host 配旧 Client，或反过来 | 没有协议变更；扩展按连接、可选协商 |
| `websocketCompression: 'none'` | 不协商扩展；帧不压缩 |

### 失败与容量

| 情形 | 行为 |
|---|---|
| 缓冲的上行超过 `streamInboxBytes` | 仍以 `gateway/uplink-overflow` 失败该逻辑流；预算统计的是解压后的帧字节，语义不变 |
| Ping/Pong 心跳 | Ping 周期不受影响：控制帧从不压缩，活动判据中 Pong 与收到帧这两支不变 |
| 下行写入活性 | 阈值以下的写入保持同步，只有本机发送缓冲区已满时才计为对端活动；JSON 文本达到 1024 个字符的帧异步压缩，其写入完成会计为缓冲活动 |
| zlib 打满 | 压缩跑在 libuv 线程池、受 `ws` 全局并发限制约束；事件循环不被阻塞，但线程池容量与文件 IO 共享 |

## 备选方案

**用 gzip 压缩帧。** 否决：WebSocket 没有 gzip 帧格式，RFC 7692 只注册了 `permessage-deflate` 这一种逐消息压缩扩展。

**让客户端决定。** 否决：浏览器 `WebSocket` API 不暴露扩展参数，也没有关闭协商的手段，这个决定只能落在服务端。

**照 HTTP 面配齐 `compressionLevel` 与 `compressionThresholdBytes`。** 暂缓而非否决：目前没有测量依据支持暴露调优旋钮，而仓库既禁止把真正的可调项藏进常量，也禁止投机式配置。等某个部署需要不同取舍时再加字段。

**无条件开启压缩。** 否决：这个选择随部署变化——本地 loopback 部署付出 CPU 却换不到带宽，必须能关掉，这正是 Config 字段的用途。

**只压下行。** 否决：该扩展按连接协商并同时作用于两个方向，单向接受不可表达，何况上行帧本来就小。

## 后果

压缩为走隧道、反向代理或被接纳公网地址的大 JSON 帧省下带宽。少于 1024 个字符的帧不进入 zlib 线程池，上下文接管跨消息保留字典，因此重复 JSON 的压缩率好且不必逐帧重建。

**线程池争用。** zlib 与文件 IO 共用 libuv 线程池。1024 字符阈值把小的流式帧挡在外面；线程池打满时被延迟的是压缩帧，事件循环仍不被阻塞。

**每连接内存。** 每条协商成功的连接在整个生命周期内持有 deflate 与 inflate 一对上下文。每个浏览器标签页一条 socket 时，内存与打开的标签页成正比；如果实现预期大量空闲标签页，应先测量再默认开启。

**loopback 无收益。** 最常见的本地部署只多付 CPU，所以才有这个字段；默认值是为远端与隧道场景选的。

**默认值未经测量。** `'deflate'` 这个默认值依据的是 HTTP gzip 的先例与远端场景，不是开/关两态的字节与延迟对比。做过对比后要记录结论，本地开销若明显则重新考虑默认值。

**写入活性被削弱。** 压缩后的下行写入在 `ws` 完成 deflate 并写出时即完成，而不是等到 TCP 对端确认数据，因此持续压缩下行会把写入计为缓冲活动并推迟心跳超时终止。心跳规则及其代码未改动。

Gateway 单测钉住默认协商、不协商、不支持扩展的客户端、逐帧阈值与压缩写入的活性后果；配置默认值与生成的 config catalog 在同一次改动中更新。
