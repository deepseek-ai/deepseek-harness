# 测试策略

[English](testing.md) | 中文

本文说明本仓库的分层测试方式，以及保持绿色测试套件有意义的规则。命令见根目录 [AGENTS.md](../AGENTS.md)；相关 Agent Note 承载设计动机。

## 层级

- **单元测试**（`pnpm run test`）：vitest 运行包和示例各自的 `tests/**` 目录下的测试，以及匹配 `scripts/**/*.spec.ts` 的仓库脚本测试；测试文件与其所覆盖的代码区域放在一起。每个注册表都有一个 HMR（热模块替换）安全测试（对向该注册表贡献内容的 fiber 执行 dispose（资源释放），并断言清理完成）。优先覆盖边界情况、错误路径、事件顺序、并发竞态，以及针对约定回归的永久测试（见 `packages/core/agent-loop/tests/contract-regressions.spec.ts`）。
- **覆盖率门禁**（`pnpm run test:coverage`）：门禁级运行，对 `packages/*/*/src` 按文件 100% 覆盖。未覆盖的行往往是门禁正确标记出的死代码（应删除），而非需要补写的测试。行覆盖率是必要条件，但永远不是充分条件：它证明行被执行过，不证明功能按交付预期工作。`packages/shell/pwsh-local/src` 的按文件 100% 覆盖需要真实的 `pwsh`：缺少它时其执行器套件会自动跳过，`vitest.config.ts` 会豁免该文件以使无 pwsh 的主机保持绿色，而 CI runner 自带 pwsh，仍按完整标准执行门禁。
- **真实 API e2e**（`pnpm run test:e2e`）：带密钥测试调用真实提供方 API，包括 DeepSeek 模型以及各提供方特有的冒烟测试；这些测试各自由自己的密钥控制（`EXA_API_KEY`、`PERPLEXITY_API_KEY` 等），缺少密钥时套件会自动跳过，使 keyless CI 保持绿色（[真实 API e2e Agent Note](../.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.zh.md)）。
- **所属位置的预期输出**（`pnpm run test:expected`）：无录制会话往返的无密钥组装 CLI/进程预期。驱动使用 `*.expected.e2e.ts`，并与 `tests/expected/` 同属一处；CI 针对构建产物运行。包/脚本预期使用 `test`，浏览器预期使用 `test:web`。
- **快照**（`pnpm run test:snapshot`）：顶层场景数值最高的已录制 parent generation 同时提供用户输入和模型回放，并作为持久化结果的预期值。parent 文件名是 `session[.vN].jsonl`；child 角色使用 `session.<ordinal>[.vN].jsonl`；v0 省略 `.v0`，正版本必须使用小写 `.vN`，且每个文件名必须与其 header 一致。进程级场景都通过 `dsh` 启动：headless 负责一次性行为，SDK 负责持久控制，ACP 负责自动化协议行为，Web 在同一 Session 旁保留浏览器与 ARIA 证据。`snapshot.yml` 声明 profile、组合与请求头类别、录制策略、例外回放或输入元数据以及 workspace 事实。带类型的 token 保留父子身份关系；只有请求头 pin 拥有 prompt/schema sidecar。变更 workspace 的场景会独立比较完整的 `workspace.expected/` 目录，record 与 refresh 绝不改写该目录。当模型 transcript（文本记录）变化时使用 `test:snapshot:record`，回放输入仍有效时使用 `test:snapshot:refresh`；请审查所有结果差异。
- **Web 浏览器快照**（`pnpm run test:web`；必需的 Linux PR（Pull Request）门禁）：Chromium 比较 `snapshots/web/` 下由会话驱动的输出，以及 `apps/web/tests/expected/` 下仅含 UI 的输出。CI 强制只读的 `DSH_SNAPSHOT=replay`，绝不写入预期输出；record/refresh 留在本地，每处 diff 都须评审（[web e2e 车道](../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)、[CI 门禁决策](../.agents/notes/implemented/testing/2026-07-30-web-browser-snapshot-ci-gate.zh.md)）。`test:web` 会[先构建](../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md)以交付插件 CSS。

Session fixture 保留 header 与 payload，但省略正文 seq/time envelope；replay 会合成这些 envelope。Replay、record 与 refresh 会选择每个 parent/child 角色的最高 generation。当前 v2 使用 `.v2`、每个事件一行，并嵌入紧凑 Assistant stream；保留的 v0（无后缀）与 v1（`.v1`）可以为迁移覆盖保留规范 packed row。[迁移器](../scripts/migrate-packed-session-fixtures.ts)会改写更旧的历史布局。

## spec 如何被执行

fork 出的 worker 会同时运行多个 spec 文件，coverage gate 会拆成并发的 partition，与同一个 job 中的其它 gate 并排运行，而自托管 runner 共用同一台宿主机和同一个卷。被隔离的只有进程：端口、可预测路径、外部命名空间和继承而来的子进程都不隔离。为每个占用的资源负责到它的 teardown，并把「只有单独运行时才通过」的 spec 读作该 spec 的缺陷，而不是 runner 不稳定。[dsh-ci-test-reliability](../.agents/skills/dsh-ci-test-reliability/SKILL.md) 负责资源分配、状态恢复、同步、超时预算、平台差异与 teardown 规则；它的 [flake 诊断流程](../.agents/skills/dsh-ci-test-reliability/references/ci-flake-diagnosis.md)用于归类已经存在的概率性失败。

## 带密钥策略：推理（inference）在这里很便宜

