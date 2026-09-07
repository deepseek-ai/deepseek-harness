# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 是唯一受支持的 Node 应用启动器；profile 由多个插件组合包 patch 层按顺序叠加而成，其上再应用用户自己的覆盖配置。SDK 与 ACP 都是 profile，而不是独立的公开 bin。Python 运行时 wheel 会打包同一个命令；SDK 默认使用 `sdk`，极简示例选择 `sdk-minimal`。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/bin.ts`](src/bin.ts) 只加载选中的运行器。无效命令、来自其他模式的选项、配置错误和启动失败都会以非零状态退出。

## 入口模式

| 命令 | 用途 |
|---|---|
| `dsh --profile <name>` | 启动位于 `$DSH_HOME/profiles/<name>` 的指定 profile。 |
| `dsh --profile acp` | 通过 ACP stdio 为自动化 client 提供服务，直至断开连接。 |
| `dsh --profile headless "job"` | 运行一个全新的持久化会话，打印最终答案并退出。 |
| `dsh --profile sdk` | 通过 JSON-RPC stdio 为 SDK client 提供服务，直至关闭或断开连接。 |
| `dsh --profile sdk-minimal` | 以独立极简 agent 配置树为 SDK client 提供服务。 |
| `dsh web` | `--profile web` 的别名。 |
| `dsh plugin --profile <name> <pnpm args>` | 通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件。 |

运行命令时所在的目录将作为默认 workspace 根目录。`web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 在首次使用时会从随附模板自动初始化；其他任何 profile 都必须通过 `dsh plugin` 创建。`desktop` 名称保留给 Electron 持有的 profile，因此 CLI 会拒绝针对它的启动、配置 dump 和插件管理请求。

## 应用参数

启动器只解析自身的 flag，并将其后的所有内容交给已启动的 profile；注入该 profile 的任意应用插件都可以解析这份共享的不可变快照（[`dsh-cmdline`](../../packages/boot/cmdline/README.zh.md)）。启动器无法识别的第一个 token 标志着应用参数的开始：

```sh
dsh --profile web --port 8080       # --port belongs to the web app
dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
dsh --profile headless "run the tests"
dsh --profile web --help            # the web app's flags, not the launcher's
dsh --help                          # the launcher's own help
```

<a id="profiles"></a>
## Profile

profile 目录包含一个 `package.json`，其中记录树外插件依赖，以及 profile manifest（元数据清单）`dsh.profile`、其中按顺序排列的 `bundles` 列表与 `patchReload` 生命周期；还包含一个 `cordis.patch.yml`，其中保存用户自己的 patch 层。`patchReload: live` 监视 profile 与 home 级 patch 文件，`startup` 则只应用一次。

配置树以空根为起点，依次叠加以下配置层：
- `dsh.profile.bundles` 中各组合包的 patch
- profile 自身的 `cordis.patch.yml`，然后是 home 级的 `$DSH_HOME/cordis.patch.yml`
- `--patch` 指定的覆盖层

`dsh.profile.bundles` 中列出的组合包先从 dsh 安装目录解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-app`、`@deepseek-ai/dsh-sdk-minimal`、`@deepseek-ai/dsh-acp-app`），再从 profile 自身的 `node_modules` 解析；pnpm 会将树外插件安装到该目录。

使用 `--dump-default-config` 和 `--dump-config` 可在不启动的情况下检查组合后的配置树。

层的确切优先级、flag、关闭行为、部署默认值和源码执行方式，以 [CLI（命令行界面）行为参考](reference/README.zh.md)为准。

## 可选 Overlay

`config/examples/` 交付 GitHub 评审 webhook、会话内 Schedule、记忆 MCP 服务与运行时 Cordis 工具的可选 overlay。它们绝不属于默认 profile；安装与安全说明由[用户指南](../../docs/user/guide/index.zh.md)和[开发实战指南](../../docs/user/develop/practice/index.zh.md)负责。

## 开发

生产运行需要已构建的包与前端产物。请在仓库根目录单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>` 运行 TypeScript 入口并转发所有参数；模块解析约定以[源码执行参考](reference/README.zh.md#source-execution)为准。
