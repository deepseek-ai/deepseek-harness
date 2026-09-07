# Agent Note: 以证据驱动的性能优化工作流

Status: implemented

[English](2026-09-06-evidence-driven-performance-skill.md) | 中文

## 问题

性能工作可能改善某个独立阶段，却把成本转移到另一阶段、保留更多数据，或跳过必要行为。历史 PR（Pull Request）描述也可能保留已放弃的实现和估计值，因此照搬其表面方案可能恢复已否决的设计，而不是解决当前瓶颈。

## 决定

[dsh-speed-up-perf skill](../../../skills/dsh-speed-up-perf/SKILL.md)（技能）引导广泛调查收敛到范围明确、可测量的用户路径。它结合聚焦的成本归因与独立计时的后端和浏览器端点、合成负载分布、可比较的冷态／热态与保留内存条件，以及收紧预算的负向对照。下方历史证据区分已合并实现、已被替代的提案、作者报告的测量值和估计值。

该工作流要求独立于计时的行为证据：模型可见日志、持久化代际和发布规则、流顺序、取消及 dispose（资源释放）仍是必须满足的要求。获授权的私有语料检查仅提供聚合负载启发；提交的输入和发布的产物包含合成材料。优化 PR 携带收紧后的预算，而前置基准测试层可以保护已测基线并保持独立可合并。

[会话打开性能门禁决策](../testing/2026-09-04-session-open-performance-gate.zh.md)继续负责测试通道机制与校准。[简化 skill](../../../skills/dsh-find-simplifications/SKILL.md)继续负责以删除为目标的调查。两者均未被替代：本工作流增加面向性能的候选选择、测量可比性和停止条件，而不替换它们的决策。

## 历史证据

这些是作者报告的历史测量，并非为本工作流重新运行的基准测试。最终合并差异与所属源码优先于最初 PR 描述。保留已否决的中间提案，仅用于解释为何身份注册表不是通用处方。

| 证据 | 测量路径与结果 | 可复用经验 |
|---|---|---|
| [#3535](https://github.com/deepseek-harness/deepseek-harness/pull/3535)，已合并 | [最终基准设计](https://github.com/deepseek-harness/deepseek-harness/pull/3535#issuecomment-5552779119)报告首次打开负向对照 4,394 ms，预算 550 ms；首屏历史 4,452，预算 550；恢复 4,333，预算 450；128 MB 堆检查失败。Client fold：123.9 ms / 10.84×，预算 40 ms / 3.125×。 | built-JS 用户路径门禁与正／负向对照比早期 PR 正文设计更重要。 |
| [#3536](https://github.com/deepseek-harness/deepseek-harness/pull/3536)，关闭未合并 | 重复 snapshot／freeze 工作占采样 CPU 的约 70%；合成打开从 4,734–4,921 改善为 707–823 ms。 | 流式迁移替代了该身份注册表提案。没有当前所有权证据时，不恢复它。 |
| [#3585](https://github.com/deepseek-harness/deepseek-harness/pull/3585)，已合并 | 历史物理解码：7.527 s / 7,219 MB 峰值 RSS 降至 1.467 s / 908 MB；流式迁移加串行发布：6.241 s，2.107 GB 峰值，477 MB 保留。已结算的 500,000-delta Client fold：3.2 ms。 | 跨消费者保持紧凑表示；限制中间状态。归因估计重叠，不能相加。 |
| [#3586](https://github.com/deepseek-harness/deepseek-harness/pull/3586)，已合并 | 当前 v2 打开快照：2,011.4→1,027.9 ms；恢复：598.5→16 ms；保留堆：1,025.3→478.7 MB。 | 分离只读准备与必须等待的写发布；通过按修订号共享准备和调用方局部取消共享不可变所有权。 |
| [#3537](https://github.com/deepseek-harness/deepseek-harness/pull/3537)，已合并 | 合成 200 轮投影：28→5.4 ms；总计：76.9→50 ms；峰值 RSS：137.2→94.9 MB。 | 按紧凑记录读取统计、usage、文本和图像引用。展开流缓存保留不必要的表示成本。Chat／Trajectory 属于前置迁移改动。 |
| [#2587](https://github.com/deepseek-harness/deepseek-harness/pull/2587)，已合并 | 历史 416,756 事件由 696 记录表示：Client 历史 4,682→276 ms；采样额外 V8 峰值 612.5→199.4 MB。 | 验证和折叠过程保持紧凑；[基线审查](https://github.com/deepseek-harness/deepseek-harness/pull/2587#discussion_r3803082730)要求相同验证与保留输出，而不是解析后丢弃。 |
| [#3331](https://github.com/deepseek-harness/deepseek-harness/pull/3331)，已合并 | 10,000 个折叠工具行：22.5→7.5 ms，保留 12.2→1.6 MiB；非活动 Trajectory 刷新：4,082→15.5 ms。 | 延迟未使用的解析和实体化；首次激活与保留 Context 仍有成本。 |
| [#3391](https://github.com/deepseek-harness/deepseek-harness/pull/3391) 和 [#3383](https://github.com/deepseek-harness/deepseek-harness/pull/3383)，已合并 | 缩小订阅范围、稳定身份、批量发布和视口触发高亮。10,000 节点计时表是估计，不是浏览器测量。 | 延迟不等于虚拟化：访问过的 token DOM 仍被保留。 |
| [#3292](https://github.com/deepseek-harness/deepseek-harness/pull/3292)，已合并 | 两百万条 FIFO 排空：中位数 9.656 ms，不含入队。 | deque 删除 shift 复制，不删除队列准入或背压义务。 |
| [#1161](https://github.com/deepseek-harness/deepseek-harness/pull/1161)，已合并 | 无密钥的 100,000-chunk 浏览器压力测试，每 16 ms 推送 128 个 chunk。 | [生产者追赶](https://github.com/deepseek-harness/deepseek-harness/pull/1161#discussion_r3699970161)和[最后一次心跳停顿](https://github.com/deepseek-harness/deepseek-harness/pull/1161#discussion_r3699970162)可能扭曲测量；定时派发事件不是真实键盘／指针输入。 |

[取消审查](https://github.com/deepseek-harness/deepseek-harness/pull/3586#discussion_r3940578092)、[源修订审查](https://github.com/deepseek-harness/deepseek-harness/pull/3586#discussion_r3940569241)和[类型化读取器审查](https://github.com/deepseek-harness/deepseek-harness/pull/3537#discussion_r3942974015)说明删除重复工作不等于允许删除验证或发布义务。[备用 runner 审查](https://github.com/deepseek-harness/deepseek-harness/pull/3535#discussion_r3927945561)区分独立 job 与隔离的物理主机。

## 考虑过的替代方案

**先优化可疑代码，再测量。** 否决，因为局部复杂度不能确定主要用户成本，也无法证明改善或防止回归。

**把历史加速方案当作可复用处方。** 否决，因为表示方式、所有权和生命周期要求会变化。历史证据用于产生假设；当前生产路径与新的测量决定改动是否适用。

**只使用微基准测试，或只使用端到端计时。** 否决，因为独立阶段可能遗漏被转移的工作，而总计时无法定位原因。两者都需要在与所选问题相符的范围内使用。

## 后果

该 skill 不增加运行时行为、基准测试实现或新的 CI 策略。其验证涵盖文档／链接一致性和 skill 元数据；后续每项优化在其所属位置提供可执行测量与功能证据。有限的场景／修复范围防止广泛性能请求演变成无关的架构重写。
