# Agent Note: Client 连接持续恢复

Status: implemented

[English](2026-09-05-continuous-client-recovery.md) | 中文

## 问题

generation source 可能一直挂起，既不报告就绪，也不报告载体失败。仅告警会让 Client 无限等待。有限次数的自动重试还会使页面在 Host 从较长中断恢复后继续保持断连，即使浏览器网络状态从未变化。

## 决策

[`ConnectionController`](../../../../packages/client/connection/src/client/connection.ts) 同时拥有握手就绪期限和持续重试调度。默认情况下，握手在三秒后报告 Host 响应缓慢，在十五秒后中止。告警提供早期反馈，同时保留需要数秒才能就绪的 Host；硬期限限制每次尝试的时长，并在取消 generation 时记录超时。告警与取消时间相互独立，因此缩短硬期限不需要同时修改两个字段；排定在握手结束之后的告警会被取消。取消会传到 generation source，后者必须释放资源并结束，下一 source 才能启动。已取消 source 迟到的 ready 回调不能建立 generation。

重试上限从 500ms 开始，经过 1s、2s、4s、8s 增长到 10s，保留现有 50–100% 抖动。达到最大上限后失败仍继续重试。把最大延迟与重试次数上限分开，与 [Socket.IO Client 选项](https://socket.io/docs/v4/client-options/#reconnectionattempts)的区分一致；DSH 保留自身的 Remote stream 协议和唯一调度器。Controller 每要求一次尝试，Gateway 就替换一次物理 socket。仍在等待打开的 WebSocket 候选，以及已打开但未收到首个 ready 帧的 socket，都能通过此路径恢复。

Host Connection 插件校验配置中的 `recovery`，通过 `webserver/index-inject` 把已解析且不含秘密的时序数据注入每个页面。Client 在提供 Connection 之前校验启动输入；直接传给循环的选项可覆盖这些值。定时器值必须是浏览器定时器范围内的正整数，退避因子必须是至少为一的有限数。共享解析器显式拒绝仅靠范围比较无法排除的 `NaN`。一表示以固定上限持续重试。Host 时序配置的变更适用于随后加载的页面。

Settings 指示器把活动恢复标为**自动重连中**，并始终提供**立即重连**。本决策取代[Web 连接恢复控制](../../archived/feature/2026-08-28-web-connection-recovery-control.md)中的终态重试策略。该记录仍拥有手动恢复、浏览器离线暂停、唯一调度器规则与指示器展示。只有新的 `$events` ready 帧才能建立连接状态；各域的 stream 保留各自的 baseline 与 cursor 恢复方式。

## 考虑过的替代方案

**仅拒绝就绪等待。** Controller 仍会等待 source 结束才重试。硬期限必须同时取消 source，否则同一个挂起的工作仍会阻塞恢复。

**三秒后取消每次握手。** 这会把 Host 响应缓慢的反馈等同于失败，反复丢弃合法的较慢握手。分别配置告警与取消时间，可在有界时长内保留完成机会。

**有限序列结束后停止重试。** 没有后续用户或浏览器事件，页面就无法发现 Host 已恢复。对间隔封顶可以限制流量，同时保留自动恢复。

**不等待取消清理就启动另一个 source。** 重叠的 generation 可能保留 listener 并投递过时事件。source 的取消契约要求它结束；放弃等待不能证明清理完成。

## 后果

长时间中断期间保留唯一重试调度，并以有界频率产生连接流量，直到恢复、显式停止或浏览器离线暂停。永久无效的凭据仍需用户处理；连接重试不会刷新凭据，也不会重放一元修改操作。立即就绪仍会重置退避，浏览器离线仍决定暂停；稳定连接后的重置窗口和本地载体例外属于独立策略变更。

## 测试

Controller 测试覆盖超过原终档后的恢复、固定上限重试、慢就绪、期限取消、延迟清理、迟到 ready，以及握手期间手动重连或停止。Host 和 Client 测试覆盖时序传递、无效输入及注入销毁。Gateway 测试使用真实 Controller 和事件 pump，配合可编排的 WebSocket，验证两个握手挂起阶段、物理替换及唯一恢复 reset。录制 Session 的 Web 生命周期场景覆盖超过原停止点后的自动恢复、手动替换挂起握手，以及本地化恢复展示。
