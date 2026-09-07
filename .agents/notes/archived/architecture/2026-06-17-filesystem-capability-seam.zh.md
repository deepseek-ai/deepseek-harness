# Agent Note: 文件系统能力 seam——ctx.fs、本地后端与面向模型的文件系统工具

Status: implemented
Archived: 2026-09-04

[English](2026-06-17-filesystem-capability-seam.md) | 中文

## 问题

harness 已有一个具体的 `bash` 能力 seam（`dsh-shell` / `dsh-bash-local` / `dsh-tool-bash`），但文件系统操作当时即将作为面向模型的工具落地，却没有等价的 seam。如果 `read`、`write` 和 `edit` 直接使用 `node:fs`，面向模型的工具包就会同时承担文件系统执行策略、本地路径解析、原子写入行为、文本解码、符号链接行为和编辑语义。

这把三个独立变化的关注点耦合在了一起：

1. 文件系统约定：插件可以请求哪些操作。
2. 后端：当前是本地磁盘，未来可能是沙箱/远程/项目作用域的文件系统。
3. 消费方 API：面向模型的 `read` / `write` / `edit` schema 与结果格式化。

如果没有 `ctx.fs` 接口，将本地文件系统访问替换为沙箱或远程后端时，即使面向模型的约定应当保持稳定，工具 schema、演示和提示词引导也会被迫变动。这还使权限/沙箱边界更难推理：一个 `cwd` 选项看起来像沙箱，但除非有显式的后端或 `tools/execute` 策略强制执行路径包含约束，否则它只是一个基础路径。

文件系统工具必须在成为公开包（package）接口之前，以与 bash 相同的能力 seam 形态落地。

## 决策

文件系统访问是一个一等的能力 seam，遵循[能力 seam Agent Note](2026-06-13-capability-seams.zh.md)：

1. `@deepseek-ai/dsh-fs`（`packages/fs/fs`）拥有抽象的 `ctx.fs` 服务、文件系统词汇类型，以及 `fs/*` 策略事件词汇。
2. `@deepseek-ai/dsh-fs-local`（`packages/fs/fs-local`）提供第一个实现，以本地文件系统为后端。
3. `@deepseek-ai/dsh-tool-fs`（`packages/fs/tool-fs`）通过 `ctx.fs` 提供面向模型的 `read`、`write` 和 `edit` 工具，是分发 `fs/*` 事件的执行器。

Consumer 包仅依赖 Service Definition 包，从不依赖 `dsh-fs-local`。需要不同后端的部署只需为 `ctx.fs` 加载不同的提供方，无需改动工具 schema 或面向模型的提示词引导。

读后写/编辑与观测状态策略是第四个包 `@deepseek-ai/dsh-fs-observation-policy`（`packages/fs/fs-observation-policy`），通过 `fs/*` 事件门控贡献，而非挂在 `ctx.fs` 上；加载 `dsh-tool-fs` 的部署同时加载 `dsh-fs-observation-policy` 以获得读后写/编辑能力。本决策确立了由三个包构成的边界；策略从提供方基类拆出的决策由 [拆分文件系统 seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.zh.md) 做出，其以事件门控插件（而非方法服务）实现的方式由 [事件门控 Agent Note](2026-06-26-file-context-as-event-gate.zh.md) 做出。

第一个后端有意仅限本地：`dsh-fs-local` 基于宿主文件系统实现 `ctx.fs`。未来的兄弟后端可在同一接口之后提供沙箱、远程、虚拟或项目作用域的文件系统。

第一个消费方有意仅限文本文件：`dsh-tool-fs` 暴露面向模型的 `read`、`write` 和 `edit` 工具，处理 UTF-8 文本文件。未来的消费方可以添加目录列表、搜索/glob、二进制安全操作、文件监视或更高层的项目操作，只要 `ctx.fs` 上存在所需能力，就无需改动本地后端包。直接目录列表后来由[为文件系统 seam 添加直接目录列举能力](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md)添加。

文件系统权限和沙箱并非此拆分所隐含。本地后端从其配置的基目录解析相对路径，但路径包含约束策略是独立的决策：要么由更严格的 `ctx.fs` 实现强制执行，要么由权限/沙箱插件包装 `tools/execute` 并在调用到达消费方之前否决。