我们是 DeepSeek，不要吝惜真实 API 测试。无密钥测试只能证明底层通路；只有带密钥运行才能证明 agent（智能体）能对接真实模型正常工作。覆盖文件写入提示词、包含多个轮次的对话、工具使用和流中取消。价值最高的是**冒烟测试**：启动已交付的 `dsh` profile、发送一条提示词，并检查外部世界；它们能捕获「单元测试全绿、产品却坏了」这一类 mock 无法发现的问题（[事故复盘 0001](postmortem/0001-acp-default-export-drops-inject.zh.md)）。自动跳过让无密钥 CI 和无密钥贡献者不受阻塞；它不是成本信号。Profile 级集成测试位于 `apps/cli/tests/profiles/`；包专属组合留在对应包的测试目录中。

## 优先使用真实实现而非 mock

只 mock 开销高或不确定的边界（LLM（大语言模型）适配器、网络、时钟）；下游一切保持真实。手写替身只能证明桥接层在搬运字节，不能证明交付的工具行为符合断言。桥接工具调用测试把真实的工具注册表与执行管线保留在脚本化 mock 模型下游：`makeBridgeHarness()`（packages/acp/acp/tests/harness.ts）挂载 agent loop、会话存储、工具注册表与 JSONL 持久化，唯一 mock 是脚本化 `MockAdapter`。

恢复测试按步骤区分分片前与分片后的失败，并证明失败分片不会派生出消息或工具副作用。覆盖耗尽、取消、策略组合、持久化、状态、协议计数、会关闭传输的空闲超时，以及交付的 Loader 组合。

## 验证外部世界，而非自我报告

e2e 断言应重新运行命令或从外部重新读取文件；对 agent 自身输出做关键词探测会让作弊的 agent 通过。断言未修改的文件逐字节一致。e2e 测试自行管理资源：在测试中创建 harness，在 `afterEach` 中 dispose（即使失败/重试/超时也要释放）；共享 fixture 放在普通的 `tests/harness.ts` 中，绝不放在另一个 `*.e2e.ts` 中（导入一个 spec 会重新注册其 `describe`，导致真实 API 调用重复执行）。

## 测试真实入口路径

- 产品可见的插件必须有一个非单元的真实组合测试。手动构建的 `ctx.plugin(...)` 套件不够：通过 Loader 和 app/process 启动仅用于测试的 `cordis.yml`，只 mock 外部服务或非确定性输入，断言模型可见的请求/日志、持久状态或用户可见输出。不要把 opt-in 选项混入交付默认值。
- 一个守卫只有在回归能让它失败时才有效。对于没有 `inject` 的插件（bundle/组合插件），Loader 冒烟测试在默认导出替换必需的具名导出时仍然绿着——需要添加显式的 `expect('default' in mod).toBe(false)` 加 `unwrapExports` 往返断言，并证明它有效：引入回归、观察变红、回退。
- 「真实入口路径」指已发布的产物：包的 `bin` 所运行的是构建后的 `lib/bin.js`，并由普通 `node` 执行，从而暴露 tsx 会掩盖的失败（结算竞态、模块解析、被吞掉的加载失败）。同样的规则适用于非 index 运行时入口（worker-thread 的同级文件 `lib/worker.cjs`），也适用于多个 bundle 共享的单例模块（`packages/sdk/server/tests/built-scope-carrier.e2e.ts`）。保持构建产物冒烟测试绿色（`packages/examples/*/tests/built-bin.e2e.ts`、`packages/code-runtime/code-runtime-worker-thread/tests/built-lib.e2e.ts`），并断言真正缺失的配置以非零状态退出。

## 测试解析：仅限源码

- 每个 vitest 配置都将 vite-tsconfig-paths 指向 `tsconfig.base.json`；工作区包的裸导入解析到 `src`（[布局](development.zh.md#typescript-project-layout)），绝不会经由包的 `exports` 解析到构建后的 `lib/`，因为其中的陈旧产物会加载第二份模块单例。构建产物只在显式指定时使用：以 `lib` 模式运行的子进程，以及下文的构建产物冒烟测试。

## 测试子进程启动模式

- CI 与已有构建产物的测试通道通过共享双模式启动器，从构建后的 `lib/` 运行每个 profile 或 Cordis 配置子进程。不要为这些子进程手写 `--import tsx`。
- 不加载 Cordis 的协议与操作系统 fixture 直接通过 Node 运行使用可擦除语法的 `.ts` 文件，不经过 tsx 或根路径映射。
- 只有测试对象本身是源码路径解析时，才可以选择 `src`；在测试中写明这一约定。

## 何时需要快照测试

每项非平凡的模型可见、协议可见或人类可见变更，都在同一 PR 中添加或更新无密钥录制会话场景；包级、e2e、仅 mock 和 PR 理由证据不能取代组装后的 transcript。Headless、SDK、ACP 和 Web 录制分别位于 `snapshots/session/`、`snapshots/sdk/`、`snapshots/acp/` 和 `snapshots/web/`；Web 渲染可以显式借用另一个场景的规范会话。不由录制会话驱动的预期输出保留在所属应用、包或脚本的 `tests/expected/` 下，并且不使用 `*.snapshot.ts` 后缀。[`dsh-session-snapshot`](../packages/test-support/session-snapshot/README.zh.md) 拥有共享存储规则和 profile 适配器。Agent loop、会话生命周期和 `SessionEventMap` 变更应更新两个 SDK 投影：`snapshots/sdk/` 拥有 TypeScript，必需的 Python 运行时 CI 拥有 `scripts/snapshots/python-sdk-single-exe/`。新增 capability seam、生命周期或 transcript 变体应在计划阶段列出每个必需层级。
