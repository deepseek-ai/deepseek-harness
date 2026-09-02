# Agent Note: Web 轮次过程折叠

Status: implemented

[English](2026-08-14-web-turn-process-folding.md) | 中文

## 问题

一个模型轮次可能会在最终正文之前展示系统提示词、上下文注入、推理、多条 Assistant 回复、工具调用与重试行。完整展示整条轨迹会淹没正文，而把独立 Chat Node 移入一个父级 disclosure 会重挂载有状态的工具 renderer，并扰乱按时间排列的证据。紧凑视图必须收起已完成的过程工作，同时在轮次仍处于推理、使用工具、重试或没有正文便结束时，保留当下唯一可用的证据。

## 决策

由 Host 支撑的 `ui-chat.transcriptView` 偏好提供 `normal` 与 `compact` 两种模式，默认值为 `compact`。Normal 保持所有过程行可见且不渲染轮次过程控件；Compact 应用下述 disclosure 规则。切换模式只改变 wrapper 可见性，不会重新挂接或卸载 Chat Node renderer；该偏好不写入 Session log。

在 Compact 模式下，轮次打开期间始终完整展开。到 `turn/end` 时，只有当最近步骤包含面向用户的 Assistant 回复内容——非空文本、图片或未知可见块——并且不含工具调用块时，该步骤才成为最终正文边界。正文保持可见。边界之前的上下文注入、推理、较早 Assistant 内容、工具行与重试行统一进入一条过程 disclosure。系统提示词、用户消息与 steering 消息保持独立，绝不加入过程组。已完成、已取消、已中断、失败和达到最大 token 的轮次使用同一终态投影；错误、最大 token 与 turn-tail 行留在过程组外。关闭时没有最终正文的轮次会保留全部过程证据。

轮次作用域的 `turn-process` Definition 根据日志事件与步骤 Location data 推导首条模型或工具证据、最近步骤的已定稿正文边界、该正文之前带回复内容的持久 Assistant 消息数和工具调用计数。随产品交付的 subagent 委派名称（`subagent` 与 `subagent_*`）只增加 subagent 计数，不增加普通工具调用计数，因此两类不会重叠。上下文注入仍是过程证据但不增加摘要计数；系统提示词保持独立、持续可见，并始终位于开场 User 上方。Definition 把同一份不可变 `TurnProcessSpec` 直接发布到 Turn Location data 与稳定控制 Chat Node；持续 open stream 的更新在字段不变时复用两份值。Chat target 从首次投影起就把开场 User 或 steering 输入放在过程候选之前，再把合成控制行插入该输入与过程行之间。没有开场人工输入时，控制行从首次出现起就位于最早的过程候选之前。因此正文定稿、Retry、后续步骤、完成状态与手动展开只改变可见性，不改变既有节点的相对顺序，具体规则由[稳定的轮次过程排序](../bug-fix/2026-08-26-stable-turn-process-order.zh.md)说明。

`ChatTurnProcessProjector` 拥有跨 Node 的呈现事实。只有 Node 结构、`TurnProcessSpec` 或 Turn 状态变化时，它才扫描受影响的 Turn；相等的呈现会按引用保留，且只有变化 Turn 内的 Seat 会收到稳定 process source 的发布。每个 Seat 从共享呈现判断自身的过程成员与正文角色，无需读取全局 Chat snapshot、扫描 Turn 或编码再解码签名。Turn 状态与已加载窗口是否完整共同决定能否折叠：打开中的 Turn 绝不折叠，历史不完整时也既不显示控件又不隐藏成员。控制 Node 从首条过程证据出现起一直存在，但其 Seat 会保持隐藏，直至关闭的 Turn 拥有最终正文且历史完整；显示后，它会省略每个值为 0 的分段，三项全为 0 时使用「已思考」（英文为 `Thought for a while`），并在摘要下方绘制通栏分隔线。

Chat target 通过共享 settings scope 绑定持久化的 transcript 偏好，并把逐轮交互状态保存在会话作用域的 Chat store 中。`ChatView` 通过稳定的 keyed `ChatNodeSeat` 直接渲染每个业务 Node；加入过程控件不会重排既有 key，Compact 模式只改变 Seat wrapper 的 `hidden` 属性，不会重新挂接或卸载工具、Assistant、上下文或重试 renderer。Seat 通过 `ChatNodeOwnerProps` 传递同一份过程状态，因此最终 Assistant renderer 会隐藏自身步骤中的推理块，同时保留回复块；wrapper 可见性与行内推理共用一个 UI 状态真源。

