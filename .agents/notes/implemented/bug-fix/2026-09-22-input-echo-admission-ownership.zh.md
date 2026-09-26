# Agent Note: 输入回显在入档期间保持展示归属

Status: implemented

[English](2026-09-22-input-echo-admission-ownership.md) | 中文

## 问题

空闲时提交的输入可能先显示为 Chat 本地回显，再变为 QueueDock 的 Inbox 行，最后才显示为持久用户消息。Inbox 投影与会话历史独立到达：受理时回收回显会在入档前留下空档，迟到的 Inbox 投影又可能重复显示已经入档的消息。此外，turn/start 先于 user/message，因此空过程标题可能先出现在回显前面，真实输入到达时再与它交换位置。

这些转换涉及展示归属，而非滚动或 composer 几何。延迟不能判断哪种表示已经成为权威，将所有回显移到过程标题前又会把运行中的 steering 移到已有工作之前。

## 决策

- 提交保留本地发送时选择的 placement：空闲输入留在 Chat，运行中的 steering 留在过程末尾，明确排队的输入留在 QueueDock。Inbox 受理不改变展示归属。
- Chat 在同一次渲染中按持久输入的 rpcId 隐藏回显，并排除匹配已入档本地 Chat 提交的旧 next-step Inbox 行。QueueDock 只排除匹配本地 transcript 回显的 Inbox 行；其他排队消息仍可见且可操作。
- Session 保留已入档 transcript 或 steering 提交的本地排除身份，直到 Inbox 投影水位达到其领取序号。随后，较高序号投影优先的规则阻止旧受理行在该身份回收后重新出现。领取跟踪和取消共用已有逐提交 receipt，并覆盖两种 Inbox target；不新增 SessionSnapshot 字段、Host 事件或持久格式。
- Chat 末尾为进行中且没有真实输入的过程控制行时，第一条 transcript 回显显示在控制行前，其他回显留在末尾。最后输入的轮次信息复用现有 rpcId 扫描，不新增历史遍历，也不预测未来轮次序列。
- 待处理气泡与持久节点容器共用一个 keyed React 列表。插入过程标题保留回显气泡的挂载身份。入档后，由持久节点决定排序及普通 Group 切分。

[持久 Inbox 恢复决策](2026-08-17-durable-web-queue-recovery.zh.md)仍负责冷读取、重建与投影传输。[通用文件上传决策](../feature/2026-08-26-generic-file-upload.zh.md)仍负责附件准备及草稿恢复；回收按附件顺序返回各提交的持久引用，且只回调一次。

## 考虑过的替代方案

**固定延迟 QueueDock 或回显回收。** CPU 降速、传输批处理与投影到达顺序都可能超过该间隔。时间不能证明入档，也不能确认过期队列状态已经消失。

**只延长回显生命周期，不调整其他读取方。** Chat 侧按 Inbox 去重仍会移除回显，QueueDock 仍可能展示同一消息。Session 生命周期、Chat 接管和 Dock 排除必须一致。

**user/message 到达后立即删除排除身份。** 较晚的 Inbox 受理投影会复活 Dock 行或待处理 steering 行。领取水位提供必要的排序依据，不要求两条流同时发布。

**把全部待处理输入移到最新 Turn 控制行前。** 运行中的 steering 属于已有过程内容之后，多条普通提交也可能属于不同轮次。只有第一条本地 transcript 回显参与空控制行前的定位调整。

**新增 Host 关联事件或客户端 Turn 调度器。** 精确预测跨客户端竞争和请求乱序会超出本地乐观展示的范围。持久入档仍是权威；这些竞争场景中的乐观排序有意保持近似。

## 验证

| 证据 | 覆盖行为 |
|---|---|
| [Session 提交](../../../../packages/api/session-controller/tests/session-pending-submissions.client.spec.ts) | 投影先到与历史先到的接管、领取水位、开场/排队/steering 身份交错、附件回调、取消、未入档结束、重连基线及销毁。 |
| [投影存储](../../../../packages/api/session-controller/tests/projection-store.client.spec.ts) | 缺失或缓存水位、单调序号保留及清理。 |
| [Chat 渲染](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) | 同帧 rpcId 替换、回显稳定挂载、三种模式下标题先于输入到达、steering 留在标题之后、历史空轮次及六种本地与 Host 排列。 |
| [QueueDock](../../../../packages/client/ui-conversation/tests/queue-dock.client.spec.tsx) | 本地 transcript 排除、其他行及操作、三条消息的全部六种受理顺序及后续 FIFO 领取。 |
| [录制 Web 回放](../../../../apps/web/tests/idle-submission-handoff.e2e.ts) | 真实 Web 装配配合保留 FIFO 的投递屏障：6× CPU 降速下的 Inbox/历史两种到达顺序、明确的 turn/start 至 user/message 空档，以及六种请求排列的完整三轮接管。 |
| [Steering Web 回放](../../../../apps/web/tests/steering.e2e.ts) | 本地快捷键 steering 的持久入档先于 Inbox 领取投影到达时，仍只显示一份。 |

单条输入回归在修复前失败：Inbox 受理将气泡移入 Dock，单独交付的 Turn 标题又会出现在回显之前。修复后的路径保留唯一的 Chat 表示，且纵向位置稳定。多输入回放验证持久顺序及无重复、无残留回显，不断言乐观排列可以预测 Host 顺序。

## 后果

- 没有本地提交身份的 steering 仍按 Inbox 投影显示；投影迟到时可能短暂与持久节点重复。本地去重不为其他客户端的提交增加历史扫描。
- 重连可撤销已有接收回执的乐观回显，并展示新的权威基线。已领取但不在该基线中的输入可能短暂无气泡；重连不保证 DOM 连续性。
- 本地 running 更新前连续提交的消息可能都留为 transcript 回显。若本地按 A、B、C 提交，但 B 或 C 先入档，持久接管会调整可见顺序。即使 A 先入档，其余本地回显也可能与 Host 队列顺序不同。
- 跨客户端竞争和请求准备的先后差异可能改变实际开场输入。客户端不会仅因 Host 将输入排在另一轮后面，就把已按空闲分类的回显迁入 Dock。
- 这些改动消除普通在线路径中表示切换带来的抖动，不改变模型输入、Inbox 调度、滚动跟随规则或已发布 Session 数据。浏览器屏障证明行为，不代表普遍的延迟或吞吐提升。
