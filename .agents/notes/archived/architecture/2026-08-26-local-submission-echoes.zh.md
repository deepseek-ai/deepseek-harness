# Agent Note: 基于 prompt rpcId 的本地提交回显

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-local-submission-echoes.md) | 中文

## 问题

多图 prompt 在客户端序列化加 host admission 上要花数秒，durable `user/message` 在此之前不存在，会话在此期间什么都不显示：composer 冻结为只读，消息在整条流水线结束后才出现，用户无法判断提交是否已经开始（#3003）。durable event 无法提前，Model-visible ⟺ logged 要求 `user/message` 只能在全部附件持久化后落盘，因此可见的提交必须与 durable 的提交解耦。

## 决定

**Session 对象持有客户端本地的提交回显，用 prompt 现有的 `requestId`/`rpcId` 关联。**`session.beginSubmission` 在调用方序列化任何内容之前，同步把 `{requestId, text, images: previews}` 写入 `SessionSnapshot.pendingSubmissions` 并翻转 `promptAttempted`；同一个 `requestId` 随 prompt RPC 发出。没有新关联 id，没有 wire 类型改动，也没有 session log 改动：host 本就把 prompt 的 `requestId` 写进 durable user source 的 `rpcId`，queue 投影现在把它作为 `SessionQueuedItem.rpcId` 携带，覆盖落进 inbox 而非 log 的 prompt（运行中 turn 的提交）。

**退休由观察驱动并延迟一帧；显示去重是渲染期的声明式规则。**Session 在带其 rpcId 的 durable `user/message` 或 queue occurrence 到达时（append、窗口安装或 control frame）标记回显为已观察，并在一个动画帧之后移除，晚于先注册的会话组装帧。ChatView 独立地隐藏 rpcId 出现在已渲染 user/steering 节点或 queue 行中的回显，因此无论 store 更新顺序如何，每一次渲染中回显与 durable 恰有一个可见。带标识的 prompt 失败、`abandon()` 或销毁使回显立即按 failed 退休；先到的 settlement 生效。

**队列操作要求观察到 Host 身份。**排队回显显示发送状态，并在正式队列行的相同位置显示禁用的编辑、删除和插话按钮。折叠后的队列在标题栏保留该状态。单独的 prompt 确认不携带队列项身份，因此只有关联的 Host 队列行到达后才启用适用的操作。这使缓慢受理的状态可见，同时避免把本地请求 id 当作可修改的 Host 队列项。

**Composer 乐观提交。**Enter 在一个 machine 事务里清空草稿、occurrence 表和撤销历史，phase 保持 `plain`；发送作为 detached attempt 运行，允许并发发送，唯一的冻结 in-flight 槽只留给命令。多个 detached 发送失败时，只要 composer 为空或仍是上一次自动还原的内容，就按提交顺序合并还原；用户编辑后停止这一轮自动还原。草稿图片由 detached attempt 持有到回显退休，因此图片离开 rail 后销毁 Session scope 仍能释放它们。回显以 observed 退休时，`HistoricalImageCache.seed` 把每个预览 URL 挂到 admitted 引用名下。缓存同步公开预览 URL，同时读取 durable 附件；读取完成后用规范化 URL 替换预览，并按各自生命周期撤销两个 URL。直接 subagent continuation 不注册回显，因为它的 transport 会分配另一个 RPC id，而且不支持图片输入。

客户端图片编码从同步分块 `btoa` 循环换成 `FileReader.readAsDataURL`（原生编码）。browser→host 传输仍是一个 base64 JSON 整包；#2885 剩余的传输改造不在本决定范围内。

## 后果

普通文本与图片 prompt 点击提交后会在当帧显示消息并让 composer 落底，admission 时机不变。默认发送不再冻结 composer，发送期间可以继续输入和提交；machine 的 `submitting` 阶段只用于命令提交。RPC 响应丢失但 admission 已成功的 prompt 通过观察确认结果，不会重复发送。图片在 durable 字节返回前显示本地预览，随后显示 host 保存的版本，中间没有加载占位。

## 验证

Session client spec 覆盖同步插入、requestId 透传、event、queue 与窗口观察、queue 和 durable 同时观察时只退休一次、延帧移除、abandon 与销毁。Machine 与 shell spec 覆盖乐观提交、并发 detached settlement、多个失败按提交顺序还原、图片纯发送的取消，以及图片随 scope 销毁而释放。ChatView spec 覆盖流尾渲染，以及回显仍在 snapshot 时按节点和队列去重。Host control spec 覆盖 queue rpcId 投影；缓存与附件 spec 覆盖 seed 首帧显示、规范化替换和 URL 撤销。connection fixture 回显 `requestId`，`fresh-round-trip` 的 recorded-session snapshot 在 durable admission 前记录本地回显。

## 考虑过的替代方案

**新增 `clientSubmissionId` 贯穿 wire 与 user source。**否决：`requestId` 已端到端存在（`user-rpc` source 成员），第二个 id 会重复关联并平白触碰 wire 校验。

**事件入库时同步移除回显。**否决：会话组装按动画帧发布，同步移除会让消息空一帧。steering 队列镜像历史上接受了这个竞态；回显路径用渲染期去重加延帧退休消除它。

**把回显作为合成节点走会话 assembler。**否决：assembler 只由 durable session event 驱动，客户端专属的节点 kind 会把闭合的 `ConversationNode` 联合扩进每个 target 的 `assertNever`；`PartialAssistant` 式的旁路状态符合现有先例。

**保持 composer 冻结，只加回显。**否决：issue 验收要求连续与并发提交，冻结的 composer 会重新引入回显本要消除的卡顿感。