收起的过程成员使用 `hidden="until-found"`。在支持该能力的浏览器中，任一成员触发 `beforematch` 都会打开共享过程组。由于 hidden-until-found 成员会保留可搜索的零高度 box，Chat 列只在可见的相邻成员之间设置间距；控件分隔线横跨内容宽度，只有中间没有独立输入时，收起的过程控件才与正文相隔 8px，展开后恢复普通的 16px 行间距。收起的 Think 行通过 CSS 跟随最新流式文本行，具有随字号轴变化的单行固定高度，并启用 size 与 layout containment；展开时移除 containment，正文恢复自然高度。在 Compact 模式下，不持久化的会话 store 只保存用户手动展开的「Turn + 正文 Step」generation；没有记录即为收起，不同正文 generation 默认收起。因此，每个合格的已关闭 Turn 都使用相同默认状态，不区分实时完成、在「加载更早」后出现，或在读者离开尾部时结束。这可能在 Turn 关闭或历史变完整时让读者上方的内容重排。若自动收起会隐藏过程成员中的键盘焦点，则改为打开共享过程组并把焦点留在原处；手动收起会先把焦点移到过程控件，再隐藏成员。存在「加载更早」时，每个过程保持展开且控件隐藏；历史加载完整后，合格过程立即使用默认收起状态。页面重新加载会恢复持久化的 Normal 或 Compact 偏好；逐 Turn 手动展开只在同一页面生命周期内的 view remount 之间保留。切换到 Normal 会显示所有过程行，切回 Compact 时会在默认收起状态上重新应用当前页面生命周期内的手动展开记录。

这项展示与 [Conversation Node 组装](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)共同成立：Definition 持有确定性的过程事实，Seat 持有共享交互状态，keyed renderer 保持独立。[按日志顺序投影的人工 transcript](../bug-fix/2026-07-30-web-transcript-log-ordered-projection.zh.md)保持完整，因为折叠不改变任何会话事件或模型输入。

## 曾考虑的替代方案

**只折叠较早的 Assistant 回复。** 不采用：常见的 `Think → Tool → 正文` 轮次只有一个回复步骤，不会出现紧凑控件，用户要求收起的过程内容仍会完整展开。

**把上下文注入留在过程组外。** 不采用：注入的运行时上下文属于正文之前的轨迹，并不是一条新的人类指令；展开过程后，其自身的 disclosure 与标签仍完整保留。系统提示词则留在过程组外，因为移动或隐藏整次请求使用的指令会改变开场 User 周围的可见框架。

**把整个轮次重新挂接到一条摘要行下。** 不采用：折叠资格会在轮次运行期间变化，而把既有 Chat Node 移过 React 父节点会重挂载有状态工具视图。稳定 Seat 可以提供一个 disclosure，同时不移动其子节点。

**把手动展开状态存入轮次 Location data。** 不采用：Location data 是会话事件的确定性投影，不存在浏览器动作写入路径。UI 手势属于已声明且不持久化的 store。

**复用 `DisclosureRow` 并卸载收起成员。** 不采用：浏览器查找无法发现其文本，重新打开也会重建有状态 renderer 子树。

**在 `turn/end` 前折叠实时正文候选。** 不采用：流式文本后仍可能出现工具调用、重试或后续仅推理步骤。等待终态边界可以避免自动收起—展开—再次收起及其造成的布局跳动。

**读者离开尾部时暂缓刚获得资格的收起。** 不采用：该方案需要瞬时完成检测与 deferred 状态，并使相同的已关闭轮次根据进入视口的路径获得不同初始状态。已关闭轮次统一使用确定性的默认值；滚动锚定负责保持位置，焦点保护负责保留正在进行的交互。

## 后果

Compact 模式会在轮次正文前只有注入上下文、推理或工具时仍突出最终正文，展开后每条过程行按原顺序恢复；Normal 模式则保留完整 transcript 且不展示轮次过程控件。隐藏的 wrapper 与 Markdown 子树保持挂载，用一定浏览器内存换取稳定工具状态、跨视图重挂载的手动展开状态与浏览器查找恢复。只有 Compact 模式下的普通跨消息选择会排除仍收起的成员；用户可以先展开过程组，或切换到 Normal。不支持 `hidden="until-found"` 与 `beforematch` 的浏览器仍可手动展开，却无法通过页内查找揭示收起的过程文本。单元覆盖固定已定稿正文边界、重试与中断、跨 kind 共享展开、最终步骤推理、模式切换、手动展开、历史补全后立即收起、离尾收起、焦点保留与最终分页的纯数据更新；组装后的浏览器快照固定运行中、已取消、已完成、分页历史与持久化设置轨迹。
