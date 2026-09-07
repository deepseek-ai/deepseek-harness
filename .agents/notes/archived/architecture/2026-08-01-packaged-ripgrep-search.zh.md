# Agent Note: glob/grep 改用打包的 ripgrep 二进制直接 spawn

Status: implemented
Archived: 2026-09-04

[English](2026-08-01-packaged-ripgrep-search.md) | 中文

> 取代 [bash 承载的 grep/glob 发现工具](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md)：v1 决策中明确延期的方案——直接 spawn ripgrep——现在成为实际交付的实现。

## 问题

`glob`/`grep` 工具经由 bash 执行器 seam 运行，这使系统 `rg` 安装成为宿主依赖。Windows 和容器镜像的 `PATH` 默认没有 `rg`，工具在那里会静默消失；部署方只能从加载期探针警告里发现这一点。bash seam 还迫使整个模型可见参数面经过一个 shell 引号工具，因为工具与 ripgrep 之间隔着一层 shell——[bash 承载决策](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md) 把这种耦合记为 v1 的取舍，并把直接 spawn 列为 shell 字符串域一旦被证明过于敏感时的合理后续。它确实被证明了：每个模型值都要经受 POSIX 单引号转义，探针要在测试里脚本化，执行器自身的超时分类还与协作式工具超时策略已有的职责重复。

## 决策

`@deepseek-ai/dsh-tool-fs-search` 现在运行 PACKAGED（打包的）ripgrep 二进制（`@vscode/ripgrep`，一个 npm 依赖，其可选平台包随附二进制），经由 `ctx.subprocess` seam：`runRipgrep()` 以纯 argv 向量 spawn `rgPath`，向量前缀 `--no-config`，配以 collect 模式 stdout/stderr、`graceMs` 与转发的 `exec.signal`。`rgPath` 在首次调用时懒解析（进程内 memoize）：`@vscode/ripgrep` 在模块求值阶段解析其平台包，静态导入会把平台包缺失/损坏（`--omit=optional`、安装不全）变成 Loader 组合加载失败——这正是本次改动要消除的加载期失败模式。不再有 shell 层，执行路径上的 shell 引号边界随之消失；`singleQuote` 工具与其 shell spawn 测试一并删除。原始流使用 seam 的诊断尾部 collect 形态（无 spill 文件——工具从不读取原始 spill 路径；lossy stdout 读取以 `SEARCH_RAW_OUTPUT_OVERFLOW` 失败）。终止宽限与 stderr 尾部预算成为经校验的 `Config` 字段（`graceMs` 默认 3000，`stderrMaxBytes` 默认 64 KiB），不再继承自 bash-local 的配置。注册变为无条件——加载期 `command -v rg` 探针与条件注册决策被删除，连同那条 "rg not found" 警告。本包注入 `tools`、`systemPrompt` 与 `subprocess`。

退出语义仍由工具拥有：退出码 0 为有结果的成功，1 为成功的空搜索，其余归入既有 `SEARCH_*` 词汇（无效模式、启动失败、信号杀死、原始输出溢出）。超时是挂在工具定义上的协作式工具调用预算：`@deepseek-ai/dsh-tool-call-timeout-policy` 中止 `exec.signal`，subprocess seam 的终止升级提供硬终止，工具报告 `SEARCH_ABORTED`。工作目录为会话 header cwd（存在时），否则为 `process.cwd()`——不再有执行器配置可供默认化，因此回退由工具自己拥有。

`fs-glob-sampling` ACP（Agent Client Protocol）快照场景改为执行真实的打包二进制，作用于一个用固定 mtime 钉住 `--sort=modified` 顺序的预制工作区，取代 PATH 注入的 `rg` 替身（仅 POSIX：展示路径携带 `/` 分隔符，会话日志比较无法归一化）。

## 备选方案

**保留 bash seam 与探针，仅把 `rg` 记为必需宿主依赖。** 否决：宿主依赖正是本次改动要消除的失败模式，而让发现工具支持 Windows 正是此举的目的；写进文档的依赖仍是依赖。

**让 `rgPath` 可注入（配置字段或环境变量覆盖），让测试与快照继续使用替身二进制。** 否决：这会新增一个只有测试钩子会消费的公开部署面，而真实二进制本身具有足够的确定性——通过 fixture（测试前置数据）的 mtime 即可直接钉住；打包二进制就是部署形态，测试应当拿它来测。

**改用纯 JS 的 glob/搜索引擎（如 `picomatch`/`tinyglobby`）。** 否决：[依赖替换审计](../../rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.zh.md) 已基于「不存在 glob 引擎」的证据否决过该方向；ripgrep 语义（`--sort=modified`、VCS 剪枝、JSON 传输、正则方言）就是工具约定。

## 后果

- 发现工具在打包二进制覆盖的每个平台（darwin/linux/win32，x64/arm64）上开箱即用，无需宿主安装；交付的 TUI/Web 工具清单把 `glob`/`grep` 变为固定成员（见 [拉平交付的工具清单](../feature/2026-07-31-even-out-shipped-tool-rosters.zh.md)）。
- shell 字符串攻击面消失：恶意模式只是不具执行性的 argv 元素，由集成套件钉住；该套件现在也在 Windows 上运行（此前没有系统 `rg` 时它自行跳过）。
- spawn 不受沙箱约束（普通的 `ctx.subprocess` 调用），因此前缀 `--no-config`：宿主的 `RIPGREP_CONFIG_PATH`（或二进制旁的 `rg.conf`）否则可注入 `--pre` 预处理器，对每个匹配文件执行任意命令。加上 `--no-config` 后，任何配置文件——因而任何预处理器——都无法触及搜索。
- 原始输出溢出路径的形态改变：旧的 bash 承载路径继承了 bash-local 常开的 spill，可能留下没人读的多 MB 临时文件；subprocess seam 现在无 spill 收集，溢出是纯粹的错误（`SEARCH_RAW_OUTPUT_OVERFLOW`，"narrow pattern, path, or include and retry"），不返回任何内容。
- 加载期失败模式改变：subprocess seam 损坏现在让首次搜索调用失败（`SEARCH_FAILED`），而非通过探针使插件加载失败；二进制缺失是带打包路径的启动失败，而不是 PATH 问题。
- 集成套件的 fixture 去掉了 Windows 无法表示的文件名（名称含 `"`），保证套件在每个平台都能重放。
- 重新生成 `THIRD_PARTY_NOTICES.md` 暴露了一个由新依赖带出的潜在生成器 bug：Node 的 `fs.globSync` 返回操作系统原生分隔符，因此在 Windows 上 notices 分层中带 `/` 后缀的 dev 区前缀永远匹配不上，dev-only 包（测试工具、support 叶子）被错分为运行时。生成器现在在入口处归一化 manifest（元数据清单）路径，notices 与平台无关。
- `@vscode/ripgrep` 依赖为运行时层增加其 MIT 行；pnpm 11 截断的虚拟存储目录名需要在 notices 生成器的元数据查找中增加内容扫描回退。
