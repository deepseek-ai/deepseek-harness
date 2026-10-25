---
description: "在本地或 Windows／macOS Actions 中生成 Desktop 安装包，选择部署与签名模式，并获取产物和诊断。本指南区分构建操作、发布与已安装应用验收。使用硬件凭据前，必须检查平台签名要求与共享 runner 风险。"
---

# Desktop 打包

[English](README.md) | 中文

## 概述

在本地或 Windows／macOS Actions 中生成 Desktop 安装包，选择部署与签名模式，并获取产物和诊断。本指南区分构建操作、发布与已安装应用验收。使用硬件凭据前，必须检查平台签名要求与共享 runner 风险。

## 目录

- [选择打包方式](#choose-a-build)
- [发布版本](#release-versions)
- [配置与本地构建](#configuration-and-local-builds)
- [Windows Actions 打包](#windows-actions)
- [macOS 自托管打包](#macos-actions)
- [未签名 Windows 测试安装包](#unsigned-windows-test-installer)
- [无发布签名的本地 macOS DMG](#local-macos-dmg-without-release-signing)
- [macOS 发布签名与诊断](#macos-release-signing)
- [目录构建与准备](#directory-and-preparation)
- [用回环 registry 安装本地 Official 包](#local-official-bundles-from-a-loopback-registry)
- [运行时文件筛选与安装检查](#runtime-file-selection)
- [Desktop 运行时准备](#desktop-runtime-preparation)
- [安装与发布验收](#verification)

<a id="choose-a-build"></a>

## 选择打包方式

安装锁定依赖后，从仓库根目录运行本地命令。本地构建使用平台命令，已注册的自托管 runner 使用对应平台的 Actions。test/production 部署与 signed/unsigned 模式分别选择。任何 Windows 签名构建或共享 runner 使用前，先阅读 [Windows 签名与 runner 运维](../windows-signing/README.zh.md#trust-and-isolation)。安装与打包分开进行；[发布](../publishing/README.zh.md)还需要单独的显式操作。

将 `DSH_DESKTOP_PACKAGE_CACHE_DIR` 设为绝对构建缓存目录以跨 checkout 复用；详见[缓存配置与生命周期](#desktop-runtime-preparation)。

<a id="release-versions"></a>

## 发布版本

每次 Desktop 打包前，第一步都要与当前用户确认完整版本号。检查所选部署环境、dsh 基础版本、保留的发布记录和已发布对象，再提出准确版本供用户确认。用户确认前不得启动打包；仅选择部署环境不代表用户已认可版本号。

记录当前 dsh 版本作为基础版本。production Desktop 使用完全相同的版本，包括其中的 `alpha`、`beta` 或 `rc` 标识。test 发布保留完整的预发布基础版本并追加 `.YYYYMMDD.index`；稳定基础版本则追加 `-test.YYYYMMDD.index`。

| dsh 基础版本 | production Desktop | test Desktop 示例 |
|---|---|---|
| `0.1.6-alpha.1` | `0.1.6-alpha.1` | `0.1.6-alpha.1.20260916.1` |
| `0.1.6-beta.2` | `0.1.6-beta.2` | `0.1.6-beta.2.20260916.1` |
| `0.1.6-rc.3` | `0.1.6-rc.3` | `0.1.6-rc.3.20260916.1` |
| `0.1.6` | `0.1.6` | `0.1.6-test.20260916.1` |

日期使用实际创建时的 Asia/Shanghai 日期。每个基础版本、每天的序号从 1 开始，检查保留的发布记录与已发布对象后递增；绝不复用已发布版本。test 分发不发布对应的无后缀基础版本。

Desktop 手动 CI 使用独立的未发布构建标识：`auto` 追加 UTC 日期、工作流运行编号和尝试次数（`.YYYYMMDD.run.attempt`，稳定基础版本使用 `-test`）。例如 `0.2.1-alpha.1.20261008.42.2`。这些编号不是预留的发布序号。

把确认后的版本通过 `--build-version` 传给打包命令，该值同时决定产物文件名、更新 feed 与上传校验。清单保留产品版本，因此 test 打包不再改写发布家族，也不留下需要还原的改动：

```sh
pnpm --dir apps/desktop run package:win:x64 --build-version 0.1.6-alpha.1.20260916.1
```

`--build-version auto` 会给出当天的下一个序号：读取目标 bucket 中已发布的对象，未配置 bucket 或列举未能在期限内完成时回退到本目标的本地输出目录。上传前请确认它打印的版本号；run script 会自行透传 `--`，打包入口两种写法都接受。

production 发布使用产品版本本身，不传 `--build-version`。其上传成功后会把打包所用 commit 打成 `desktop-v<版本>` 标签；来自有改动工作区的构建不打标签，打标签失败也只打印手工命令，不会让已完成的上传变成失败。test 与本地构建有意不留标签，而所有产物的清单都记录 `dshBuildCommit` 与 `dshBuildDirty`，直接分发的构建同样可溯源。

安装包独立于版本和发布环境内置 `DSH_DESKTOP_UPDATE_CHANNEL`（默认 `nightly`，也可选择 `latest`）。自动更新始终保留该通道，即使安装的是稳定版本；手动安装另一通道的包才会切换。latest 包拒绝预发布版本。稳定产品可生成 nightly 的 `-test.<date>.<sequence>` 构建，但该版本低于稳定基准，不能升级已安装的更高版本。保持自动降级关闭；稳定修复版需要提升产品版本。CI 版本选择与发布见 [CI 发布](../publishing/ci/README.zh.md#package-and-publish)。

<a id="configuration-and-local-builds"></a>

## 配置与本地构建

macOS 和 Windows 未签名安装包使用与本地 Web 构建相同的本地化 **DSH 本地构建** 标签及版本/commit 徽标。签名安装包保留官方品牌，包括 test 部署和跳过公证的 macOS 构建。原生应用及安装器名称不变。

本地 Windows 命令通过 `DSH_PACKAGING_CONFIG_DIR` 指定机器配置绝对目录，通过 `DSH_PACKAGING_PRESET` 选择 `test` 或 `production`。加载器读取 `presets/<preset>.env`；签名命令另读 `secrets/windows-signing.env`。相对证书和 SignTool 路径以声明它们的文件所在目录为基准。公开 preset 拒绝凭据，签名文件不能覆盖公开配置。配置缺失立即失败，不回退到 `.env.windows`；不选择 preset 的命令保留原 dotenv 行为。未签名和仅准备 preset 不读取签名文件。缓存维护也只读取公开 preset 配置。签名测试包还需现有下载 origin 和 release ID，但无需上传凭据。本地 preset 命令使用 `--build-version auto` 时仅按本地产物编号；Actions 使用运行编号和重试次数。

两个手动打包工作流都接受 `test_release_id`。留空沿用机器 preset；非空值必须是 32 位小写十六进制字符串，且仅允许 test preset。加载器通过 `PACKAGE_TEST_RELEASE_ID` 应用覆盖值，不修改 preset 文件。同一平台连续升级测试需使用相同值。轮换默认值只影响后续构建：已安装客户端保留原更新地址，旧对象仍可访问，除非另行删除。随机前缀降低地址的可发现性，但不提供下载身份认证。

不选择机器 preset 时，打包、上传以及手动 macOS 签名检查（本地 macOS 未签名构建除外）使用 `apps/desktop/.env.windows` 或 `.env.macos`，由目标平台选择。复制对应的 [Windows 模板](../.env.windows.example) 或 [macOS 模板](../.env.macos.example)，填写本机配置；Git 忽略这两个本地文件，安装产物也不包含它们。发布字段只从选定的配置文件读取，不回退到系统或 shell 中的同名变量；`PATH`、代理和构建工具环境仍保留。发布版本是命令参数而非发布字段，上传从打包写下的完成记录中读取它。文件使用 UTF-8，支持 BOM；相对证书、SignTool、Apple API Key 和钥匙串路径以 `apps/desktop` 为基准，变量值不做 shell 展开，包含 `#` 或空格的密码需要引号。Windows CI 读取相同的机器 preset。

每条打包命令在构建与下载前检查应用 ID 以及该模式需要的更新与签名配置，随后探测本次运行要用的外部工具：归档读取工具，以及 Windows 目标的安装器编译器。macOS 检查身份、Team ID、一套完整公证凭据、`CSC_LINK` 指定的可读本地 p12 文件、显式配置的 `CSC_KEY_PASSWORD`，以及引用的 API Key 和钥匙串文件；Windows 检查公开代码签名证书、SignTool 文件、容器名称和 PIN 格式。仅准备 Windows 资源以及两个平台上的显式未签名打包均不要求签名凭据。配置检查不验证 PIN 是否正确、Token 是否登录、钥匙串是否解锁或 Apple 是否接受凭据；实际签名与公证负责这些检查。未选择机器 preset 时，`--build-version auto` 会访问目标 bucket，`--check` 下同样如此。单独运行相同检查：

```sh
pnpm --dir apps/desktop run check:package
```

无需提前执行 `prepare:desktop`：

```sh
pnpm run package:desktop
```

发布自动化使用固定目标命令，确保运行时准备、dsh 准备与 electron-builder 接收相同的平台和架构：

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

macOS arm64 命令要求 Apple Silicon。macOS x64 命令可以在 Intel macOS 或带 Rosetta 的 Apple Silicon 上运行。Windows x64 命令要求 Windows x64。Linux 不是受支持的 Desktop 发布目标。

macOS 正式发布和本地未签名 DMG 都通过 [electron-builder 配置](../scripts/electron-builder-config.mjs)中的 `dmg.format: 'ULMO'` 使用 LZMA 压缩。[构建时补丁](../../../patches/app-builder-lib@26.17.0.patch)为固定版本 builder 的校验规则和 TypeScript 声明添加此格式。

每个目标都在 `apps/desktop/.desktop-build/targets/<target>/` 下持有自己的打包输入、已准备运行时、包集合、dsh 依赖树、pnpm 准备状态、未打包应用、更新元数据和最终产物。Electron 归档缓存继续由 `.desktop-build/downloads` 共享，因为每个归档文件名都包含版本、平台和架构，并且在解包前经过验证。目标构建绝不读取其他目标的可变准备状态。

<a id="windows-actions"></a>

## Windows Actions 打包

runner 的受监督启动和恢复见 [Windows runner 机器准备](../windows-signing/README.zh.md#machine-setup)。

`Package Desktop · Windows` [手动工作流](../../../.github/workflows/windows-package.yml) 选择专用 Windows x64 runner 标签 `dsh-win-package-trial`，并使用机器 preset `test` 或 `production`。选择 `signed`（默认）或 `unsigned`；签名模式复用现有 EV token 预检、签名缓存与失败 interlock，不发布或上传 release。`build_version` 默认为 `auto`，使用[发布版本](#release-versions)中的 CI 标识；显式值可以是源码产品版本，或扩展构建版本，例如产品 `0.2.1-alpha.1` 对应 `0.2.1-alpha.1.20261009.1`。版本前缀必须匹配所选源码；校验错误显示其当前示例。manifest 保持不变。

在 Actions 选择工作流、源码分支、preset、签名模式和版本，再点击 Run workflow。输入变更合并前，用 `gh workflow run windows-package.yml --ref <branch> -f preset=test -f signing=unsigned -f build_version=auto` 测试已推送分支；合并后验证网页表单。它不监听 push 或 PR。日志和成功生成的 EXE 保留 14 天。依赖打包流程前检查日志和安装包；安装是独立操作。检出前，Node 删除 runner 专用源码目录，不跟随依赖 junction；工作流校验目标位置并拒绝链接祖先目录。不得指向日常开发目录。运行共享一个并发组，不取消正在进行的构建；最多保留一个待运行任务，新触发会替换它。仅在成功完成干净检出后上传诊断。机器配置位于 checkout 之外，不作为产物上传。

在 Actions 打开完成的运行并下载 Artifacts。`windows-x64-signed-<version>-<run_id>-<run_attempt>` 与 `windows-x64-unsigned-<version>-<run_id>-<run_attempt>` 包含对应 EXE；`windows-package-logs-<run_id>-<run_attempt>` 包含打包诊断。上传步骤名为 `Retain verified signed installer`、`Retain verified unsigned installer` 和 `Retain packaging diagnostics`；步骤耗时与带时间戳的日志显示上传用时。这些产物不等于发布 Release 或下载站内容。

测量 Windows 构建路径对性能的影响时，可用 `build_root` 指定现有 Git checkout 之外的绝对目录。每轮任务将已验证的源码提交克隆到新的 `windows-package-<run-id>-<attempt>/source` 目录；不会复制忽略文件或此前的构建输出。仅打包进程通过 `TEMP` 和 `TMP` 使用同轮所属的同级 `temp` 目录；Actions 步骤及 Job 后置钩子保留原临时目录。依赖缓存和签名缓存沿用原有位置。成功任务在产物上传后仅删除本轮所属的 checkout，临时文件系统错误最多重试三次，等待时间按 100 ms 递增；持续清理失败会使 Job 失败，并可能留下部分删除的目录。构建失败时保留 checkout 供检查。输入留空时使用原 Actions checkout。完整 Job 耗时须包含 checkout 创建和清理。

测量缓存时，`cache_namespace` 为两个依赖 store 和上游下载选择保留的子目录；留空使用正常共享缓存。新名称用于冷缓存采样，再次使用同名用于热缓存采样。名称由 1–64 个小写字母、数字或连字符组成，以字母或数字开头，且不能为 Windows 设备名。这不会重置独立的签名缓存或操作系统文件缓存；应将其状态、Job 开始至完成的总耗时与阶段耗时和产物体积一并报告。workflow 在依赖安装前记录 Node 版本、可用 CPU 并行数、逻辑 CPU 数及总内存和空闲内存。

依赖安装和打包步骤在启动子进程前，将自身 shell 的 CPU、I/O 和内存优先级调整为普通值。优先级及独立构建目录辅助脚本从 workflow 的精确提交复制到本轮临时目录，与选中的产品源码分离。缺失辅助脚本会终止 CI 准备；无法调整优先级时明确告警并标记调度条件不适合性能对比，但继续打包。这不会修改 runner 任务或其他进程。版本、preset 和产物留存适配器仍跟随产品源码及其格式。

安装器上传直接存储已经压缩的发布文件，不再进行 ZIP 二次压缩；安装器字节和签名保持不变。诊断日志上传保留通常的压缩方式。

<a id="macos-actions"></a>

## macOS 自托管打包

`Package Desktop · macOS` [手动工作流](../../../.github/workflows/macos-package.yml) 使用带有 `dsh-mac-package-trial` 标签的 Apple Silicon runner。它选择 `test` 或 `production`，以 UTC 日期、运行编号和重试次数解析 `build_version=auto`，并复用现有签名、公证和打包运行时检查。安装包上传关闭重复 ZIP 压缩；诊断日志保留普通压缩。成功的 DMG／ZIP 与诊断日志保留 14 天；工作流不发布 release。操作人员须注册 runner，并验收完整 Actions 运行后再依赖该流程。 `zip_compression_level` 下拉选项默认为 `3`，也可选择 `7`；本次运行以该选项覆盖机器预设，只影响 ZIP 和自动升级下载，不影响 DMG。

运行 `node apps/desktop/scripts/setup-macos-packaging.mjs "$HOME/dsh-ci"` 创建私有 `runner/`、`packaging/{presets,secrets,certificates}` 和 `cache/macos-signatures` 目录，不覆盖已有文件；追加 `--check` 仅检查。在 checkout 外填写 [preset](../config/macos-packaging/test.env.example) 和[签名](../config/macos-packaging/macos-signing.env.example)模板，将秘密和证书文件权限设为 `0600`。`DSH_PACKAGING_CONFIG_DIR` 指定 `packaging` 的绝对目录，`DSH_PACKAGING_PRESET` 选择其中的 preset；缺少文件立即失败，不回退到 `.env.macos`。Mac 签名和仅准备构建读取 `secrets/macos-signing.env`，相对凭据路径以该文件所在目录为基准。公开 preset 拒绝签名凭据，签名文件不能覆盖公开配置。本地未签名 Mac 构建保留无需配置的行为。

运行 `bash apps/desktop/scripts/start-macos-packaging-runner.sh "$HOME/dsh-ci/runner" "$HOME/dsh-ci/packaging" <absolute-node-24-bin-directory> --check` 检查宿主工具和配置文件。脚本同时选择当前 Xcode 及其 macOS SDK，并编译小型链接探针。注册后省略 `--check`，清理继承环境并在前台启动 runner，存活期间阻止空闲睡眠。安装下方服务前，先用 Ctrl-C 停止。runner 拥有 `_work` 下的源码目录，与日常开发分开。该账户可读取签名文件，因此只执行可信代码。沿用现有公证代理恢复规则；强制终止后，先检查保留的恢复记录再构建。新建模板将 `DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR` 设为 checkout 外 `cache/macos-signatures` 的绝对路径。已有部署重新运行 setup 后，在各 preset 中补上该字段；已有文件保持不变。这样可跨干净检出保留签名；缓存验证和容量限制见 [macOS 签名](#macos-release-signing)。


无论是否公证，ZIP 都使用同一压缩配置；App 只组装一次，再分别生成 DMG 和 ZIP，确保 ZIP 设置不改变 DMG 压缩。工作流选项 `skip_notarization` 默认为 `false`；对应 CLI 参数是 `--skip-notarization`。该模式保留 Developer ID 签名、DMG 签名验证和打包运行时验证，跳过 Apple 公证和 stapling，不要求 Apple 公证凭据。DMG／ZIP 文件名带 `-unnotarized`，存放于 `.desktop-build/targets/<target>/unnotarized-artifacts/`，上传产物标为 `unnotarized-debug`。这些产物仅供内部调试：Gatekeeper 可能阻止下载副本运行，不能视为可分发包或用于更新发布。该模式不写入发布完成记录，不能与未签名、Windows 或仅准备构建组合。

在 checkout 中，以注册 runner 的同一账户安装用户服务，不使用 `sudo`：

```sh
bash apps/desktop/scripts/macos-runner-service.sh install "$HOME/dsh-ci/runner" "$HOME/dsh-ci/packaging" /opt/homebrew/opt/node@24/bin
bash apps/desktop/scripts/macos-runner-service.sh start "$HOME/dsh-ci/runner"
bash apps/desktop/scripts/macos-runner-service.sh status "$HOME/dsh-ci/runner"
```

安装脚本将启动脚本复制到 `runner/dsh-service`，将服务 PATH 设为 Node 24 和系统工具，并使用 GitHub 的 `svc.sh` 与 `runsvc.sh`。LaunchAgent 在 SSH 断开后继续运行，但重启后需要该账户登录桌面，注销桌面时停止。FileVault 磁盘解锁仍由操作人员完成，这不提供无人值守开机。日志位于 `runner/dsh-service/stdout.log` 和 `stderr.log`；验收时确认出现 `Connected to GitHub` 与 `Listening for Jobs`。更新已安装的启动脚本或工具路径时，等待 runner 空闲，依次执行 `stop`、`uninstall`，再重新安装。这两个操作都不会注销 runner 或删除打包凭据。卸载保留 `runner/dsh-service`（包括日志）和显式 `.path`；重新安装会替换启动快照和 PATH。

<a id="unsigned-windows-test-installer"></a>

## 未签名 Windows 测试安装包

在 Windows x64 上，使用完整的未签名打包命令进行本地安装测试：

```sh
pnpm run package:desktop:win:x64:unsigned
```

该命令读取 `.env.windows`，要求设置 `DSH_DESKTOP_APP_ID` 和[强制更新策略配置](../README.zh.md#mandatory-update-policy)，包括真实的 HTTPS 服务 origin。本机验收和 CI 使用 Node 24；其他工具为根 `packageManager` 固定版本的 pnpm、Git、PowerShell 7（`pwsh`）、tar、Python、Visual C++ Build Tools 和 Windows SDK。Python 不在 `PATH` 中时设置 `PYTHON`。命令将安装包写入 `.desktop-build/targets/win-x64/unsigned-artifacts/`，省略普通自动更新配置，清除签名凭据，且不生成发布完成记录。无需 EV 或上传凭据。签名打包和上传仍遵循正式发布要求。

先运行 `pnpm install --frozen-lockfile`，再运行 `pnpm run package:desktop:win:x64:unsigned --check` 校验配置和工具，最后执行上面的完整命令。打包自行执行完整构建和隔离的运行时 smoke，不调用在线模型。阶段日志保留在 `.desktop-build/packaging-runs/`；仅构建成功不代表安装包验证通过。依赖安装和运行时准备需要访问 npm、GitHub release 资源和 nodejs.org；网络需要时使用现有 registry 和代理配置。缓存与工具位置属于构建机器配置，不在跟踪文件中固定个人路径。

<a id="local-macos-dmg-without-release-signing"></a>

## 无发布签名的本地 macOS DMG

执行 `pnpm install` 后，在仓库根目录运行一条命令即可，无需 `.env.macos`、Apple 账号、证书或更新服务配置：

```sh
pnpm run package:desktop:mac:arm64:unsigned
pnpm run package:desktop:mac:x64:unsigned
```

添加 `--check` 仅验证本地配置和工具而不构建，或添加 `--dir` 只生成解包应用。DMG 路径为 `apps/desktop/.desktop-build/targets/<target>/unsigned-artifacts/deepseek-harness-<version>-mac-<arch>-unsigned.dmg`。所有检查通过后，命令打印 `DMG:` 及其绝对路径。打开后将应用复制到本地测试目录。

这些命令忽略 `.env.macos` 和继承的发布配置，使用 `com.deepseek.harness` 作为应用 ID，并省略自动更新和强制更新配置。构建工具、标准网络代理与 `DSH_DESKTOP_NPM_REGISTRY` 仍可从 shell 提供。它们跳过 Developer ID 签名、Apple 公证、临时签名钥匙串和公证代理修改。Electron 使用无需证书的本地 ad-hoc 签名，以便修改后的可执行文件能够运行；DMG 不签名。准备阶段和组装后的应用仍执行运行时完整性与冒烟检查。本地构建不生成更新源、ZIP 或发布完成记录，上传命令无法发布这些产物。macOS 可能要求在“系统设置 → 隐私与安全性”中批准打开未经公证的应用。

<a id="macos-release-signing"></a>

## macOS 发布签名与诊断

macOS 签名配置使用必填发布环境，不会接受钥匙串中最先发现的证书。空值、格式错误的 Team ID、包含 electron-builder 不支持的 `Developer ID Application:` 前缀的签名身份，以及不完整的公证凭据都会被拒绝。macOS 签名打包要求已配置的身份及其私钥可用。运行时准备会把该身份、安全时间戳与 hardened runtime 应用到每个内嵌 Mach-O 文件；应用签名完成后，深度严格检查会拒绝其他叶证书 Authority 或 Team ID，验证通过才生成发布产物。macOS 签名固定目标安装包命令为已签名应用创建独立副本，并发执行两条产物流。一路先公证 App 并钉票，再生成 ZIP 及其更新元数据。另一路把已签名 App 副本封装进签名 DMG，再公证 DMG、钉票并验证；其中的 App 不单独附加票据。只有两路均成功结束，产物才会移入最终目录并写入发布完成记录。签名的仅目录命令同样需要公证凭据，并等待 Apple 公证和 App 钉票完成。[并行公证决策](../../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.zh.md)负责副本隔离与容器票据语义。`CSC_LINK` 必须指向包含 Developer ID Application 证书及私钥的本地 p12，不支持 URL 或 Base64 输入。`CSC_KEY_PASSWORD` 是其导出密码，不是 Apple 账号或登录密码；未加密的 p12 可显式填写空值。构建前，打包流程自动创建并解锁私有临时钥匙串、导入 p12、授权签名并签署小型探针。运行时与 App 签名显式使用该钥匙串，无需预先配置或手动解锁登录钥匙串。子进程只接收钥匙串路径，不接收 p12 密码。成功或普通失败后删除临时钥匙串；强制终止后由 CI 清理临时凭据。临时 CI 从密钥存储生成证书文件和 `.env.macos`，限制文件访问权限，并在作业结束后删除二者；自托管机器 preset 在 checkout 外保留私有文件。环境中的 `CSC_NAME` 与证书发现顺序都不能选择发布所有者。公证凭据也可以使用 electron-builder 支持的完整 Apple ID 或钥匙串 profile 方式。手动执行 `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>` 重复应用检查时，也必须提供两个 macOS 身份变量。

macOS 签名遍历真实文件，不跟随 Framework 的软链接别名。PAK 资源保留全部随附语言，由外层 Framework 或应用签名记录完整性，不逐个签名。[发布策略](../../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责依赖补丁和验证要求。

macOS 运行时准备将已验证的单架构 Mach-O 签名缓存在 `.desktop-build/targets/<target>/signature-cache`，除非通过 `DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR` 选择外置存储。显式路径必须是已存在的绝对目录，祖先路径不能包含链接，目录须归当前账户所有、权限为 `0700` 且可读写及遍历；非法或空配置在预检时失败，不回退。省略该字段保留目标本地缓存。缓存键包含输入字节与权限、签名探针实际使用的叶证书、签名标识、entitlement 字节、macOS 版本，以及签名工具与策略。复用不取决于 Git 提交：未提交的字节变更会使对应文件失效。每次命中都验证缓存字节、严格签名、证书、标识、entitlements、安全时间戳和 hardened runtime，再替换未被并发修改的输入。通用二进制每次重新签名。运行时完整性与 smoke 检查、App 签名和 Apple 公证仍会执行。缓存要求受信任的本地构建存储。缓存损坏或不安全链接会令构建失败；停止打包后删除对应缓存目录再重试。成功的签名阶段会将完整缓存条目的内容总量裁剪至一 GiB；中断留下的临时条目需手动清理。并发淘汰可能使读取方安全失败。日志记录命中、未命中及未缓存数量。

Mac 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `apps/desktop/.desktop-build/packaging-runs/` 下的唯一目录。读取本地配置后，每次运行保留 `run.json`（发布版本、产品版本、Git 提交、工作区是否有改动、目标及 Node 版本）、`events.jsonl`（带时间戳的阶段、耗时、并行输出归属及代理恢复状态）、脱敏后的子进程 `stdout.log` / `stderr.log`，以及 `result.json`（整体结果、阶段结果和产物目录）。事件还记录打包并发数及各代理是否配置。失败和后续打包不会清除日志；没有自动删除流程。缺少 `result.json` 表示完成状态未经确认。已知凭据值会被遮盖；不记录环境变量全集或 notarytool 认证参数。运行时准备分别记录包暂存、安装、依赖树复制、签名、清单生成、smoke 检查、描述文件校验和清理。嵌套阶段的耗时存在重叠，不能直接相加。

App 和 DMG 公证分别记录 submission ID，以及独立的 `notarytool:upload:*` 和 `notarytool:wait:*` 耗时。上传使用 `submit --no-wait`，包含认证、本地校验、传输和服务端受理，并非纯传输时间。等待从该命令返回后开始，包含轮询及剩余的 Apple 处理时间；Apple 可能在上传提交命令返回前已开始处理。日志保留 Apple 状态与诊断信息，包括拒绝结果；签名检查、接受状态校验和 stapling 仍由 `@electron/notarize` 负责。仅生成目录的打包命令也使用同一条可计时的 App 公证路径。各子进程输出仍实时显示在终端，阶段失败及嵌套错误保留在事件日志中。两个平台均记录父进程打包失败，并在终端显示脱敏诊断，包括代理恢复操作指引。仅检查配置的 `check:package` 命令不创建运行日志。

Mac 打包从 `.env.macos` 读取以下调优字段：

| 设置 | 默认值 | 作用范围 |
|---|---|---|
| `DSH_DESKTOP_MACOS_PACK_CONCURRENCY` | `4` | 第一方与 vendor workspace tarball 的打包 worker 数；必须是正整数。 |
| `DSH_DESKTOP_MACOS_ZIP_COMPRESSION_LEVEL` | `3` | 最终更新 ZIP 的压缩等级，整数 `0`–`9`；较低等级以更大的下载体积换取更短的构建时间。App 公证归档和 DMG 压缩不变。 |
| `DSH_DESKTOP_MACOS_DOWNLOAD_PROXY` | 空 | Electron、运行时资源、pnpm 安装及 builder 下载使用的 HTTP/HTTPS 代理 origin。 |
| `DSH_DESKTOP_MACOS_NOTARIZATION_PROXY` | 空 | 通过临时系统代理设置供 Apple 工具使用的 HTTP 代理 origin。 |

两个代理字段互相独立，拒绝 URL 中的凭证、路径、查询参数和片段。空值沿用继承的网络设置。显式下载代理会替换子进程的代理变量，仅绕过本地主机；它不修改系统设置。公司代理地址仅写入 Git 忽略的本地文件；具体地址参见内部文档。

Apple 工具使用 macOS 当前活动网络服务的 HTTP/HTTPS 代理。配置公证代理后，打包会检查代理可达性、保存该服务的设置，在两条产物任务期间启用代理，并在两条任务均结束后恢复原设置。对于原本关闭、服务器为空且端口为零的代理，恢复时仅关闭代理；临时服务器和端口可能保留，但不生效。仅生成目录的打包会在签名目录构建完成后的 App 公证期间启用代理。这会临时影响其他应用，并要求修改系统代理的权限；必须先禁用 PAC、自动发现、SOCKS 及需要认证的代理配置。打包和恢复在读取恢复记录或修改代理前获取同一个用户级 POSIX 文件锁；进程退出会释放锁的持有权，锁文件保留。该锁在首次使用时才加载 `@deepseek-ai/node-addon-system/flock`，而不是在脚本启动时加载，因此 `check:package` 和打包入口在未构建 `native/system` 的 checkout 上也能加载；加锁时若宿主 addon 二进制或入口的 JavaScript 缺失，加载器会先运行 `pnpm run build:native-system` 和 `pnpm --dir native/system run build:ts` 再加锁，因此恢复命令在这样的 checkout 上同样可用。这会阻止不同 checkout 的代理事务重叠；其他用户及网络设置工具不得同时修改这些设置。SIGINT/SIGTERM 会等待活动任务结束后恢复。强制终止或恢复失败后，先停止残留公证进程，再运行 `pnpm --dir apps/desktop run restore:mac-proxy`；保存的记录会保留到恢复成功。配置检查仅验证 URL 语法，不修改系统设置或连接代理。

<a id="directory-and-preparation"></a>

## 目录构建与准备

使用对应的 `:dir` 命令可以生成可直接运行的应用目录，而不是安装包，例如：

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

需要检查或诊断为宿主目标准备的资源而不调用 electron-builder 时，可以让同一流水线在准备完成后停止：

```sh
pnpm run prepare:desktop
```

这条诊断命令是另一种停止位置，并非两条命令构建流程的前半段。之后执行 `package:desktop*` 时仍会重新完成按签名模式选择的构建与全部准备，避免使用陈旧的 dsh 包、运行时文件或 dsh 内容。

<a id="local-official-bundles-from-a-loopback-registry"></a>

## 用回环 registry 安装本地 Official 包

测试 DMG 不包含 Official 按需目录所宣传的 provider 运行时，而正式发布才会把对应版本的 bundle 发到 npm。要在发布前安装本地构建的 bundle，请启动一个回环 registry，它会打包并提供该目录的完整本地依赖闭包：

```sh
pnpm run dev:bundle-registry
```

该命令先校验目录与 workspace 清单，运行 `pnpm run build:official`，把闭包打包进新的 `dist/test-bundles/<run-id>/` 目录，最后写入 `bundle-registry.json` 作为完成标记，然后才打印产物路径、registry URL 和精确的 `name@version` 规格。它在分配到的端口上只监听 `127.0.0.1`，使用一次性的命名空间提供服务，直到 Ctrl+C 或 SIGTERM；停止后产物和已安装的包都保留在磁盘上。它不需要 `.env.macos`、Apple 凭据或 npm 凭据，也不改变 `pnpm run package:desktop:unsigned`。

在打包应用中打开“插件 → 添加插件”，粘贴一条打印出的规格，选择**自定义地址**，粘贴打印出的 registry URL 后安装。自定义 registry 会被单独询问，因此必须由本进程回答每一个依赖：仓库自有的包取自本次运行的产物，第三方包则通过固定重定向到 `registry.npmjs.org` 保留 npm 的真实元数据与字节，因此仍需要网络访问。安装后的条目仍归类为 Official，因为它的包名在目录中。registry 选择会在此浏览器中记住；再次选择某个提供的 registry 即可切回。

一次运行的产物是不可变的，所以重新构建会提供新的命名空间和新 URL；当已安装版本与运行版本一致时，Official 的**更新**控件不会出现。profile 会在 `pnpm-lock.yaml` 中记录上一次运行的 tarball URL，而 pnpm 会校验已记录的条目，因此用新 URL 再次安装或重装该 bundle 会被 `ERR_PNPM_TARBALL_URL_MISMATCH` 拒绝，并且可能继续保留旧文件。要在同一版本上验证改动后的代码，请先清除过期的解析结果——在 `$DSH_HOME/profiles/<profile>` 中运行 `pnpm clean --lockfile`，或改用全新的 profile——然后再从新 URL 安装。`bundle-registry.json` 记录每个归档的版本、文件名、大小和 SHA-512 完整性，以及打包所用 checkout 的 commit 和 dirty 标记。

所提供的 `time` 是真实的打包时间，因此 pnpm 11 默认的 24 小时 `minimumReleaseAge` 会在 profile 的 `pnpm-workspace.yaml` 中记录它授予的豁免（`minimumReleaseAgeExclude`）；如果那里显式配置了更严格的策略，安装会以 pnpm 自己的报错失败，而不会被覆盖。`~/.npmrc` 或 profile 的 `.npmrc` 中的 `@scope:registry` 路由会覆盖该 scope 的 `--registry`，因此不能让它们指向正在提供服务的 scope。

<a id="runtime-file-selection"></a>

## 运行时文件筛选与安装检查

Desktop 在本地打包工作区包，并通过目标捆绑的 Node 和 pnpm 安装外部依赖。[Desktop 文件策略](../scripts/runtime-file-policy.ts)随后在签名和完整性封装前过滤不可变的 `resources/app.asar/dsh/node_modules` 副本。它排除 TypeScript 声明、已识别的 JavaScript/CSS/TypeScript source map、TypeScript 构建缓存、Domino 测试目录及 Yarn 开发元数据、选定的原生编译器输出和其他平台的 node-pty 预构建文件。非 Windows 目标还会排除 `node-pty/third_party/conpty`；Windows 目标保留该目录。它保留运行时 JavaScript、目标平台的原生模块及其 DLL/EXE 辅助文件、WASM、未知资源、许可证和 notices。依赖清单在完整性封装前经过 electron-builder 的元数据清理，确保归档保持已记录的字节。该策略不修改 npm tarball、捆绑的包管理器或用户安装的插件文件。

[Electron 外壳文件清单](../scripts/electron-builder-config.mjs)从单独收集的 `resources/app.asar/node_modules` 依赖中排除已识别的 JavaScript/CSS/TypeScript source map 和 TypeScript 构建缓存。这些排除规则保留运行时代码、原生模块、WASM、数据文件（包括普通 `.map` 资源）、许可证和 notices；[外壳归档测试](../tests/shell-file-selection.spec.ts)检查保留文件的字节和排除项。

[Office 转换提供方](../../../packages/document/office-to-pdf/README.zh.md)携带目标已声明的原生引擎；kit 未声明匹配原生目标时携带 WASM 引擎。准备阶段在打包前拒绝缺少目标引擎的情况。完整 Office 依赖（CLI、JavaScript 库和选定引擎的可执行文件、数据、许可证及 notices）解包到 `resources/app.asar.unpacked/dsh/node_modules/` 下。Desktop Host 将引擎清单解析到这些物理目录，并向加载的技能提供独立 Node 和解包后 CLI 的绝对路径。Node 位于 `resources/runtime/primary-runtime/dependencies/node/bin/`；CLI 位于解包后的 `@deepseek-ai/libreoffice-kit/lib/cli.js`。macOS 上的原生辅助程序获得 [LibreOffice UNO 桥](https://github.com/LibreOffice/core/blob/master/sysui/desktop/macosx/hardened_runtime.xcent.in)所需的 JIT entitlement。

打包应用运行编译后的 JavaScript 和预生成的 Typert 元数据，不编译 TypeScript 插件。源码级调试导航和编辑器声明仍可从开发包中获取。[复制规则测试](../tests/runtime-file-policy.spec.ts)覆盖排除项和保留资源；[产物 smoke](../tests/fixtures/runtime-payload-smoke.mjs) 在 Host smoke 和最终清单验证之前，使用 Electron RunAsNode 执行。产物 smoke 解析搜索工具使用的 ripgrep 可执行文件，并验证文本搜索和文件枚举。Windows 签名构建在依赖签名后运行这些检查；其他构建在 `prepare:dsh` 中运行。[Host smoke](../scripts/smoke-runtime.ts) 使用捆绑的 Python 创建 DOCX、XLSX 和 PPTX 输入，通过真实 Office 提供方逐一转换并检查 PDF 输出。每个组装后的应用（包括目录包和未签名构建）都会针对 ASAR 重复产物和 Host 检查。归档完整性检查将归档内完整描述符与准备结果比对，并核对归档和解包目录中的文件内容与清单、归档内文件记录的执行标志，以及解包文件的物理权限。转换失败会在写入发布记录前终止打包；macOS DMG/ZIP 构建在公证前执行这些检查。

Windows 发布验收还需在 Desktop 构建后手动运行[目录和替换检查](../scripts/smoke-windows.ps1)。将 `$Makensis`、`$SevenZip` 和 `$PluginDir` 分别设为锁定版本构建器的 NSIS 编译器、7-Zip 可执行文件和 x86-unicode NSIS 插件目录；通过 `-FrameLibrary` 传入已准备好的 `window-frame.dll`，即可同时覆盖原生解压路径及其失败报告。从仓库根目录运行以下命令。它验证 目录替换与回滚和两种文件占用替换方式；不属于单元测试通道。

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir -FrameLibrary apps/desktop/.desktop-build/targets/win-x64/installer-ui/window-frame.dll
```

Windows 安装器在启动时和选定目标目录后检查应用是否正在运行，通过检查后才将新版本解压到安装目录旁边。通过同卷目录改名替换前，安装器会再次检查。运行中的应用会阻止安装；更新启动允许等待应用退出，最长十秒。同路径升级在替换成功前保留旧目录；解压失败时旧版不变，替换失败时尝试恢复旧目录。安装器在启动前清理旧版备份。强制结束安装器或断电可能留下 `.new-*` 或 `.old-*` 目录；不同安装位置或安装范围迁移仍使用 electron-builder 的旧卸载器流程。

目录改名、空目标目录删除和旧版恢复遇到 Windows 错误 5、32 或 33 时最多尝试十次，每次等待递增 250 毫秒（每个操作合计等待 11.25 秒）。其他错误立即停止。替换失败时，安装器将 Windows 错误、相关路径和恢复结果写入解压报告旁的 `directory-failure-<时间戳>.log`。如果恢复失败，安装器会清理未被占用的暂存文件并保留备份。上报此失败后，退出清理不再重试恢复。请保留报告所列的备份目录，并在重新安装前联系支持人员。静默安装保存相同的诊断，不显示弹窗。

解压失败时，安装器会把 7-Zip 的结果和完整错误输出写入更新缓存目录 `%LOCALAPPDATA%\<按包名派生>-updater\installer-logs\extract-failure-<时间戳>.log`（当前为 `@deepseek-aidsh-desktop-updater`），并在弹窗中显示首条错误行和 **复制错误信息** 按钮；静默安装只写入报告。未签名的 Windows 构建（`DSH_DESKTOP_UNSIGNED=1`）会将安装包命名为 `deepseek-harness-<版本>-win-x64-unsigned.exe`，以免被误当作发布产物。

Windows 打包将 7-Zip 过滤器固定为 `BCJ`，以兼容内置的 NSIS 解码器。这样可以保留 x64 安装包中由依赖携带的 ARM64 二进制文件；自动 ARM64 过滤会生成该解码器无法解压的条目。

Windows dotenv 或机器 preset 中的 `DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL` 选择 `0` 至 `9` 的安装包归档压缩等级。省略时，现有 `ELECTRON_BUILDER_COMPRESSION_LEVEL` 环境覆盖仍然生效，否则 test 和 production 均默认为 `3`。手动 Windows workflow 的 `compression_level` 下拉默认选 `3`，也提供 `7`，与 Mac ZIP 选项一致；它对本轮覆盖文件中的设置。直接本地打包保留显式机器配置。Mac ZIP workflow 覆盖值必须为 `3` 或 `7`；空值在 macOS 上也非法。任何已定义的 Mac ZIP workflow 覆盖值（包括空值）均拒绝用于 Windows；非空的 Windows workflow 覆盖值拒绝用于 macOS。较低等级以安装包体积换取打包时间；修改发布 preset 前应验证完整签名 workflow 和产物体积。

NSIS 在安装阶段清理临时解压目录，完成后才显示完成页或自动启动应用。已安装的生产依赖保持为普通文件；启动时不会再次解压。安装仍会写入完整的应用目录树。

<a id="desktop-runtime-preparation"></a>

## Desktop 运行时准备

Windows 并行准备 Electron 和 primary-runtime；macOS 串行准备二者。只有两份运行时资源均成功，才会准备 CLI 并写入 `versions.json`。任一 Windows 运行时准备失败时，流程会等待另一路结束后再报告失败，且不写入 CLI 资源或版本记录。嵌套准备阶段的计时存在重叠，不能直接相加。

打包进程环境中的 `DSH_DESKTOP_PACKAGE_CACHE_DIR` 为共享的 `downloads` 和 `pnpm-store` 缓存指定非空绝对目录；省略时使用 `.desktop-build`。临时安装项目、lockfile 和配置仍逐次独立创建。运行时安装校验 store 完整性并复制包文件，防止后续签名修改缓存字节；清理时保留这些缓存。两个打包工作流使用 `runner.tool_cache/dsh-desktop-package-cache`；Windows 仓库依赖安装使用工作区盘根目录下独立的 `.pnpm-store`。两次安装日志均标明各自的 store 并报告包复用情况。每次运行仍通过新的运行时 lockfile 解析依赖。可写缓存仅供可信构建任务共享；完整性校验不能隔离不可信的写入者。仅在没有任务使用缓存时清理。缓存磁盘用量由操作者管理，不自动淘汰。

Desktop [补丁策略](../scripts/runtime-patch-policy.ts) 将每份工作区补丁明确归为共享、仅工作区或仅运行时。共享项复用根目录补丁字节，并对照根锁文件校验 hash；仅运行时项使用仓库内的独立文件，不改变工作区安装。仅工作区补丁用于构建工具或已嵌入客户端 bundle 的依赖。未分类或过期的条目、文件缺失、hash 改变、解析版本不兼容，以及仅工作区包进入运行时，都会阻止打包。[准备脚本](../scripts/prepare-runtime-patches.ts) 只写入临时项目；pnpm 负责应用选中的补丁，应用失败时会报错。

Desktop 依赖 overrides 在补丁策略模块中单独声明，不从补丁版本推导。pi-ai 约束使运行时版本保持在共享补丁已验证的版本。Desktop 仍会在每次构建时重新解析运行时锁文件，再通过 `--frozen-lockfile` 安装；不同构建之间的依赖解析尚不保证可复现。CLI 打包安装测试及其他交付流程保留各自的配置。

每条打包命令都会构建仓库，打包以 dsh 和私有 Desktop Host 为根的第一方生产依赖闭包，并准备目标专用的 Electron 分发包和包含共享 pnpm CLI 的 primary-runtime。`prepare:dsh` 在构建时安装一次生产依赖图，准备物化包供 electron-builder 归档到 `app.asar/dsh`，移除包管理器元数据，并生成包含共享包版本和最终文件哈希的 `desktop-runtime.json`。macOS 签名构建先签名并验证原生文件，再生成清单；electron-builder 不对已签名的此目录重复进行嵌套签名。资源映射明确包含默认根目录过滤器会忽略的 `dsh/node_modules`；准备完成的运行时清单在原生签名后检查。原生可执行文件及库解包到 ASAR 旁；Python、独立 Node 和 pnpm 保留在外部 runtime 资源中。Windows 打包逐项检查准备好的 PE，确认其 ASAR 条目已标记为解包，且磁盘副本字节一致；未签名构建也执行此检查。Builder glob 规则用单字符通配符匹配 PE 文件名中的花括号，因此同目录中名称匹配的文件也可能被解包。准备好的运行时 smoke 沿用已验证的目标描述符，不使用构建宿主的架构。签名安装包、公证、已安装应用升级和各目标原生模块的验收需要发布环境。

Windows 运行时在原生签名前后封存文件清单，每次最多并发读取八个文件。读取失败时会等待未完成的读取结束，不替换描述符；封存成功后仍须完成后续的完整性与 smoke 检查。

macOS 签名打包在组装 App 时、代码签名前写入 `Contents/Resources/app-update.yml`，供并行 ZIP 与 DMG 路线使用的目录构建也执行此操作。签名钩子验证准确的更新源和 updater 缓存目录。写入发布完成记录前，流程会再次检查两条路线的副本和最终移入的 App；配置缺失或不匹配会阻止移入产物，因而也会阻止上传。

未压缩产物包含 Electron、物化后的 dsh 生产依赖树、pnpm，以及壳应用。安装包大小与文件系统占用不同；发布验收需要测量两者，以及 profile 插件存储和首次启动耗时。此布局用更多应用内文件换取消除用户机器上的核心包安装过程。

<a id="verification"></a>

## 安装与发布验收

Windows 以不带版本后缀的产品名称显示已安装应用，版本保留在单独的版本字段中。Desktop 的 `package.json` 中的 `author.name` 提供安装包发布者和可执行文件公司名称，与签名证书相互独立。Windows 和 macOS 的版权文本仍使用产品名称。重新构建的安装包在安装或升级时写入新元数据；既有安装在此之前保留原值。

一起保留生成的安装包、版本和打包记录。安装前检查签名与运行时验证结果，再按[已安装更新验收流程](../tests/installed-update/README.zh.md)记录安装后启动及升级证据。[Desktop 测试记录](../tests/README.zh.md)维护验证限制；工作流成功本身不代表 production preset、新工作站或已安装升级验收通过。

## 开发备注

XXX：出现磁盘空间不足、缓存持续增长或频繁人工清理时，评估空间监测、维护入口和自动淘汰。任何自动清理方案都需要与所有使用缓存的任务协调。
