# Agent Note: 修复 pwsh 终端 overlay 的重复 loader 冲突

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-fix-pwsh-terminal-overlay-dup.md) | 中文

## Problem

`apps/web/tests/pwsh-terminal.e2e.ts` 在所有平台上都以 `TypeError: duplicate loader entry id: tool-pwsh` 失败，由 `vendor/loader/src/config/group.ts:64` 在应用 web 组合时抛出。该失败的 seed 通道会启动完整发布的 bundle 加一个测试 overlay，因此 E2E 永远到不了渲染断言，导致 `check:ci:snapshot` 与 `test:web` 每次运行都报一个红的 web 测试，即便被测功能与评审中的改动无关。

web E2E scaffold 在已发布的 Web 表面与 base patches 之后应用 `extraOverlayPath`。`pwsh-terminal.overlay.yml` 用 `insert` 块新增 `tool-pwsh` 行：

```yaml
- insert:
    - id: pwsh-local
      name: '@deepseek-ai/dsh-pwsh-local'
    - id: tool-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh'
```

`insert` 仅在组合中不存在 `tool-pwsh` 时才正确。该 id 存在是因为 `86b6979bdc`（refactor(bundle): fold the Windows shell platform layer into the base rows）把两套 shell 栈以互逆的平台门移进了 base bundle —— `packages/bundle/base/cordis.patch.yml` 声明 `tool-pwsh` 且 `disabled: !!js process.platform !== 'win32'`，于是该行在每个平台都存在于组合中。随后 `42fc7c5ffb`（refactor(preset): gate tool-pwsh by platform alongside tool-bash）往 web-app patch 里加了一行对使用 preset 的表面禁用 `tool-pwsh` 的行；patch 不能引入 id，因此它不是冲突来源。overlay 的 `insert` 于是在同一个 loader 组里再送一个同 id 的行，loader 在启动时拒绝这对重复。

## Decision

把 overlay 对 `tool-pwsh` 的 `insert` 替换成顶层按 id override：

```yaml
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: false
```

有效的 `tool-pwsh` 状态是三层栈：base 行把 `disabled` 门在 `process.platform !== 'win32'` 上，web-app overlay 对 preset 表面无条件设 `disabled: true`，本通道的 override 无论平台都把 `disabled: false` 还回去。`id` 定位的顶层 override 替换组合后的行；只有 `insert` 才会相撞。

该通道现在也按 id 禁用 `pwsh-sandbox`，与既有的 `bash-sandbox` 禁用对称：base 以 `disabled: !!js process.platform !== 'win32'` 门住 `pwsh-sandbox`，因此在 Windows 上它本会与插入的 `pwsh-local` 并存，两者会注册同一个 executor 服务。禁用它让 `pwsh-local` 在每个平台上都是唯一 executor。

overlay 头部注释已更新为完整描述选择，`tool-pwsh` 行内注释现在把 base 行标为该 id 的来源。

## Alternatives considered

**保留 `insert`、改 web 组合。** 拒绝。已发布的 web 组合应在所有使用 preset 的表面上保持 host `tool-pwsh` 行禁用；overlay 才是那条刻意需要该行的通道，因此按 id 启用应放在那里。base 行本身也不能移除：它是所有 bundle 共享的平台门 shell 栈声明。

**在 `insert` 块里启用 `tool-pwsh`。** 不可行。对已存在的 id 做 `insert` 正是这里要修的重复。该行必须按 id 定位，即顶层 override 形式，而非 `insert`。

**只按 id 改 `tool-pwsh` 而不设 `disabled: false`。** 不充分。web-app 无条件设 `disabled: true`，base 行的平台门只在 web-app override 缺失处生效，因此只重申 `name` 的 override 会让行保持禁用，通道渲染不出终端卡。`disabled: false` 是必需的。

**只禁用 `bash-sandbox`、依赖平台门让 `pwsh-sandbox` 保持关闭。** 拒绝。在 POSIX 上成立，但在 Windows 上会失败：base 行让 `pwsh-sandbox` 启用，它会与插入的 `pwsh-local` 在共享 executor 服务上相撞。本通道禁用 `pwsh-sandbox` 让每个平台只有唯一 executor。

## Verification

把修复还原（恢复对 `tool-pwsh` 的 `insert`）即复现同样的 `duplicate loader entry id: tool-pwsh` 启动失败，证实 override 是有效的。修复后同一 head 上 `pwsh-terminal.e2e.ts` 2/2 通过 —— 这作用于 POSIX seam，播种的 pwsh 调用经启用的 `tool-pwsh` 与插入的 `pwsh-local` 渲染出来。该 seed 通道需要可用的 `pwsh`，无此二进制的主机会跳过；本机有 `pwsh`，测试实际跑过。Windows 路径（base `pwsh-sandbox` 与插入的 `pwsh-local` 并存）没有任何 CI lane 覆盖，其 `test:web` 只在 Linux 上跑；overlay 禁用 `pwsh-sandbox` 让该路径在真到 Windows 开发机运行时可组合。

## Consequences

用于执行 PowerShell 启动的 web E2E seed 通道现在能组合而非相撞，因此 `check:ci:snapshot` 与 `test:web` 不再与被测改动无关地在该 duplicate 上失败。该模式具有通用性：`--patch`/`extraOverlayPath` overlay 在决定用 `insert` 还是按 id override 之前，必须探测目标 bundle 是否已存在该行；对已由 base 或已发布 Web 表面声明的 id 做 `insert`，是启动期重复。
