# Agent Note: Web 轮次与窗口级延迟/吞吐指标

Status: implemented
Archived: 2026-09-04

[English](2026-08-04-web-latency-throughput-metrics.md) | 中文

## 问题

Web 聊天已经记录了逐步骤的 LLM（大语言模型）计时（`stepStartTime`／`firstTokenTime`／`completedTime`）和逐步骤 usage，trajectory 视图也按步骤展示它们，但聊天界面既回答不了「这一轮响应有多快」，也回答不了「这个会话跑得有多快」：assistant 页脚只显示轮次实际耗时，统计行也只折算墙钟时间总量。

## 决策

`ui-conversation` 包内的折算逻辑 `chat/turn-metrics.ts` 是从 assistant 节点推导延迟/吞吐读数的唯一位置。`assistantStepReading` 把一个节点转成一次步骤读数：TTFT（首 token 延迟）需要 `stepStartTime` 与 `firstTokenTime` 同时存在，解码时长需要 `firstTokenTime`，负时长钳制为零，输出 token 数只在不可信的 `usage` 值有限且非负时才采纳。`deriveTurnMetrics` 按轮次折算读数：编号最小的步骤拥有该轮次的 TTFT 槽位，吞吐用「同时携带两者的那些步骤」的输出 token 总和除以解码时长总和，因此缺采样的步骤直接退出而不是让比值失真；两个数字都没有的轮次不产生条目。

assistant 页脚把读数追加到既有 hover 显示的时间附属元素中、`用时` 之后，形如 `首 token {s}秒 · {tps} tok/s`，未记录的数字各自省略。ChatView 仅在该轮次的 `turnTimings` 条目带有 `endTime` 时才显示读数：已加载窗口是日志的连续后缀，因此窗口内已结算的轮次必然带着它的全部步骤，首步 TTFT 是真实值而非窗口截断的产物。`formatLatencySeconds` 不带单位，各语言模板各自拥有秒后缀（`TTFT {seconds}s`／`首 token {seconds}秒`）。

统计行在其窗口折算中复用同一份步骤读数：`deriveStats` 累计 TTFT 总和／计数与解码时长／token 数，在 LLM／工具墙钟时间旁渲染经 `conversation` locale 命名空间本地化的延迟／吞吐分组（中文为 `首 token 平均 … · … tok/s`）。轮次计数、步骤计数、耗时、缓存与 token 各项的标签也使用同一命名空间。与那些墙钟时间一样，该分组是窗口作用域的，不折算任何计费；token 账目仍归 token-meter 投影。

## 考虑过的替代方案

**持久的会话投影（token-meter 形态）。** 在 host 侧用 `ProjectionDefinition` 折算步骤计时可以跨越压缩（compaction）与窗口分页、覆盖整个日志。是暂缓而非否决：投影状态必须保持 O(1)（只能均值，不能分位数），它需要 host 改动加 schema，而聊天统计行的耗时事实被记录为窗口作用域。持久投影可以在不挪动这些读数的情况下补上。

**逐步骤页脚附属元素。** 让每条 assistant 消息显示自己的 TTFT，会给轮次中段的叙述节点挂上附属元素，而页脚设计刻意让它们保持无 chrome；trajectory 视图已经暴露逐步骤计时细节。

**用节点是否在场而非 `turn/end` 计时做页脚门控。** 直接渲染碰巧加载到的步骤，会展示一个貌似合理、实为分页后「首个已加载步骤」的 TTFT。`endTime` 门控加上后缀窗口不变量，使显示的数字要么是该轮次真实的首步延迟，要么什么都不显示。

## 后果

窗口内已结算轮次的页脚在 hover 时于实际耗时之后显示 `首 token`／`tok/s`，统计行在墙钟时间旁以本地化标签显示窗口平均延迟与吞吐，全程不新增会话事件、不改 host。指标以省略的方式退化：没有计时或 usage 采样的提供方或步骤只是丢掉对应数字，而不会渲染成零。已加载窗口之外的更早历史仍不计入，已记录在包 README 的统计行限制中。

两个读数都来自实测墙钟时间，因此都不可复现：TTFT 是 `firstTokenTime - stepStartTime` 的时间差，吞吐则以 `completedTime - firstTokenTime` 的解码墙钟时长为分母。同一个回放场景在本机连续两次跑出 69 与 70 tok/s，而一段 3 毫秒的回放流会读成 26333 tok/s。因此 Web aria golden 在既有的 `{{duration}}` 之外，把吞吐归一化为 `{{throughput}}`；页脚的装饰性分隔符也补上了两侧空格——没有它们，这些读数会连成一整串无障碍文本（`Ran for 13sTTFT 0.2s12 tok/s`），既让屏幕阅读器失去读数之间的边界，也让 `{{duration}}` 失去它赖以匹配的词边界。