读后写/编辑与观测状态属于 `dsh-fs-observation-policy`，而非 `ctx.fs`。通过 `fs/*` 事件门控，策略按不透明 actor 记录版本，并提供可选的变更期望；提供方原子性地强制新鲜度。`dsh-tool-fs` 发出事件但不依赖策略。见[拆分文件系统 seam](../simplification/2026-06-26-fsspec-style-fs-seam.zh.md)和[事件门控插件](2026-06-26-file-context-as-event-gate.zh.md) Agent Note。

## 包拓扑

文件系统 seam 使用与 bash 三件套相同的依赖方向：

```text
@deepseek-ai/dsh-tool-fs  --depends on-->  @deepseek-ai/dsh-fs  <--depends on--  @deepseek-ai/dsh-fs-local
        consumer                                interface                         implementation
```

`@deepseek-ai/dsh-fs` 仅依赖 `cordis` 加上来自 `@deepseek-ai/dsh-llm` 的仓库级 `HarnessError` 基类。它声明 `ctx.fs` 键、抽象 `FileSystem` 服务、后端和消费方共享的词汇类型、文件系统错误词汇，以及 `fs/*` 策略事件词汇。它不持有观测状态存储，也不持有 owner 推导形态；事件传递一个不透明的 `object` actor，提供方从不读取它，`dsh-fs-observation-policy` 插件在这些事件之上拥有 owner 推导形态和观测状态存储。

`@deepseek-ai/dsh-fs-local` 依赖 `@deepseek-ai/dsh-fs` 和 `cordis`。它继承 `FileSystem`，将自身注册为 `ctx.fs`，拥有本地后端配置（如基目录），并包含所有直接的 `node:fs` / `node:path` 访问。它不持有观测状态存储——新鲜度是后端铸造、策略插件记录的版本令牌。

`@deepseek-ai/dsh-tool-fs` 依赖 `@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt` 和 `cordis`。它注册面向模型的工具和提示词段落。它禁止导入 `node:fs`、`node:path` 或 `@deepseek-ai/dsh-fs-local`；文件系统执行始终通过 `ctx.fs`。如果实现需要具体的 agent（智能体）或会话辅助类型，这些依赖属于 `tool-fs`；它们禁止回漏到 `dsh-fs` 中。

根 `tool-fs` 插件通过组合各工具的注册辅助函数来注册完整的文件系统工具套件（`read`、`write` 和 `edit`）。它注入 `fs`，从不导入 Service Provider 包。

## `ctx.fs` 约定

`@deepseek-ai/dsh-fs` 拥有一个语义文件系统服务。它比 `readFile` / `writeFile` 更高层，这样 `tool-fs` 就不必重新实现路径解析、版本管理、文本解码、二进制拒绝、分页、原子替换、符号链接行为或字面编辑语义。

该接口涵盖以下语义操作：

- 将模型/插件提供的路径解析为后端定义的目标。
- 将解析后的目标转换为同一执行环境的规范进程路径或 `file:` URI，并在不解析其不透明键的情况下检查包含关系。
- 获取目标元数据而不读取文件内容。
- 读取完整或流式 UTF-8 文本；消费方执行各自的视图与保留上限。
- 创建或替换一个 UTF-8 文本文件。
- 通过字面替换编辑一个已有的 UTF-8 文本文件。

提供方约定还携带策略所依赖的新鲜度钩子——但观测状态存储和 owner 推导位于 `dsh-fs-observation-policy` 插件中，而非 `ctx.fs` 上：

- 后端为每个目标铸造一个不透明的 `version` 令牌（在 `stat` 以及每次读取/变更结果中）。
- `writeText`/`editText` 接受一个可选的版本期望：省略它表示无条件的裸提供方变更；提供它则在后端的原子临界区内守护变更。
- `dsh-fs-observation-policy` 插件在 `fs/write-intent`/`fs/edit-intent` 上决定该期望，并在 `fs/observed` 上记录观测版本，以它从不透明事件 actor 推导出的 owner 为键（通常是 `exec.agent.session`）。

