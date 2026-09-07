# Agent Note: Windows 默认改用 pwsh

Status: implemented
Archived: 2026-09-04

[English](2026-08-01-windows-pwsh-default.md) | 中文

## 问题

harness 交付的执行画像在每个平台都是 bash 优先。Windows 主机必须安装 bash 垫片（WSL 或 Git-Bash），或退回到仅 POSIX 的 `dsh-bash-local` 行为（硬编码 `bash -c` argv、进程组语义）；面向模型的 bash 工具教的是 bash 方言。Windows 原生基础已随 [pwsh 执行器与工具决策](2026-08-01-pwsh-tool-and-executor.zh.md) 交付——`ctx.shell` seam 的 PowerShell 实现与对等的 `pwsh` 工具——但交付组合在 Windows 上仍然挂载 bash 栈，没有垫片的 Windows 主机跑不了交付的 shell。

## 决策

启动交付 profile（`dsh web`、`dsh --profile headless`、一次性任务）的 Windows 主机默认获得 PowerShell 栈；POSIX 主机不变。

- **base patch 在自身行上按平台门控两个 shell 栈**（[loader `disabled` 插值](../architecture/2026-08-11-loader-entry-disabled-interpolation.zh.md) note 记录了该机制与平台层折叠）：`bash-sandbox`/`tool-bash` 携带 `disabled: !!js process.platform === 'win32'`（bash 没有 Windows runner），它们的孪生行 `pwsh-sandbox`/`tool-pwsh` 以取反的表达式仅在 win32 挂载——同一份 patch 文件，每个宿主恰好挂载一个 shell 栈。受限 pwsh 栈运行在 ACL 受限令牌 runner 之上，权限面与 POSIX 完全一致（[Windows ACL 受限令牌沙箱](2026-08-08-windows-acl-restricted-token-sandbox.zh.md) note 拥有该清单）。覆盖交付默认是组合决策：偏好 bash 栈或不限权 pwsh 执行器的 Windows 主机通过其 profile 或 home 的 `cordis.patch.yml` 覆盖这些行（bash 恢复配方必须完整：禁用 `pwsh-sandbox`/`tool-pwsh` 并重新启用 `bash-sandbox`/`tool-bash`——两个执行器家族注册同一个 `bash` 服务，配方不完整会在加载时 fail loud）——组合配置是唯一的覆盖通道。独立的 `windows.cordis.patch.yml` 层与启动器的 `apps/cli/src/windows-shell.ts` 注入已删除；该层只因条目元数据是静态的而存在。
- **冷启动的模块解析已恢复。** profiles 重构把 pwsh 包从 `apps/cli` 的依赖闭包中删掉了，`healProfilesModuleFallback` 因此从未把它们链接进 `$DSH_HOME/profiles/node_modules`，新 Windows 主机解析不到 pwsh 行。`apps/cli` 与 `dsh-base` 声明 `dsh-pwsh-sandbox`/`dsh-tool-pwsh`，执行器的依赖链提供 `dsh-pwsh-local`；按仓库惯例，base bundle 把每个行插件都列为依赖。

pwsh GUI 渲染已随 [pwsh UI 呈现与 bash 对齐决策](2026-08-05-pwsh-ui-bash-parity.zh.md) 先行交付；[pwsh 工具与 bash 对齐决策](2026-08-02-pwsh-tool-bash-parity.zh.md) 交付了工具表面。本决策不改变任何 POSIX 行为。

## 备选方案

**在 `dsh-bash-local` 内部让 Windows 默认 pwsh（一个执行器，方言开关）。** 否决，理由与执行器决策否决模式开关相同：执行器的身份就是它 spawn 的 shell，而按平台门控的组合是部署选择，不是执行器配置。

**从 `apps/cli` 代码而非 bundle 数据文件交付平台层。** 否决：patch 应放在它替换的行旁边、属于拥有这些行的 bundle，让交付清单作为组合数据保持可见、转储带有出处；启动器只贡献 win32 门控。

**在 Windows 没有隔离 runner 时保留 `permission`/`ui-permission`。** 最初交付时否决：`dsh-permission-presets` 硬性要求 `ctx.shell.sandboxMode`，并在不限权执行器上加载时 fail loud。后续的 ACL runner 消除了该前提，因此当前清单保留这两行。

**在 Windows 没有 OS runner 时保留 fs 路径规则限制。** 最初交付时否决：不限权 shell 可以绕过仅限 fs 的路径规则。当前 ACL runner 用同一策略约束 shell 与 fs 提供方，因此这项被否决的半边界已不是当前交付形态。

**交付 `DSH_WINDOWS_SHELL` 环境变量逃生门。** 否决：决定性的行为变更应集中在组合配置中，而组合配置已能按行 id 覆盖平台层；第二条覆盖通道会分裂清单决策的单一事实来源。

## 后果

- 运行交付版 `dsh` 表面的 Windows 主机无需配置即获得受限 `pwsh` 作为 shell 工具、PowerShell 作为 `ctx.shell` 执行器；那里的模型可见清单中没有 `bash`。在 Web 表面，shell 工具行来自会话的预设（[loader `disabled` 插值](../architecture/2026-08-11-loader-entry-disabled-interpolation.zh.md) note 拥有 one-plane 机制）：每个 shipped 预设声明 `tool-pwsh`（以 `process.platform !== 'win32'` 门控）及其孪生行 `tool-bash`（取反表达式），因此预设层每台宿主恰好暴露一个 shell 工具。
- Windows 命令与 fs 操作共用沙箱策略、权限切换器和 approval 服务。ACL runner 限制写入，但报告 `enforcement: 'partial'`；显式的 `danger-full-access` 仍是获准的绕过方式，而非平台默认。
- POSIX 主机如常挂载 bash 栈；pwsh 行以其自身的门控表达式处于禁用状态——同一份共享 patch 文件列出两个栈，每个行自己决定挂载。
- 偏好 bash 栈的 Windows 主机（例如 PATH 上有 WSL/Git-Bash 时）通过其 profile 或 home 的 `cordis.patch.yml` 覆盖交付行——禁用 `pwsh-sandbox`/`tool-pwsh` 并重新启用 `bash-sandbox`/`tool-bash`（两个执行器注册同一个 `bash` 服务，配方不完整会在加载时 fail loud）——组合配置是唯一的覆盖通道。

## 验证

- 单元：`apps/cli/tests/windows-shell.spec.ts` 通过启动所用的 patch 算法组合真实交付的 bundle 层（从应用安装解析的 dsh-base + dsh-web-app），固定每个平台的有效清单——win32 pwsh 清单、POSIX bash 清单与 base-only profile——外加预设级 shell 工具门控（`tool-bash`/`tool-pwsh`）与冷启动解析闭包；`packages/bundle/base/tests/base.spec.ts` 固定四个 shell 行的对称 `!!js` 平台门控，并断言不再交付独立的平台 patch。
- Keyless：`dsh --profile <name> --dump-config` 在同一份共享 patch 层中显示两个栈，每个行以自己的 `disabled` 表达式在挂载时决定清单。
- 真实组合冒烟在 win32 上启动 web profile，pwsh 栈挂载成功（即本笔记描述的确切清单）。
