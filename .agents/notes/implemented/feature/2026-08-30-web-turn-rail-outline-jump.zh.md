# Agent Note: 基于大纲投影与跳转分页的整会话轮次导航栏

Status: implemented

[English](2026-08-30-web-turn-rail-outline-jump.md) | 中文

## Problem

Web 聊天的轮次导航栏从已加载的事件窗口推导刻度，而窗口是日志的分页后缀（50 条 message 的尾页，每次 `加载更早` 一页）。长会话里导航栏因此只列出最近的轮次：尚未分页载入的历史对导航不可见，除了反复点 `加载更早` 无法到达，且导航栏把已显示的刻度按百分比压缩进固定外框，多轮会话退化成不可读的密集条带。

## Decision

三个相互配合、各自独立可用的部分。

**数据：`turnOutline` 会话投影。** `packages/session/session-turn-outline` 在 `ctx.sessionProjections` 上注册一个纯 fold：每个 `turn/start` 追加一个条目（跳过未推进轮次号的边界，保持大纲严格递增），该轮首条人类 `user/message` 填入提示词预览，最新一条带文本的 `assistant/message` 缓冲为回复草稿、由 `turn/end` 提交（`turn/end` 自身不带文本）。预览预算对齐导航卡片的截断——提示词一行 50 字符、回复至多三行 120 字符、被裁剪时补省略号——并与已加载轮次的预览一致，同一轮在事件载入前后显示相同的文字。wire 值是裸条目数组，纯草稿的状态变化因此保持其身份，配合下述变更流身份门把推送压到每轮三次：开轮、提示词、落定回复。值搭现有投影载体——尾页 seed、`session/projection` 控制帧、projcache——web-app bundle 挂载该插件。`seq` 是 `turn/start` 事件的 seq：loop 先记它再记该轮的提示词与步骤，窗口向后分页越过该 seq 即载入整轮。

**变更流身份门（session-projection）。** 每个实时单元 cell 保存 `[previousView, currentView]` 原始输出。state 引用变化时，drive 先把 current 移到 previous；存在变更 listener 时只计算一次 `view(nextState)` 并写入 current，两个输出通过 `Object.is` 判定为不同时才发出通知。没有 listener 时不计算 `view`，而是把 current 写成 `undefined`，因此之后首次计算出的值会保守地发布；补折叠也以相同方式使 current 失效。这让单元可以把工作字段（回复草稿）缓冲在身份稳定投影之后的 state 里，而不是每条流式助手消息都推送整值；view 每次新建对象的单元不受影响。备选——在载体侧按序列化比较去重——被否决，因为每次安静变化都要付一次完整序列化。

**分页：`Session.loadThrough(seq)`。** session-controller 客户端在 `loadOlder()` 旁新增跳转加载器：按 200 条 message 一页（`JUMP_PAGE_MESSAGES`）循环现有 prepend 分页器直到 `baseSeq <= seq`，跳转中再次调用会下调共享低水位目标，遇到 `baseSeq` 未动的页即停（对空页仍声称有历史的无进展守卫），忙碌状态复用现有 `loadingOlder` 快照位。零 wire 改动：seq 稠密，客户端仅凭 `beforeSeq` 算术即可。

**视图：合并、跳转与固定间距导航栏。** `mergeTurnRailItems`（ui-chat，视图层——会话快照仍不携带投影值）把大纲与已加载条目并成以 `anchor: loaded(key) | unloaded(seq)` 判别的 `TurnRailItem`；同轮已加载者优先，大纲提示词填补窗口头部半轮的空预览。激活未加载刻度在点击当下即交出钉底所有权（跳进历史就是离开活跃尾部；否则钉底吸附与首个 prepend 补偿的竞态会触发 `toBottom` 取消跳转），再用现有分页锚点稳住读者位置、调用 `loadThrough`、在 React 提交后落点——不做任何高度估算：分页中途的落点把目标行钉为分页锚点，后续分片与 `加载更早` 按钮的卸载都不会使落点漂移，加载器完结时再做一次最终校正，除非读者已主动滚离目标（settlement 否则按窗口头每前进一次重发一次分页，再兜底落到最近的已渲染轮次）。导航栏本身保持固定 10px 间距：阶梯在原外框几何内隐藏滚动条滚动，渐变淡出标示仍可滚动的端点，悬浮预览补偿导航栏滚动量，指针不在栏上时活跃刻度自动保持居中。未加载刻度以短而暗的形态呈现，标签为「加载并跳转到第 N 轮」，其跳转分页期间脉冲闪烁。

## Alternatives considered

**稀疏/分段窗口**（只加载目标轮附近）：拒绝——窗口连续性是 transport 校验、assembler、timeline 与滚动锚定共同依赖的地基；不连续窗口是另一套架构，推迟到会话规模超出全量分页时再议。

**wire 上加 `minSeq` 页边界**（单发定向请求替代客户端循环）：v1 拒绝——循环零协议改动、自带逐片进度，Codex TUI 的跳到开头也是同款递归拉页形态；若往返耗时成为瓶颈再重启无界单帧方案。

**专用大纲 RPC**：拒绝——投影 seam 已自带与尾页的一致性切面、实时推送、持久化与能力缺席回退，专用端点得重造这一切。

**估算行高定位跳转**：拒绝——transcript 行高方差极大（工具卡、图片、代码），估算必抖；提交后落点零误差，且与 Codex 延迟兑现的 `pending_scroll_chunk` 同构。

## Consequences

导航栏从窗口口径变为会话口径，代价是随会话增长的整值投影（全中文预览预算下每轮上限约 600 字节，每轮至多推送三次）；把预览拆成按需读取推迟到数千轮量级的会话真正需要时。深跳仍会加载沿途所有页——连续窗口契约——跳到超长会话的第 1 轮会实体化整个 transcript，与手动翻页的终态相同。未挂载该投影插件的装配保留旧的仅已加载导航。覆盖：新包的投影单元 + Loader 组合 + HMR 测试、session-controller 的 loadThrough 循环测试、ui-chat 的合并与跳转测试（含 settle 校正与忙碌生命周期），以及 chat-scroll e2e 里的浏览器契约——在 88 轮 fixture 的尾部用键盘跳到未加载的第 1 轮，断言落点几何与导航栏渐变。
