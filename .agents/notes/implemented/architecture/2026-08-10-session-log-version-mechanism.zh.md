# Agent Note: Session log 版本机制：单调整数、升级器链、逐事件可忽略标记

Status: implemented

[English](2026-08-10-session-log-version-mechanism.md) | 中文

## 问题

Session log 在发布后必须能升级格式，而最先发布的运行时决定了此后一切的下限：第一个发布版的读取器缺少哪种拒绝和降级行为，用户手里已经装上的副本就永远补不上。发布 issue #1901 的最低要求是老运行时读到新 Session 格式时明确报不支持，而不是读错。改动前的读取器在两个方向上都做反了：`assertVersion` 对任何版本不匹配抛出同一条不区分方向的消息；JSONL 解码器把不认识的事件类型原样放行，重建时静默跳过，恢复出一个内容残缺的会话且没有任何诊断。

## 决定

**一个单调递增的整数，不分大小版本。**某一步能不能自动升级是那一步自己的属性，由它的升级器存在与否表达，不该由两级编号方案提前承诺；设计时很少能预知下一个变更算不算"大"。

**升不升版本由写入方决定，与读取方能力无关。**当且仅当老运行时无法在语义上完全正确地处理新日志时才必须升版本。"解析不报错"不是标准：静默跳过影响重建的内容就是读错。只有结构性变更够得上这条线：header 形状、事件信封、核心事件语义、surface 机制（`SurfaceEventType` 集合、`SurfaceOp` 变体）。拿不准就升：近似恒等的升级器几乎没有成本，漏升一次会让老读取器静默读坏。

**读取规则按方向区分。**版本相等：正常读。比读取器新：拒绝，说明方向（"由更新的 harness 写入，请升级"），并给出原始日志文件的路径，用户仍能看到文本（`SessionFormatUnsupportedError`，与 `SessionPersistenceCorruptionError` 区分，因为数据没有损坏）。比读取器旧：每个事件正文操作先在内存中运行完整相邻链，并保持源路径、字节与 inode 不变。读句柄可以直接使用该 current 逻辑结果；写 open 则在 append 前把最终 current generation 排他发布到其规范版本文件名。仅 header 的列表保持不变更，并报告数值最高的规范 generation。catalog 生成与模块初始化会拒绝缺失的相邻步骤，因此已发布第一方 build 绝不会暴露不完整历史链。保留的低 generation 不是自动 fallback，也不构成 downgrade compatibility 承诺。

**逐事件的 `ignorable` 标记吸收词汇表增长，普通的新增事件永远不用升版本。**事件词汇表由挂载了哪些插件决定，单个版本整数描述不了它。读取器遇到不认识的事件类型时拒绝解读日志，除非该事件的信封带 `ignorable: true`。默认为必需：忘写标记的后果是把一个本可恢复的会话拒绝过头（体验问题），而默认可忽略会让同样的疏忽静默恢复出残缺会话（安全事故）。架构保证了这条规则成立：模型可见内容只经三种带 `surfaceOp` 标记的 surface 事件加 `request/header`、`request/context` 折叠进入重建，危险的未知事件恰好是那些不进 surface 但改变日志其余部分解读方式的事件（`session/end-seed` 是现存例子）。

## 影响

v0（0812 发布）交付的内容：分方向的拒绝并带原始日志路径；基于生成的已知词汇清单（`KNOWN_SESSION_EVENT_TYPES`，由 `gen-persistence-catalog` 从所有 `SessionEventMap` 声明合并生成，`verify-persistence-catalog` 保证新鲜）的未知事件守卫；`ignorable` 信封字段被种子校验、JSONL 和 BFF 线上 schema 接受。V1 添加静态相邻 catalog、恒等 v0-to-v1 迁移边、仅 header descriptor、精确代际 JSONL 发布与[已发布 Session 格式](2026-08-31-released-session-format-migrations.zh.md)定义的当前专用恢复。[历史 Session 只读迁移准备](2026-09-05-read-only-session-migration-preparation.zh.md)负责内存恢复与写入发布之间的 JSONL 时序。V2 让物理 codec 对普通事件词汇与 payload 新增项保持中立：相邻迁移边冻结 released source 与 target 清单，同版本恢复则应用已安装的 known-event set 与当前 payload 语义。第一方 writer 不通过 `Session.append` 设置 `ignorable`，而一个仓库外插件仍依赖该字段；同版本保留由[外部插件保留决策](2026-08-30-retain-ignorable-external-session-events.zh.md)定义，更严格的历史规则由 [alpha 迁移拒绝决策](2026-08-31-alpha-historical-unknown-event-refusal.zh.md)定义。未知类型守卫仍只在读取侧生效，因为 append 时的词汇拒绝会中断活跃 Session 的持久化。JSONL 会在当前 header 或事件解析前从最小原始 header 分类外来版本，因此结构完全不同的未来格式会报告升级方向而不是"损坏"。

## 曾考虑的替代方案

- **大小两级版本号**：能否转换这一位信息属于每一步的升级器，把它预先固化进编号形状会做出错误承诺。
- **未知事件默认可忽略**：把忘写标记的后果从可见的过度拒绝反转成静默损坏。
- **在仅 header 列表期间迁移**：让便宜清单改变存储，而且需要读取事件正文才能计算 header 无法证明的事实。列表返回 descriptor，事件正文读取负责发布。
- **插件运行时注册已知事件类型**：不予采用，因为该方案会让已知集依赖插件组合，而且只注册事件名称，无法判定省略事件是否安全。持久化的 `ignorable` 标记把该分类保留在每条记录中；[外部插件保留决策](2026-08-30-retain-ignorable-external-session-events.zh.md)定义当前消费方约束。