授权基于版本新鲜度，而非完整/部分视图的区分：任何读取都会记录目标的版本，后续的写入/编辑只要文件仍处于该版本就被授权——因此对第 100-150 行的窗口化读取可以授权对第 120 行的编辑。观测状态存储是 `dsh-fs-observation-policy` 内部的 `WeakMap<owner, Map<targetKey, version>>`；`dsh-fs` 不持有任何此类数据，并将 actor 视为不透明。（本决策最初建模了一个带 `full`/`partial` 视图的 `FileState` 缓存放在 `ctx.fs` 上；拆分文件系统 seam 与事件门控两份笔记将其替换为此处描述的基于新鲜度的策略插件。）

路径解析是显式的，允许异步。本地解析可能只做路径规范化，但沙箱/远程/项目作用域的后端可能需要 I/O 才能将用户提供的路径解析为稳定的目标标识。

解析后的目标必须至少暴露三个概念：

- 原始输入路径，用于诊断。
- 不透明的 `targetKey`，用于陈旧守护和文件状态查找。本地后端可能使用类似 realpath 的键；远程后端可能使用工作区 URI 或文件 id。消费方禁止解析或假设它是本地绝对路径。
- `displayPath`，用于面向模型/UI 的输出。根据后端不同，它可能是本地绝对路径、工作区相对路径或远程 URI。

即使另一项能力共享提供方的执行环境，`targetKey` 仍保持不透明。这类消费方通过提供方的 `processPath(target)`、`fileUrl(target)` 或 `contains(parent, child)` 获取所需事实；[可移植执行环境决策](2026-07-28-portable-execution-world-consumers.zh.md)说明这些事实为何属于文件系统 seam。

读取和变更结果必须包含不透明的文件 `version`。本地后端从 bigint stat 元数据（`dev`、`ino`、`size`、`mtimeNs` 和 `ctimeNs`）派生令牌，因此同大小重写和 inode 替换都会可靠地使消费方失效；远程后端可以使用 revision id 或类似 hash 的令牌。`dsh-fs-observation-policy` 插件记录版本用于陈旧检查；消费方可以展示相关元数据但禁止解释版本令牌。

提供方返回已解码的文本：`readText` 返回整个普通文本文件，`streamText` 为大文件或消费方自有的保留上限流式传输相同的文本语义。行窗口化、字节上限、带行号渲染和总行数统计归 `dsh-tool-fs`、`dsh-lsp-stdio` 等消费方所有。提供方负责普通文件检查、UTF-8 解码和二进制／NUL 拒绝；它不知道行窗口、协议上限或视图。

观测状态记录不在 `ctx.fs` 上：成功读取后，执行器发出 `fs/observed`，`dsh-fs-observation-policy` 插件为推导出的 owner 记录 `{ version }`。没有 `full`/`partial` 视图——任何窗口的读取都记录版本，新鲜度（而非视图完整性）授权后续的写入/编辑。

全文件写入创建或替换 UTF-8 文本文件。后端在支持且有文档说明时可以创建父目录。已有的非常规目标被拒绝。`writeText` 接受一个可选期望：`createIfAbsent` 创建缺失的目标并拒绝已存在的（报 `FS_NOT_OBSERVED`，这是策略为未观测 owner 使用的路径）；`replaceIfVersion` 仅在目标处于观测版本时替换，否则报 `FS_STALE_VERSION`；省略期望则为无条件的裸提供方创建或覆盖。策略插件根据 owner 的观测状态选择提供哪个期望。

字面编辑是提供方原语（`editText`），而非在 `tool-fs` 中由读取加写入组合而成。字面匹配、重复匹配拒绝、CRLF 保留、二进制拒绝、可选的陈旧版本检查和原子读-改-写必须一起留在后端的变更临界区内。`editText` 接受相同的可选版本期望；陈旧检查在字面匹配之前运行，因此基于旧读取的编辑会报 `FS_STALE_VERSION`。远程后端可以将编辑实现为原生的 compare-and-edit 操作；消费方不强制本地风格的组合。

策略插件（而非 `ctx.fs`）对先前观测进行门控：`edit` 要求 owner 有先前观测（否则报 `FS_NOT_OBSERVED`），记录的版本作为 CAS 基础传给 `editText`。在策略插件缺席时，`ctx.fs` 本身是一个完整的无约束 seam（无条件写入/编辑）；工具从不与策略方法耦合。

