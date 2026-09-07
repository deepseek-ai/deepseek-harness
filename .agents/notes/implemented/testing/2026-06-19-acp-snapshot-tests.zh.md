# Agent Note: ACP 快照测试——一次录制 / 确定性回放

Status: implemented

[English](2026-06-19-acp-snapshot-tests.md) | 中文

## 问题

单元测试不会覆盖组装后的完整 agent（智能体）子进程及其 ACP（Agent Client Protocol）自动化协议格式，而真实 API 测试不具确定性且受密钥门控。因此，即使单元测试覆盖率检查通过，Loader 接线、后端行为和协议输出仍可能回归，[默认导出事故复盘（postmortem）](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)已经证明了这一点。

完整 transcript（文本记录）测试的阻塞因素在于模型：agent 的输出由非确定性的 LLM（大语言模型）驱动，而每次运行都命中真实 API 的密钥门控测试既不确定也无法在 CI 中运行。该测试层级需要真实运行的保真度与 fixture（测试前置数据）的确定性兼得。

## 决策

录制会话快照通过 `dsh` 启动随附 profile，驱动其公开接口，并将规范化输出与已提交的预期输出比较。归 ACP 所有的场景还会驱动 stdio 协议并比较其 transcript。从真实 API 一次记录的会话日志为后续所有模型流提供数据。fixture 是[产品持久化 JSONL 的投影](../../archived/testing/2026-08-18-session-snapshot-envelope-projection.md)：保留 header 与 payload，省略正文序号／时间 envelope。

[Session-log 快照语料决策](2026-08-24-session-log-snapshot-corpus.zh.md)取代本 Note 中 ACP 专属的放置位置与控制器所有权；本 Note 继续负责会话日志 fixture、回放推导、例外 override、规范化和 ACP transcript 比较的理由。

### fixture 投影持久化会话 JSONL

每个场景数值最高的选定 parent generation 都从真实运行中采集：v0 为 `session.jsonl`，正 generation 为 `session.vN.jsonl`。`assistant/message` 与 `assistant/attempt` 中嵌入的紧凑 stream 会复现模型 attempt；工具、message 与 boundary event 捕获 harness 行为。因此，一份普通 Session generation 同时充当 replay source 与行为预期输出。

每个当前 v2 Session-format fixture 都为每个持久事件使用一条物理行。保留的 v0 与 v1 predecessor generation 可以包含其冻结 packed-row 表示，并保持不可变。普通 replay 与 log 比较证明组装进程会选择、迁移、消费并复现当前 generation。

### 回放从日志推导模型脚本

`llm-replay` 短路 provider-neutral `llm/stream` waterfall。`deriveReplayScript()` 把每个已记录 `assistant/message` 或 `assistant/attempt` stream 展开为一次位置式调用，并校验其 terminal chunk。携带 `llmStreamCall: true` 的 `compaction/summary` 会在其持久 log 位置贡献一次调用：replay 根据 `rawOutput` 重建规范 block boundary，保留已记录 usage（如有），并提供 terminal `stop`。该 marker 将这次本地调用与 template 或 remote summary 区分开；后两者即使保留 `rawOutput`，也未使用此 context 的 adapter。

### 内存中的回放条目遵守完整的 LLM 约定

`deriveReplayScript` 产出一组 `ReplayEntry`，即回放监听器按位置服务的内存单元：

```
{ kind: 'chunks', chunks: StreamChunk[] }
| { kind: 'throw', chunks: StreamChunk[], message: string, code: string }
| { kind: 'hang' }
```

Log 从持久 Assistant settlement 与显式标记的 compaction call 推导 chunk 或 throw entry。Stream 开始前的 throw、hang 与 external summarizer call 没有可重建的本地 stream 表示，因此这些场景提供 `replay.override.json`。throw entry 可以包含 prefix chunk 以模拟 stream 中途失败。显式 override 避免从有损 turn-end reason 或单独 provider output 推断 adapter 行为。

### 位置式回放，单个在途流

回放是位置式的，因此每个场景只允许一个在途模型流。并发会话快照需要按请求键索引的条目。调用顺序变更需要重新录制，fixture 缺失或耗尽时立即报错。

### 录制采集日志；无密钥回放需要无提供方的配置

记录模式使用真实 `llm-deepseek` 适配器和配置为 `persistenceCompression: 'none'` 的 JSONL 持久化后端运行场景，再把生成的 `.jsonl` 投影到场景目录。显式 raw 模式让采集日志保持逐行可读，而普通部署使用后端的压缩默认值；符合条件的分片连续段仍使用默认的打包存储行。逐事件追加具有持久性，但 harness 会在采集前优雅关闭子进程（关闭 stdin → `await ctx.dispose()`），以确保最终事件已刷出。`llm-replay` 本身不执行记录——它只负责回放。

回放使用 `cordis.snapshot.yml` overlay，以 `llm-replay` 替换真实适配器，同时保留实际组合。记录使用普通配置和由 harness 提供的持久化根目录。回放模式跳过 `.env` 加载，因此意外存在的 API 密钥不会触发真实调用。参见[单一来源配置 Agent Note](../../archived/testing/2026-07-04-single-source-acp-replay-config.md)。

### 两个表面：归一化后比对

快照运行断言**两个**归一化后的表面，因为 harness 的外部表面是不同的：

