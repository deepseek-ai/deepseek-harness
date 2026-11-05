# Agent Note: 按需激活的 Office 渲染、转换与重算工具

Status: implemented

[English](2026-10-31-native-office-tool.md) | 中文

## 问题

按照[渐进式 Office 技能](2026-09-27-progressive-office-skills.zh.md)的决定，Office 操作技能通过普通 shell 命令运行 LibreOffice Kit CLI。Kit 的原生引擎会启动辅助进程、Worker 和字体缓存，而 shell 沙箱和 PTC 权限会限制这些行为，因此同一次渲染可能在一个部署中成功、在另一个部署中失败。每个部署都必须把独立 Node 可执行文件和 CLI 路径发布到技能正文中，这需要 Node 和 CLI 配置、Python sidecar 的 Node、针对应用二进制的 Electron 检查，以及防止选中 Electron 壳自带 Kit 的运行时根目录约束检查。用于检查的渲染把 PNG 文件写入工作区内的临时目录，模型再用 `read_image` 读取并删除它们，使每次视觉检查都多出调用和清理义务。

## 决策

[`tool-office` 包](../../../../packages/document/tool-office/README.zh.md)提供三个按需激活的 Host 工具：`office_render`、`office_convert` 和 `office_recalculate`。每个工具在各自的 JSON Schema 中直接声明参数规则：`office_render` 接受文档路径、页码或幻灯片 `pages`、工作表 `sheet` 与 `range` 选择以及 `dpi`；`office_convert` 保留全部九种输出格式（Word 支持 `pdf`、`docx`、`odt`、`txt`，Excel 支持 `pdf`、`xlsx`、`ods`、`csv`，PowerPoint 支持 `pdf`、`pptx`、`odp`）以及仅用于 CSV 输出的 `sheet`（工作簿含多个工作表时必填）；`office_recalculate` 接受 `xlsx` 和 `ods`。三个工具声明共约 1,813 个字符，仅在加载了 Office 技能的 Session 中付出。它们调用 [Office 套件](../../../../packages/document/office-kit/README.zh.md)服务；该服务通过 `src/locate.ts` 在 Host 进程中加载 Kit，并让每个操作经过 Office 预览所用的队列、并发上限、字节预留和缓存。工具请求使用 `foreground` 优先级，即打开的预览所属的类别，因此后台预热不会饿死它们。SDK 组合在 `office-kit` 旁挂载 `tool-office`，Web bundle 的标准和 PTC Agent 预设挂载它，minimal 预设保持其固定工具列表；Kit 缺失时三个工具仍然注册，每次调用都返回服务的 `unavailable` 消息。每个工具在每次调用时读取该服务而不是注入它，因此省略或禁用 `office-kit` 的组合仍能带着这些工具创建 Session，每次调用以 `unavailable` 失败；之后加载的服务会处理下一次调用。标准模式与 PTC 模式使用同一组注册；PTC 嵌套调用重新进入普通执行管线。

`office_render` 在工具结果中返回 PNG 图片；Web Client 的 Office 行只显示结果的文本块，不显示这些图片。工具在结果写入日志之前通过附件存储提交图片，因此模型可见的图片可以从 Session 日志还原，恢复和分叉会还原它们，图片卸载也适用于它们。完整结果受图片数量、单图像素与尺寸以及 PNG 总字节数约束，每项取工具配置与附件存储上限中的较小值；超出上限的选择直接失败，不会被截断。不支持图片输入的路由在渲染前即被拒绝。

