# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 是唯一受支持的 Node 应用启动器；profile 由多个插件组合包 patch 层按顺序叠加而成，其上再应用用户自己的覆盖配置。SDK 与 ACP（Agent Client Protocol）都是 profile，而不是独立的公开可执行命令。Python 运行时 wheel 包中也包含同一个命令；SDK 默认使用 `sdk`，极简示例选择 `sdk-minimal`。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/bin.ts`](src/bin.ts) 只加载选中的运行器。无效命令、来自其他模式的选项，以及致命的配置或启动错误都会以非零状态退出。

## 入口模式

| 命令 | 用途 |
|---|---|
| `dsh <name>` / `dsh --profile <name>` | 启动位于 `$DSH_HOME/profiles/<name>` 的指定 profile。 |
| `dsh --profile <name> --from-default-profile <template>` | 从随附模板创建新的自定义 profile，然后启动它。 |
| `dsh --profile acp` | 通过 ACP stdio 为自动化客户端提供服务，直至断开连接。 |
| `dsh --profile headless "job"` | 运行一个全新的持久化会话，打印最终答案并退出。 |
| `dsh --profile sdk` | 通过 JSON-RPC stdio 为 SDK 客户端提供服务，直至关闭或断开连接。 |
| `dsh --profile sdk-minimal` | 以独立极简 agent（智能体）配置树为 SDK 客户端提供服务。 |
| `dsh web` | 启动 Web profile。 |
| `dsh plugin --profile <name> <pnpm args>` | 通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件。 |

运行命令时所在的目录将作为默认 workspace 根目录。`web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` profile 在首次使用时会从随附模板自动初始化。使用 `--from-default-profile` 可以基于这些模板之一，在尚未使用的非内置名称处创建其他 profile；通过 `dsh plugin` 则可以初始化一个以 base 为基础的 profile。`desktop` 名称保留给 Electron 持有的 profile，因此 CLI（命令行界面）会拒绝针对它的启动、配置 dump 和插件管理请求。

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

profile 目录包含一个 `package.json`，其中记录树外插件依赖，以及 profile manifest（元数据清单）`dsh.profile`、其中按顺序排列的 `bundles` 列表；还包含一个 `cordis.patch.yml`，其中保存用户自己的 patch 层。在 YAML 中启用的 `dsh-hmr` 监视 profile manifest、profile 与 home 级 patch 文件，再通过统一串行重载重新组合所有层。未启用 HMR 时，更改在重启后生效。监听器注册期间发生的编辑与后续编辑使用相同的非致命重载错误报告。[插件管理器](../../packages/boot/plugin-manager/README.zh.md) 与 `dsh plugin` 共享包操作和 profile 写锁；更新依赖会保留已停用的组合包选择。CLI 包操作继承认证环境和终端描述符，支持交互式构建批准；service 调用保留清理后的环境并捕获诊断。

安装和 profile 启动会按声明的 DSH peer 范围，检查与 `dsh --version` 显示值相同的运行时版本。不兼容插件需要用户明确确认精确版本豁免。[插件管理器的兼容性参考](../../packages/boot/plugin-manager/README.zh.md#version-compatibility-and-exemptions)说明 `version-exemptions`、`allow-version`、`revoke-version`、持久化规则与风险。

配置树以空根为起点，依次叠加以下配置层：
- `dsh.profile.bundles` 中各组合包的 patch
- profile 自身的 `cordis.patch.yml`，然后是 home 级的 `$DSH_HOME/cordis.patch.yml`
- `--patch` 指定的覆盖层

`dsh.profile.bundles` 中列出的组合包先从 dsh 安装目录解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-app`、`@deepseek-ai/dsh-sdk-minimal`、`@deepseek-ai/dsh-acp-app`），再从 profile 自身的 `node_modules` 解析；pnpm 会将树外插件安装到该目录。

使用 `--dump-default-config` 和 `--dump-config` 可在不启动的情况下检查组合后的配置树。`--dump-config-schema` 会导入组合树中插件声明的 schema，并打印描述 entry 与 patch 的 JSON Schema，而不是配置值；检查不受信任的插件前，请阅读 [schema dump 的安全性与范围](reference/README.zh.md#config-schema-dump)。

层的确切优先级、flag、关闭行为、部署默认值和源码执行方式，以 [CLI 行为参考](reference/README.zh.md)为准。[启动与重载失败表](../../packages/boot/app-boot/README.zh.md#startup-and-reload-failures)对比 optional、required 插件启动失败与配置 HMR 的行为。

## 可选覆盖层

`config/examples/` 交付 GitHub 评审 webhook、记忆 MCP 服务器与运行时 Cordis 工具的可选覆盖层。它们绝不属于默认 profile；设置与安全说明由[用户指南](../../docs/user/guide/index.zh.md)和[开发实战指南](../../docs/user/develop/practice/index.zh.md)负责。

## 开发

生产运行需要已构建的包与前端产物。请在仓库根目录单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>` 运行 TypeScript 入口并转发所有参数；模块解析约定以[源码执行参考](reference/README.zh.md#source-execution)为准。

`@deepseek-ai/dsh/profile-boot` 导出向 Desktop Host 提供共享 profile 生命周期。已解析的应用 profile 为运行时包解析指定自己的安装锚点，同时沿用 Harness home patch、代理环境、遥测开关、patch 热重载和有界关闭。

[Web 失败矩阵](tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts)在 `test:expected` 中通过构建后的 CLI 验证启动失败与启用 `awaitWriteFinish` 的原生配置 HMR。它不调用模型 API，而是检查经过认证的 HTTP 响应、诊断、恢复、进程退出与 dispose；[启动验收测试](tests/profiles/web/tests/web-best-effort-startup.expected.e2e.ts)还覆盖随附 Web 的必需依赖与端口冲突。
