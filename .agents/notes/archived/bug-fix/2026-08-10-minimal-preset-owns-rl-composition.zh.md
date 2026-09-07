# Agent Note: minimal preset 拥有完整的 RL agent 组合

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-minimal-preset-owns-rl-composition.md) | 中文

## 问题

随附 Web 配置同时由两个位置定义与 Claude SWE 兼容的 RL agent（智能体）：进程级 `core-web.cordis.yml` patch，以及逐会话的 `minimal` preset。[agent preset](../architecture/2026-08-03-per-session-agent-presets.zh.md) 成为 agent 组合边界后，preset 中带作用域的 `deployment:persona` 会用陈旧的 coding-agent 文本遮蔽 overlay 修正过的全局 persona。overlay 测试没有挂载 preset，而 preset 测试启动时没有 overlay，因此两者都没有覆盖用户实际选择的组合。

这种拆分还掩盖了其他偏差。preset 挂载了一次性 Bash，而不是 RL harness 使用的[持久 Bash](../feature/2026-07-29-persistent-bash-str-replace-editor.zh.md)，并且遗漏了 RL 压缩（compaction）策略。保留两个所有者，会使今后每次修改提示词、工具或策略时都必须验证二者的交叉组合。

## 决策

随附的 Web `minimal` preset 是 RL agent 组合在 Web 中的唯一所有者。它声明 entry 本地的 PTY 注册表与本地后端、带 RL 环境描述且超时为 300 秒的持久 `bash`，以及 `str_replace_editor`。工具呈现仍由部署选择。后续的[裸双工具运行时决策](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.zh.md)取代了本记录最初的压缩与文件系统提供方选择：当前 preset 挂载 entry 本地的 `fs-local` 提供方，不挂载压缩后端。编辑器不接受 `requireAbsolutePath` 设置，因为要求绝对路径是它的无条件约定。

preset persona 恰好是 `You are a helpful software engineer assistant.`，它设置 `complete: true`，并为其 agent 作用域抑制 runtime context。complete `PromptSection` 参与常规组装，因此工具、变量和协作式监听器仍会解析；`system-prompt/assemble` waterfall（瀑布式事件）结束后，提示词注册表会将该段落的独立副本恢复为唯一的系统提示词段落，并丢弃每个动态上下文贡献。存在多个有效 complete 段时，组装会被拒绝。这些最终注册表约束可防止 harness 身份、Web 定位、工具引导、组装监听器、沙箱策略、批准策略、委派或其他动态上下文提供方添加模型输入。

进程级 `core-web.cordis.yml` patch 缺席。浏览器 UI、workspace 附加、持久化、子进程、沙箱、权限、模型路由及其他跨会话服务仍由宿主持有。选择 `minimal` 会改变一个 agent 面向模型的组合，并且仅为该 agent 遮蔽宿主文件系统提供方，不会改变 Web 进程中的其他会话。

## 验证

系统提示词与 persona 包测试证明了 complete 段最终约束与 runtime-context 抑制，包括 waterfall 修改与重复项拒绝。交付 preset 组合测试在默认原生呈现下断言精确的提示词、Bash 描述、要求绝对路径的编辑器 schema 和双工具目录。无密钥 Web 回放通过 `minimal` agent 发送一个真实请求，同时注册全局身份、Web 定位文本、动态策略上下文和一个测试段落；它断言不存在 runtime-context 快照、entry 本地文件系统是裸后端且压缩不存在，随后执行两次持久 Bash 调用，证明环境与 cwd 状态能够保留，并通过绝对路径执行编辑器。

独立的 [`sdk-minimal` 组合包](../../../../packages/bundle/sdk-minimal/README.zh.md)是 `dsh --profile sdk-minimal` 的完整双工具组合。[裸双工具运行时决策](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.zh.md)说明其启动方式专属的环境配置、裸文件系统和无 compaction 选择；[独立 profile 决策](../architecture/2026-08-24-standalone-sdk-minimal-profile.zh.md)负责其 launcher 与组合包位置。其无密钥 SDK 进程测试会断言组装后的系统提示词与双工具目录，installed-wheel 场景会跨调用执行持久 Bash 并使用编辑器；Python SDK 教程提供可运行入口。

## 考虑过的替代方案

**将 `core-web.cordis.yml` 保留为兼容 patch。** 被拒绝，因为进程 patch 与会话 preset 是同一 agent 约定的两个独立所有者；优先级会使任意一方都能静默撤销另一方的配置。

**在 preset 中禁用每个已知的提示词贡献方。** 被拒绝，因为宿主行属于整个进程，新的贡献方也会重新开放提示词。由组装提示词的注册表实施最终 complete 段约束，才能表达这项否定保证。

**仅使用前置 waterfall 监听器筛选段落。** 被拒绝，因为另一个前置包装层可以在该监听器外执行，并在筛选后追加内容。在整个 waterfall 结束后实施约束，才能稳定拥有最终决定权。

**在 Web 宿主上挂载 PTY 服务。** 被拒绝，因为只有 minimal agent 消费这些服务。entry 本地的 `pty` realm 与唯一消费方具有相同的生命周期和作用域，无需由 preset 发布进程级全局服务。

## 后果

Web RL 提示词固定不变，不能通过环境覆盖；独立 JSON-RPC 提示词由部署选择。Web preset 与 `sdk-minimal` profile 在各自启动路径共享持久 shell 加 editor 的行为；`sdk-minimal` 在 Windows 上选择 PowerShell。Shell 状态按 agent 隔离，并随该 agent 一并消失。Web preset 为自身的 PTY 与裸文件系统服务实例承担开销，其他 preset 无需承担。Web preset 的 Bash 后端需要受支持的 POSIX 终端基础环境，因此该 preset 不支持 Windows agent。