`office_convert` 和 `office_recalculate` 不写入工作区。文件系统服务有意只提供二进制读取，工作区中的二进制文件只由 shell 产生，而 shell 的沙箱和审批已经管理写入。Office 套件把每个输出保存在可配置的 `outputDirectory`（默认 `$DSH_HOME/office-kit/outputs`）下仅属主可访问的目录中，按调用方 subagent 树的根 Session 分组；输出在 `outputRetentionMs` 到期、`maxOutputStoreBytes` 需要为较新的输出腾出空间、该根 Session 卸载或提供方卸载时删除。因此 subagent 的输出在 subagent 结束后仍然保留，委派它的 agent 仍可复制。工具返回临时文件的绝对路径、格式、大小和转换器报告的页数，并指示立即用 shell 复制该文件，因为文件可能在保留期到期或需要腾出空间时被删除，且对话结束后会被删除。无法读取 Host 路径的文件系统后端（例如 SSH 工作区）会在转换前拒绝这两个工具，因为远程 shell 读不到 Host 的输出存储。macOS Seatbelt、Linux bubblewrap 和 Linux Landlock 的 shell 沙箱都允许读取 Harness 主目录，因此受限的 shell 可以把文件复制进工作区。

三个工具共享同一个 `when(agent)` 谓词，而不是在每次请求中常驻。当 `marked.has(agent)` 为真，或 `agent.session.requestHeader()?.tools` 已包含 `office_render`、`office_convert` 或 `office_recalculate` 时，`Agent` 激活它们；`agent/disposed` 会清除 `WeakSet<Agent>` 标记。当非错误的 `skill` 工具结果（`tools/result` 且 `!result.isError`，包括 `run_code` 内嵌套的 `skill` 调用）或直接的用户技能调用（`session/event` 中 `event.type === 'user/message'` 且 `event.data.source.kind === 'skill-invocation'`）加载了 `activationSkills`（默认为 `office`、`office-docx`、`office-xlsx` 和 `office-pptx`）中的技能时，`tool-office` 标记该 `Agent`。工具声明在加载技能后的下一步出现，并在该 Session 剩余时间内保持激活；激活前调用 `office_*` 工具会以 `UNKNOWN_TOOL` 失败。会话中途激活新增这些工具时，agent loop 会记录一条带 `tool-addition` 项的 `developer/message`（`source: { kind: 'tool-registry' }`）：声明了 `toolUpdate`（`in-history` 或 `addition-only`）的模型保留现有请求前缀，未声明 `toolUpdate` 的模型则开启一次新的请求序列。由于标准模式的请求头本就持久化在 Session 日志中，检查 `requestHeader()` 即可在恢复、分叉和压缩后保留激活状态，无需新增 Session projection。PTC 模式下记录的请求头只声明 `run_code`，因此恢复或分叉的 PTC Session（或加载技能后、下一条原生请求头记录前发生进程崩溃）不会保留 `office_*` 绑定，直到再次加载 Office 技能；[Office 路由与格式技能](../../../../packages/skill/skill-office/README.zh.md)指示模型在 `office_render`、`office_convert` 或 `office_recalculate` 不在工具列表中时调用 `skill` 加载 `office`。没有技能只包装单个操作，单独的渲染、重算或转换只需加载 `office` 路由。技能不再携带可执行文件路径，因此 `skill-office` 没有 Node、CLI 或 Kit 位置配置，`office-kit` 的 `src/locate.ts` 没有 CLI 解析器，Desktop 和各 bundle 不发布 Office 可执行文件变量，Python sidecar 的独立 Node 只保留给 Python `deepseek_harness.office` 模块使用。

此决定部分取代[渐进式 Office 技能](2026-09-27-progressive-office-skills.zh.md)：其路由与格式技能仍然有效，而其操作技能、普通 shell 执行方式以及否决专用渲染工具的决定由本文取代。

## 考虑过的替代方案

**保留通过 shell 执行 Kit CLI。** 这样可复用 shell 的审批和进程管理，但原生引擎在 shell 沙箱和 PTC 权限下运行受限，而且每个部署都要维护 Node 与 CLI 路径、Electron 的 Node 检查以及运行时根目录约束。

