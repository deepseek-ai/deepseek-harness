---
description: "随 profile 安装官方飞书 lark-cli，让后端与 Shell 按名称调用它，并加载其内嵌 skill。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu

[English](README.md) | 中文

## 概述

飞书插件随 profile 安装固定版本的 `@larksuite/cli`，把其 `lark-cli` 可执行文件放到私有 Shell PATH 上，并注册该 CLI（命令行界面）内嵌的 skill（技能）。agent（智能体）通过普通 Shell 工具按名称运行 `lark-cli`；后端用同一个可执行文件读取 skill。应用配置与登录在对话中通过 CLI 自带的流程完成，CLI 把凭据保存在默认配置中，用户自己的终端也共用这份配置。仅支持 macOS。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

将本包作为 bundle 安装，例如在 Web 侧栏的**插件**页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-feishu
```

bundle patch 在 profile 其他层之后插入 `feishu` 行。pnpm 会拦截 `@larksuite/cli` 的安装脚本，该脚本从 GitHub Releases 或 npmmirror 下载官方原生二进制并校验 checksum；请在插件页面通过**允许这些脚本并重试**批准，或使用 [Plugin Manager](../../boot/plugin-manager/README.zh.md) 记载的其他途径。在可执行文件就绪之前，插件加载会失败，错误信息会给出缺失的路径。

### 获得的能力

插件加载后，CLI 内嵌的 skill（例如 `lark-doc` 与 `lark-shared`）进入 skill 目录。agent 用 `skill` 工具加载其中一个，并在当前沙箱与审批策略下通过普通 Shell 工具运行 `lark-cli` 命令。命令报告缺少应用配置或登录时，agent 按 CLI 的流程操作：向用户提供验证链接和二维码，用户确认后完成登录。保存登录状态的命令会在工作区之外写入，因此会申请单条命令审批。

在 Plugin Manager 中关闭该行会为后续 Shell 调用撤下 skill 与私有 PATH 条目，CLI 配置与登录保持不变。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `binDir` | 已安装 `@larksuite/cli` 包的 `bin` | 包含可执行 `lark-cli` 的绝对目录 |
| `commandTimeoutMs` | `30000` | 单条后端 skill 命令的期限，包含可执行文件查找 |
| `maxOutputBytes` | `1048576` | 单条后端 skill 命令保留的 stdout 字节上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu)是受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`src/index.ts`](src/index.ts) 要求 subprocess 运行时位于本 Host，检查 `binDir/lark-cli` 是否可执行，把 `binDir` 作为 `feishu` PATH 贡献注册到 [Shell 环境](../../shell/shell-env/README.zh.md)，并注册 skill 提供方。[`src/cli.ts`](src/cli.ts) 为 subprocess 运行时准备私有 PATH 环境，在其中解析 `lark-cli`，并用同一环境启动解析结果，使后端与 Shell 使用同一个可执行文件。每条命令收集有上限的 stdout 和 stderr 尾部，拒绝非零退出码或被截断的 stdout，并等待其受管进程范围退出。释放时中止正在运行的命令，并在这些进程退出后完成。

[`src/skills.ts`](src/skills.ts) 每次注册只运行一次 `lark-cli skills list --json`。目录读取失败时记录一次日志，并在插件重新加载前保持为空。每次加载运行 `skills read <name> --json`，去掉 frontmatter，把 DSH 指引放在厂商正文之前，把 CLI 的引用文件读取指引放在之后。引用文件内嵌在二进制中，因此 skill 的资源基址是 opaque 类型。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [Shell 环境](../../shell/shell-env/README.zh.md)——后端 subprocess 与 Shell 工具共用的私有 PATH 贡献。
- [Skills](../../../docs/subsystems/skills.zh.md)——目录发布、加载与优先级。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装、构建脚本审批与启用。

-----

<a id="model-experience"></a>
## 模型体验

### Skill 目录条目

#### 模型看到什么

`lark-cli skills list --json` 报告的每个 skill 都以厂商名称和描述出现在 skill 目录中；过长的描述由目录所有者缩短。`lark-cli` 1.0.97 报告 28 个 skill。

#### Token 影响

插件加载期间这些条目一直留在上下文中。对 `lark-cli` 1.0.97 而言，合计约 6,000 个字符。

#### KV Cache 影响

同一 CLI 版本的目录固定不变。加载或卸载插件会改变目录，目录作为新消息重新发布，不改动更早的上下文。

### 已加载的 skill 正文

#### 模型看到什么

`skill` 工具结果依次包含下方 DSH 指引、去掉 frontmatter 的厂商 `SKILL.md` 正文，以及 CLI 关于用 `lark-cli skills read <name> <relative-path>` 读取引用文件的指引。其资源描述为 `Embedded lark-cli references; use the skills read command given in the loaded skill.`

##### DSH 指引

```markdown
# Feishu in DSH

Call this integration the Feishu plugin (飞书插件 in Chinese) in user-facing replies. Run `lark-cli` by name in the Host Shell; DSH installs and updates it. It uses the default lark-cli configuration and sign-in shared with the user's own terminal, so do not remove, switch, or sign out of apps or profiles unless the user asks.

When a command reports a missing app configuration or sign-in, load the lark-shared skill and follow its setup and auth flow. Never ask for or print app secrets or tokens.

Commands that save sign-in state, such as `auth login --device-code` and `config init`, write outside the workspace and use up their one-time authorization even when the save is denied: run them with the Shell tool's single-command approval from the start. Run other commands in the existing sandbox and request that approval only when a credential, lock, log, or cache write is denied.

Do not install another lark-cli or run `lark-cli update`.
```

#### Token 影响

每次加载把固定指引与一份厂商正文加入保留的工具历史。通过 `lark-cli` 读取的引用文件作为普通 Shell 输出返回。

#### KV Cache 影响

加载会追加一条工具结果，不改写更早的上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS。其他平台未经验证，且不会定位 Windows 可执行文件名 `lark-cli.exe`。
- 插件要求 subprocess 运行时位于本 Host；组合中的 subprocess 运行时在别处运行（例如通过 SSH）时，插件加载失败。
- 插件使用 CLI 的默认配置。在 DSH 中登录或退出会影响用户自己的终端，没有 DSH 私有账号或账号选择器。插件不提供解绑操作；关闭插件会保留配置与登录。
- Host 端没有账号状态或账号操作；配置与登录在对话中完成。
- 在文件沙箱下，普通命令中的 token 刷新可能被拒绝，此时需要单条命令审批。
- skill 目录读取失败后，在插件重新加载前保持为空。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

仓库安装在根目录 `pnpm-workspace.yaml` 中拒绝 `@larksuite/cli` 的安装脚本，因此检出的仓库没有原生二进制。要在源码中用真实 CLI 运行插件，请执行一次 `node packages/connector/feishu/node_modules/@larksuite/cli/scripts/install.js`。单测与 `feishu-skills` 会话快照通过 `binDir` 使用替身可执行文件。

</details>