文件系统约定失败以 `FsError extends HarnessError` 抛出，工具注册表将其转换为带结构化 `{ name, code }` 元数据的 `isError` 工具结果。`dsh-fs` 拥有此词汇，而非由每个工具各自发明消息。错误码包括 `FS_NOT_FOUND`、`FS_NOT_TEXT`、`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_NOT_REGULAR_FILE`、`FS_AMBIGUOUS_EDIT`、`FS_EDIT_NOT_FOUND` 和 `FS_ABORTED`。（早期草案包含 `FS_PARTIAL_OBSERVATION`；基于新鲜度的授权没有 partial/full 区分，因此已删除。目录列表相关的错误码后来由[为文件系统 seam 添加直接目录列举能力](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md)添加。）

## 工具消费方行为

`@deepseek-ai/dsh-tool-fs` 是面向模型的消费方。它拥有工具名称、JSON Schema、模型边界的参数校验、提示词段落和结果格式化。它不拥有文件系统执行。

第一个工具套件包含：

- `read`：检查一个 UTF-8 文本文件并返回带行号的内容与分页引导。
- `write`：创建或完全替换一个 UTF-8 文本文件。
- `edit`：通过替换字面文本更新一个已有的 UTF-8 文本文件，默认要求唯一匹配，并允许显式的全部替换模式。

每个工具遵循相同的执行形态：

1. 校验并规范化模型参数。
2. 调用相应的 `ctx.fs` 操作。
3. 将结果格式化为面向模型的 `ContentBlock[]`。
4. 让抛出的后端/工具错误流经 `ToolRuntime.execute()`，由其转换为 `isError` 工具结果。

该包通过 `ctx.systemPrompt.section(...)` 注册提示词引导，通过 `ctx.tools.register(...)` 注册 schema。工具 schema 仍通过 `SystemPrompt.assemble()` 和 `ToolRuntime.schemas()` 流入正常的提示词组装路径；无需改动 agent loop（智能体循环）。

工具包在后端变化时保持面向模型的约定稳定：本地后端和远程后端内部可能以不同方式解析路径，但 `read` / `write` / `edit` schema 不会仅因后端变化而改变。

默认部署要求在用 `write` 或 `edit` 更新已有文件之前先 `read`。`tool-fs` 不通过检查是否运行过名为 `read` 的工具来实现这一点：它分发 `fs/write-intent`/`fs/edit-intent` 事件（将执行上下文作为不透明 actor 传递），`dsh-fs-observation-policy` 插件推导 owner、对先前观测进行门控并提供版本期望。任何窗口化读取都能授权后续的写入/编辑，只要文件未变。用 `write` 创建新文件不要求先前观测。

根插件通过组合各工具的注册辅助函数来注册完整套件。它注入 `fs`、`tools` 和 `systemPrompt`。

## 测试

测试遵循包边界，而不仅是用户可见的工具：`dsh-fs` 中的服务约定；`dsh-fs-local` 中通过 `ctx.fs` 接口测试的真实文件系统行为（解析、符号链接、流式传输、二进制/UTF-8 拒绝、无条件和版本守护的写入、字面编辑语义、行尾保留、结构化 `FsError` 错误码）；`dsh-tool-fs` 中基于真实本地提供方的消费方接口（只 mock 模型/时钟，从不 mock 协作者）；以及通过 `ctx.tools.execute()` 在有和没有 `dsh-fs-observation-policy` 的情况下进行集成测试，通过从磁盘回读文件来验证世界状态，既不信任规范值，也不信任渲染内容。观测状态/owner 推导策略在 `dsh-fs-observation-policy` 中测试，不在此处。

本仓库曾踩过的防御性模式类别被直接固定：

