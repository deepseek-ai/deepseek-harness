# Agent Note: Loader 插值条目 `disabled` 字段

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-loader-entry-disabled-interpolation.md) | 中文

## 问题

Windows 平台层（当时是 base patch 旁独立的 `windows.cordis.patch.yml`，现已折入 base 行——见「决策」）在 win32 上禁用 `tool-bash`，但 shipped 预设各自挂载了一行 `tool-bash`。预设行最后组合，同名行在 Windows 上重新启用了该工具——会话同时拥有 `tool-bash`（PowerShell 后端）与 `tool-pwsh`，且是静默的，因为没有 spec pin 组合后的预设层。条目元数据没有条件机制：`!!js` 只在插件 `config` 下插值，[postmortem 0002](../../../../docs/postmortem/0002-js-expression-disabled-filesystem-tools.zh.md) 记录了 `disabled: !!js ...` 保持真值表达式对象、在所有平台上禁用该行的事故。

## 决策

Loader 插值条目 `disabled` 字段（`vendor/loader/src/config/entry.ts`）：`!!js` 表达式在每次挂载决策时基于 loader 上下文求值。`disabled` 是唯一被插值的元数据字段；`id`、`name`、`group`、`inject` 保持静态。原始节点保留在 options 中，写回保持 `!!js` 形式。shipped 预设（standard、code、cordis）自己声明 shell 工具行并按平台门控——`tool-bash` 携带 `disabled: !!js process.platform === 'win32'`，其孪生行 `tool-pwsh` 以取反的表达式——因此预设层每台宿主恰好暴露一个 shell 工具；web-app overlay 禁用两个工具的 host 行，由每个会话的预设决定。`verify-cordis-config` 现在只允许 `disabled` 中的表达式。

该机制补全了平台层折叠：base bundle 的 `cordis.patch.yml` 在自身行上按平台门控两个 shell 栈——`bash-sandbox`/`tool-bash` 携带 `disabled: !!js process.platform === 'win32'`，它们的孪生行 `pwsh-sandbox`/`tool-pwsh` 以取反的表达式仅在 win32 挂载。启动器的独立 Windows 平台层（`windows.cordis.patch.yml` 以及 `apps/cli/src/windows-shell.ts` 及其注入到 boot、live 重组合、config dump 的逻辑）被删除——该层只因条目元数据是静态的而存在，`disabled` 可插值后条件就落在它所治理的行上。

## 备选方案

**行上的声明式 `platform` 字段。**静态且可被门禁检查，但它是 `!!js` 之外的第二种组合机制，而平台只是众多部署条件之一。

**预设级平台 overlay。** 被否：条件应当属于它所治理的行——同一原则把启动器独立的 Windows 平台层折入 base 行。

## 后果

行可以按平台或环境门控自身；错误的表达式在启动时响亮失败。其余元数据字段保持字面值，门禁继续拒绝那里的表达式——`disabled` 上的 postmortem-0002 隐患以「求值」而非「禁止」关闭。Windows shell 栈的切换从启动器注入的 patch 层移到 base bundle 自身的行上：win32 挂载受限 pwsh 栈，POSIX 携带被禁用的 pwsh 行，同一份 patch 文件服务两种阵容——[Windows 默认 pwsh](../feature/2026-08-01-windows-pwsh-default.zh.md) note 的层机制已被取代。shell 工具行遵循与其他预设声明行相同的 one-plane 规则：web-app overlay 禁用 host 面的 `tool-bash`/`tool-pwsh` 行，预设以互逆的平台门控声明两者，因此任一宿主的每个会话都可以按预设丢弃或替换 shell 工具。`minimal` 预设缺失的 win32 PTY 栈是预设元数据的后续工作。