**保留单一常驻 `office` 工具。** 单一常驻 schema（约 1,514 个字符）虽能避免会话中途新增工具，但会让所有不使用 Office 的 Session 在每次请求中都承担这笔开销，并迫使渲染、转换和重算参数挤在同一个扁平 schema 中，各操作的参数组合只能靠自然语言说明而无法按工具分 schema 约束。

**为已加载的 Office 技能新增 Session projection。** 在专用 projection 中折叠 `tools/result` 和 `user/message` 记录虽可在 PTC 恢复和分叉后还原技能激活状态，但需要新增 projection 服务、折叠规则和跨包依赖，而标准模式已由持久化的请求头记录该状态，PTC 模式只需重新加载 `office` 即可恢复。

**仅在 `Agent` 内存中记录激活状态。** 若像 `action-cards` 那样只检查 `WeakSet<Agent>`，标准模式恢复或分叉后的第一步会丢失 `office_*` 声明，因为新的 `Agent` 实例初始未标记；同时检查 `agent.session.requestHeader()?.tools` 可从已持久化的请求头保留声明。

**为每个操作保留一个技能。** 单独的渲染、重算和 PDF 导出技能会在每次单独操作前多一次 `skill` 调用，并重复工具 schema 与结果中已有的说明。

**由 Host 把转换后的文件写入工作区。** 这样省去 shell 复制，但需要文件系统服务支持创建二进制文件，或在其旁另建一条写入路径，两者都会重复 shell 对工作区写入的沙箱和审批决策。

**经系统临时目录返回转换后的文件。** Linux bubblewrap 为受限 shell 挂载私有的 `/tmp`，shell 在那里读不到文件；Harness 主目录在所有本地 shell 沙箱下都可读。

**返回图片文件而不是图片内容。** 先保存 PNG 再调用 `read_image`，能让所有工具共用一种图片路径，但会重现本次变更去除的临时目录流程，每次检查还多一次调用。

## 影响

加载 Office 技能后，视觉检查只需一次 `office_render` 调用且无需清理，图片遵循 Session 的附件、卸载和回放规则。未加载 Office 技能的 Session 不消耗任何 Office 工具声明 token；加载了 Office 技能的 Session 激活约 1,813 个字符的专用 schema，支持 `toolUpdate` 的模型保留现有请求前缀，不支持 `toolUpdate` 的模型只开启一次新的请求序列。标准模式的恢复、分叉和压缩通过已记录的请求头保留工具声明，PTC 恢复或分叉以及在记录下一条请求头前崩溃的场景则通过再次加载 `office` 恢复。激活后，Office 操作在标准模式与 PTC 模式之间、在不同部署之间行为一致，各部署专用的 Node、CLI 和约束代码已经删除。

转换后的文件需要 shell 复制；没有 shell 工具的组合可以渲染，但无法交付转换后的文件，远程工作区则完全不能转换。临时输出在保留期满或根 Session 卸载后消失，恢复的 Session 需要重新转换。不提供把页面图片保存为文件。

验证包括：`tool-office.spec.ts` 覆盖三个工具的 schema、结果、参数规则、上限、失败、取消、PTC 分发和卸载，`activation.spec.ts` 覆盖技能触发激活、自定义 `activationSkills`、失败的技能调用、直接 `/office` 调用、跨恢复与分叉的 `requestHeader()` 持久化以及 PTC 重新激活；Office 套件测试覆盖输出存储的保留、淘汰、释放和清扫；Loader 组合测试在 Kit 缺失时以及 `office-kit` 条目缺失时返回 `unavailable` 消息，并在该条目加载后调用到服务；Desktop 打包 smoke 通过服务对真实 DOCX、XLSX 和 PPTX 文件执行渲染、转换和重算；录制的 headless Session 在加载 Office 技能前不声明 `office_*`，在加载后的下一步声明 `office_render`、`office_convert` 和 `office_recalculate`，其中包括一次因路由不接受图片输入而被 `office_render` 拒绝的渲染。