- **原子写入临时文件安全。** 写入/编辑通过目标旁边一个私有随机 `0700` 目录中的独占 owner-only（`'wx'`、`0o600`）临时文件暂存，失败时清理，最后原子 rename——与 bash spill 文件规则一致，因为可预测的 world-readable 临时路径招致符号链接竞争和信息泄露。测试断言权限，并断言已存在的临时路径不会被覆盖；此原语是 seam 的常设要求。
- **通过符号链接的 `targetKey` 同一性。** 两个输入路径解析到同一 realpath 时共享一个观测状态条目：通过路径 A 的 `read` 满足通过符号链接路径 B 的 `edit` 的读后编辑守护，通过一个路径的陈旧写入可通过另一个路径检测到。
- **并发/陈旧竞争。** 对同一目标的两个并发写入/编辑操作确定性地收敛——一个成功，另一个被 `FS_STALE_VERSION` 拒绝——成功的编辑刷新记录状态，使同一 owner 的下一次编辑可以继续。
- **HMR（热模块替换）安全与 dispose（资源释放）。** dispose 后端的 fiber 会撤回 `ctx.fs` 提供方；后续的提供方以无继承状态启动。

## 曾考虑的替代方案

- **面向模型的工具直接基于 `node:fs`**：工具包将同时承担执行策略、路径解析、原子写入、文本解码和编辑语义，耦合问题部分所列的三个独立变化的关注点，且任何后端替换都会搅动 schema。
- **单一合并包 `dsh-fs-tools`**：seam 之前的形态；以与 bash 相同的 Service Definition / Service Provider / Consumer 拆分理由否决，且合并名称从未成为公开 API。
- **观测状态放在 `ctx.fs` 上**：本 Agent Note 最初落地的形态；被 [拆分文件系统 seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.zh.md) 和 [事件门控 Agent Note](2026-06-26-file-context-as-event-gate.zh.md) 取代：沙箱/远程后端不应继承面向模型的观测策略，因此提供方只保留版本令牌和可选的版本守护变更。

<a id="consequences"></a>

## 后果

**`cwd` 可能被误认为沙箱。** 本地后端的基目录是解析默认值，而非自动的隔离边界。如果需要路径包含约束，必须由后端约定或 `tools/execute` 上的权限/沙箱插件强制执行。

**接口可能变得过于本地化。** 如果 `ctx.fs` 返回 `absolutePath` 之类的字段，远程、沙箱或虚拟后端会变得尴尬。约定应暴露显示元数据，而不要求消费方理解宿主路径。

**接口可能变得过于薄。** 如果 `ctx.fs` 只镜像 `node:fs` 原语，`tool-fs` 将重新实现二进制检测、分页、原子写入和编辑语义，重新制造本决策所避免的耦合。

**编辑语义天然易受竞争影响。** 字面编辑是读-改-写操作；守护手段是后端的原子变更临界区加上可选的版本期望，因此并发编辑确定性地收敛——一个赢，另一个得到 `FS_STALE_VERSION`。

**观测状态不属于 `ctx.fs`。** 记录执行上下文看到了什么是工作流策略，而非原始文件系统 I/O。本决策最初将其放在文件系统 seam 内部；拆分文件系统 seam 笔记随后确立了沙箱/远程后端不应继承面向模型的观测策略，并将其移入 `dsh-fs-observation-policy` 插件。提供方约定只保留写入/编辑安全在存储层真正需要的东西——后端铸造的版本令牌和可选的版本守护变更——而策略插件拥有 owner 推导、观测状态和基于 `fs/*` 事件的读后编辑门控。

**`resolve` 然后操作的形态每次调用多一次往返。** 每个工具可能先将路径解析为 `FsTarget`，再以单独的 `ctx.fs` 调用发起读取/写入/编辑。对本地后端来说这可以忽略（解析是内存中的路径规范化），但远程/沙箱后端可能将每步变成独立请求，使单次 `read` 变为两次网络往返。往返开销重要的后端可以在内部缓存或折叠解析，同时保持可观测约定不变。

**观测状态持久化被推迟。** 观测状态存在于内存中（`dsh-fs-observation-policy` 内部的 `WeakMap`），因此恢复的会话保守地要求文件在写入/编辑前重新读取，直到未来的会话事件或持久化机制使观测可回放。

**错误码成为 seam 的一部分。** `FsError` 错误码使陈旧版本和观测失败可通过既有的结构化错误分类体系进行机器路由。代价是 `dsh-fs` 从 `dsh-llm` 导入共享的 `HarnessError` 基类；该依赖是有意为之且限于错误词汇。

**包拆分的成本前置。** 三包拆分在只有一个后端时就增加了样板代码。这是有意为之：文件系统访问是可能的沙箱/远程边界，在面向模型的工具发布后再改包 API 代价更高。