1. **stdout transcript**——自动化客户端收到的、分帧后的 ACP JSON-RPC 响应与已提交的消息更新。它捕获传输约定的回归，与已提交的 `stdout.expected.jsonl` 比较。
2. **重新持久化的 Session JSONL**，规范化后与选定的最高 parent fixture 比较。同一个 generation 同时作为 replay source 与预期日志；新鲜当前 writer 可以产生更高的规范文件名，而逻辑比较会保留较旧 replay 输入。prompt 与工具 bulk 会被清理；每种 request header 类别由一个场景固定余下 header sequence。该 pin 默认拥有可读的 prompt 与工具 schema sidecar；完整对应 sequence 相同时，也可把另一个 pin 指定为任一来源，因此每个不同 sidecar 版本只提交一次。fixture guard 会拒绝重复 sidecar 内容，record/refresh 会拒绝生成不同字节的共享 claimant。最初的 request header 固定理由保留在[请求头固定 Agent Note](../../archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)中。Override 场景只从其 sidecar 派生模型行为。

两个表面互补：stdout 覆盖精简的自动化协议格式，JSONL 覆盖协议格式有意省略的循环、工具和边界结构。

规范化会替换会话、cwd、协议 id、时间戳、路径和进程易变值；fixture 投影会省略正文序号／时间 envelope，而不修改 payload 引用。录制与刷新还会在回放 fixture 中将生成的 workspace 及其文件系统解析出的别名存储为 `{{cwd}}`，使平台临时根目录和随机 basename 不影响录制结果；手工编写的临时路径与显式 `workspaceParent` 下的 cwd 值仍保留字面值。场景把真实 bash 使用限制在稳定命令上。stdout 预期输出仍是符合协议格式的 JSONL，每个原始行都必须可解析为 JSON。普通 Vitest 快照更新只写入 stdout 预期输出；回放 fixture 的写入由显式 `record` 和 `refresh` 模式负责。

### 隔离：当前靠归一化，后续可加沙箱

工具确定性来自生成的 cwd、清理后的环境、全新的非登录 shell、受限命令和规范化。cwd 默认为平台临时目录；当临时目录是始终可写的策略根，而行为需要独立项目位置时，场景可以改为提供其父目录。并发回放运行各自拥有独立 cwd、持久化目录和定长且按场景键区分的 spill 根目录，因此一个场景的清理操作无法删除另一个场景仍在进行的完整输出恢复，同时真实路径预览预算保持稳定。该层不声称提供 OS 级隔离。如果需要更强层级，沙箱执行器可以通过现有[能力 seam](../architecture/2026-06-13-capability-seams.zh.md)替换本地后端。

### 回放插件是独立的包

`@deepseek-ai/dsh-llm-replay` 是一个支撑包，而非示例本地的胶水代码。它通过用从 JSONL 重建的流短路 `llm/stream` 来替换真实适配器，其包级放置使回放逻辑处于正常覆盖率门禁之下。

### 两个子命令，回放在默认门禁中

`pnpm run test:snapshot` 无需密钥即可 replay 已提交 fixture；`test:snapshot:record` 使用真实 API，并写入投影后的当前 Session generation 与接口专属预期输出。同一无密钥 gate 会通过文件名/header 一致性发现仓库中的规范 JSONL generation，并拒绝与共享 codec 的投影后规范打包表示不同的任何 fixture。缺失角色会明确失败。每个 ACP 场景都包含 `input.json`、`stdout.expected.jsonl` 与一个选定 parent `session[.vN].jsonl`；不调用模型的情况使用仅含 header 的日志。其他 profile 从选定 parent generation 推导普通 accepted user input，只在 `snapshot.yml` 中保留 accepted Session 无法重建的 controller input。只有成功模型行为无法从日志推导的场景才需要 `replay.override.json`。fixture guard 会拒绝缺失、不匹配、非规范与孤立文件。两个命令都接受场景 filter。

## 曾考虑的替代方案

- **手工编写包含模型分片的 `llm.json`**——早期草案；复用真实会话日志，使 fixture 成为系统的真实产物而非手工构建的 mock，并让它同时充当行为预期输出。
- **为每个压缩摘要强制提供回放 override**——否决：持久摘要事件已经固定成功本地调用的位置、完整输出与可选 usage。显式的本地调用标记保留了这份单一来源 fixture，而不会为模板摘要器或远程摘要器凭空构造调用。
- **字节级 HTTP 录制库（Polly/nock/MSW）**：否决。与适配器耦合，处理流式 SSE（Server-Sent Events）时笨拙，且层级低于被测对象。
- **从 `turn/end {kind:'error'|'aborted'}` 合成抛错/取消条目**：否决。这会将 `llm-replay` 耦合到 loop 内部的轮次关闭语义，且 `turn/end` 原因是有损的（无法区分抛出的 401 与 finish-error）；显式的 `replay.override.json` 伴随文件是更清晰的 seam。
- **在每个类别 pin 旁复制两个请求头伴随文件**：否决。提示词与工具 schema 的组合各自独立变化，因此一个共享组件发生变更，就会使不相关类别 pin 中字节完全相同的文件产生无意义改动。显式的分组件来源可在不重复内容的情况下，为每个类别保留一个结构性 pin。

## 后果

该测试层为每个场景增加经过评审的会话、manifest、接口专属预期输出、可选 override 和可选 workspace fixture，并为每个不同的已固定提示词序列、每个不同的已固定工具 schema 序列各增加一个文件。记录与回放都会把 workspace seed 复制到生成的 cwd。作为回报，该层通过真实 Loader 和工具组合提供确定性的无密钥覆盖，其中包括一个组装后的上下文溢出恢复场景，其带标记的压缩摘要提供辅助调用。ACP 子树现在只保留协议行为；属于 headless、SDK 和 Web 接口的行为由各自接口拥有。

本 Agent Note 与[拟议的确定性 Agent Note](../../proposed/testing/2026-06-11-deterministic-and-stress-testing.zh.md)相关，但不取代它：该提案的「通用回放 fixture」在每次测试后重新派生会话*消息历史*（内部一致性不变量），而这些快照固定组装后的行为与接口专属输出。两者仍相互补充。
