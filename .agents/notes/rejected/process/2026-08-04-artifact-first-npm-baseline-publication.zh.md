# Agent Note: 以产物为先的 NPM 基线发布

Status: rejected — superseded by 2026-08-10-npm-release-sequences: numbered versions and pack→protected publish shipped; timestamp versions were not adopted

[English](2026-08-04-artifact-first-npm-baseline-publication.md) | 中文

## 问题

monorepo 中可运行的源码并不能证明发布后的包可运行。workspace link、TypeScript paths、tsx 源码加载和工作树里残留的 `lib/` 都可能补上发布 tarball 中缺失的文件或依赖。即使现有构建产物测试使用普通 Node，它仍直接读取工作树中的 `lib/`，没有验证 `package.json#files` 最终选中了什么，也没有验证包管理器安装后的文件布局。一次开发模式正常的执行因此可能发布为缺少 bundle chunk、声明文件、配置或资源的包。

发布多个互相依赖的 `@deepseek-ai` 包还会产生集合一致性问题。如果脚本每 pack 一个包就立即 publish，那么后续 pack 或验证失败时，注册表中已经存在无法作为完整基线使用的前半组版本。npm 注册表没有跨包事务，因此这里的「一次性发布」不能承诺原子提交，只能承诺在任何远端写入前完整生成并验证发布集合，再由一个可恢复的编排命令发布这个不可变集合。

当前基线还需要人工在本机完成版本派生、认证、pack、发布和重试。后续 GitHub Actions 工作流必须复用同一套发布包与验证逻辑，不能在批准发布后重新构建另一组未经消费方测试的 tarball。

## 提案

发布流程以一个不可变的 release bundle（发布包集合）为边界。pack 阶段从一个确定的 Git commit 构建全部目标包、生成全部 tarball、检查 tarball 内容，并通过安装后集成测试；publish 阶段只读取这组 tarball 及其 manifest（元数据清单），禁止重建或重新 pack。

目标集合只包含 `packages/*/*/package.json` 与 `apps/*/package.json` 中命名为 `@deepseek-ai/*` 的 workspace 包。根项目、`website/`、vendor、Python 与 native workspace 不属于该 NPM 基线。发现机制必须拒绝重复包名、不同基础版本、意外的 `private` 发布状态以及集合中的未知包，而不是维护另一份手工包名列表。

预发布版本由包的稳定基础版本、命令启动时精确到秒的 UTC 时间戳和目标 commit 的 10 位短 SHA 组成：`<base>-<YYYYMMDDHHmmss>-<short-commit>`。dist-tag 由基础版本派生为 `dev-<base>`。例如，基础版本 `0.0.1`、时间 `2026-08-04T00:32:00Z` 和 commit `909292dd7b` 生成版本 `0.0.1-20260804003200-909292dd7b` 与 tag `dev-0.0.1`。同一 release bundle 的重试必须沿用原版本和 manifest；重新 pack 会按新的命令启动时间生成新版本。

pack 阶段按以下顺序执行：

1. 将 ref 解析成不可变 commit，采集 UTC 时间戳，从该 commit 的根 manifest 派生版本，并显示 commit、时间戳、版本、tag、注册表和输出路径。`pack` 与 `release` 此时都会在昂贵操作开始前等待 Enter；自动化可用 `--yes` 跳过该确认。
2. 在隔离的 detached worktree 中安装 frozen lockfile，并在暂存前运行源码 manifest 发布约束；调用方工作树中的未提交文件和旧构建输出不得参与发布。
3. 将所有目标 manifest 暂存为派生版本，移除发布时的 `private` 标记，并把 `dependencies`、`devDependencies`、`optionalDependencies` 与 `peerDependencies` 中的内部 workspace 依赖全部改写为同一精确版本。
4. 完整构建目标 commit，再运行 publint 和已构建包不变式。
5. 为目标集合中的每个包执行 pack，但不执行任何注册表写入。
6. 检查 tarball 内的 package manifest、文件清单、内部依赖版本、包名和版本，并拒绝缺失、重复或额外的 tarball。
7. 生成包含 commit、版本、tag、注册表、每个包的 tarball 路径、SHA-256 与 npm integrity 的 release manifest 和校验和文件。
8. 从本地 tarball 安装一个隔离消费方，运行当前实现已有的安装态产物探测，并将这些探测扩展为下文定义的完整产物平面集成测试矩阵。
9. 仅当整个集合通过时输出一个可直接执行的 publish 命令；pack 命令本身始终保持无远端写入。

本地 `release` 命令组合 pack 与 publish。它先通过上述 pack 确认确定预期时间戳和版本，再在 pack 成功后等待第二次 Enter，随后发布同一 manifest；`release --yes` 跳过两次确认。独立的 `pack` 与 `publish --manifest` 仍是 CI 分 job 和断点恢复使用的基础操作。

## 当前实现边界

已提交的 pack 命令实现了固定 commit 暂存、内部依赖精确固化、静态与 tarball payload 检查、不可变 manifest，以及把每个发布 tarball 都作为本地顶层依赖的隔离 npm 安装。它在输出 publish 命令前，用普通 Node 运行安装后的 `dsh --version` 与 `dsh --dump-default-config` 入口，再在 POSIX PTY 中启动安装后的默认 TUI，等待其 `main-session-` 就绪信号，并通过 `/exit` 退出。Publish 支持按 integrity 恢复，将只读注册表验证与认证身份检查分离，并以完整的远端 integrity 和 dist-tag 验证结束。

PR（Pull Request） CI 不会调用 pack 命令；安装态入口探测属于本地发布检查，而不是合并门禁。免凭据 CI 执行、其他每个 bin 与公开运行时入口的包自有探测、workflow artifact 传递及受保护 publish job 仍属于提案范围。

## 发布 payload 约定

发布包只携带消费方需要的构建产物。`package.json#files` 禁止包含 `src` 和 `lib/types/**/*.d.ts.map`；tarball 内容门禁还要独立确认不存在任何 `package/src/**` 与 `package/**/*.d.ts.map`，避免 manifest pattern 或 pack 行为绕过静态约束。运行时 JS、声明文件 `.d.ts`、配置、资源、worker 文件和 bundle 动态 chunk 必须按实际入口闭包收齐。

源码 manifest 可以保留 `exports["./src/*"]`，供本仓库的源码平面解析使用；该 export 不代表源码会进入发布 payload，也不属于已发布包的消费方约定。静态门禁必须分别检查源码平面与发布 payload，不能通过删除 source export 来掩盖错误的 workspace 解析，也不能通过发布 `src` 来修补缺失的构建产物。

每个 tarball 必须不含 `workspace:` specifier，并且所有指向本次发布集合的内部依赖与对等依赖（peer dependency）都必须精确等于本次派生版本，禁止使用 `^`、`~` 或其他 semver 范围跨越 commit 基线。除了明确仅供源码平面使用的 `exports["./src/*"]`，package manifest 中声明的每个消费方入口都必须指向 tarball 内存在的文件；动态 import、运行时拼接路径和非 export 资源不能只靠 manifest 检查，必须由安装后执行覆盖。

## 产物平面集成测试

集成测试在全部 tarball 生成后、任何 publish 之前运行。它在 monorepo 外创建一个全新临时项目，通过本次 release manifest 中的本地 `.tgz` 文件安装声明依赖闭包，并从安装目录执行。测试必须使用普通 Node 与包管理器生成的 `node_modules`；禁止 tsx、tsconfig paths、workspace link、仓库源码路径、工作树 `lib/` 和已发布注册表中的同版本包参与解析。测试还要断言关键模块与 bin 的真实路径位于临时消费方内。

安装使用本次发布选择的客户端行为。注册表上传必须使用 `npm` CLI（命令行界面），以满足私有注册表只接受 npm 客户端的策略；构建编排仍可使用 pnpm。tarball 测试不得先把这些包发布到真实注册表，也不得在测试后重新 pack。

测试至少覆盖以下执行面：

- `@deepseek-ai/dsh` 安装后的 `dsh --version` 与 `dsh --dump-default-config` 在普通 Node 下成功，分别覆盖静态 CLI 入口和一个动态模式入口。
- 安装后的默认 `dsh` 在 PTY 中完成一次无密钥 TUI 启动，到达既定 ready 信号后由测试受控退出。这条路径必须加载真实 TUI 动态 chunk，因此缺少类似 `lib/tui-*.js` 的发布文件会使门禁失败。
- 每个其他已发布 `bin` 都定义一个不会访问真实服务或修改用户状态的包级冒烟命令。不同 CLI 不强制共用 `--help`；测试必须运行其真实安装入口并检查约定的退出或 ready 信号。
- Node 兼容的公开运行时入口从安装目录加载；浏览器、worker 或必须由宿主协议驱动的入口使用对应的隔离 fixture（测试前置数据），但输入仍只能是本次 tarball。

这些测试验证可执行性，不替代单元测试、快照、真实 API e2e 或 publint。测试 fixture 应复用现有 built-bin 和 PTY 场景的行为断言，但必须把入口改为 tarball 安装结果；直接运行工作树 `lib/bin.js` 的测试不能算作本门禁。

## 发布与恢复

publish 命令先验证 release manifest、所有本地校验和、目标注册表、`npm ping` 和 `npm whoami`，再按确定顺序上传 tarball。命令只接受 pack 阶段生成的 manifest，不接受 workspace 目录作为发布输入。默认注册表为 `https://registry.npm.harnessment.com/`，每次 publish 都显式传入注册表和派生 tag，避免用户级 `.npmrc` 改变目标。

npm 不提供多包原子事务，上传仍会逐包发生。编排器通过幂等恢复缩小失败面：若远端不存在 `<name>@<version>` 就上传；若已存在且 integrity 与 release manifest 相同就跳过；若已存在但内容不同就立即失败。dist-tag 检查只读取 tag 映射，不解析默认 tag 指向的版本，因此即使无关 tag 指向的版本已不存在，也不会阻断恢复。完成后必须逐包确认版本 integrity 和 dist-tag 都指向本次版本，只有整个集合通过最终验证，工作流才报告发布成功。

如果 pack、tarball 检查或安装后集成测试失败，注册表必须保持零写入。如果 publish 在部分上传后失败，操作者使用同一 release manifest 重跑 publish 命令来恢复，不得重新 pack 并生成另一个时间戳版本来代替恢复。修复代码或改变构建输入后需要不同 tarball 时，才重新执行完整 pack 与测试。

## GitHub Actions 集成

GitHub Actions 分为无凭据的 pack-and-test job 与受保护的 publish job。前者检出精确 commit，调用与本地相同的 pack 入口，运行 tarball 消费方测试，并上传完整 release bundle 作为工作流产物。后者依赖前者成功，从工作流产物下载 bundle、重新校验 manifest 和校验和，再调用同一个 publish 入口；它不能检出后重新构建。

PR 与普通 push 可以运行无凭据的 pack-and-test 信号，从而在合并前发现 payload 回归。实际私有注册表发布先通过 `workflow_dispatch` 提供，输入只包括目标 ref；UTC 时间戳由 pack job 生成，基础版本、短 SHA、tag、注册表和包清单都由仓库状态或受版本控制的配置派生。稳定发布触发方式不在本基线提案范围内。

注册表 token 只注入 publish job，并由受保护 GitHub Environment 控制人工批准、允许的分支或 tag 以及并发。pack-and-test job 不得读取发布凭据。工作流产物的保留期可以较短，但 publish job 必须使用同一 workflow run 生成的 bundle，不能按版本号从不受信任的位置寻找 tarball。

## 考虑过的替代方案

**从 workspace 直接递归 publish。** 不采用，因为命令会把 pack 与注册表写入交错，无法在第一次写入前证明整个集合完整，也容易让 workspace 解析与调用方工作树状态影响发布结果。

**只测试工作树中构建后的 `lib/`。** 不采用，因为这验证的是构建树，不是 `package.json#files` 选出的 tarball。工作树中存在而 tarball 中漏掉的动态 chunk 正是本提案必须捕获的失败。

**只运行 `dsh --help`。** 不采用，因为 Commander 可以在加载 TUI、Web 或 headless 动态入口之前输出帮助并退出。它无法证明默认生产启动路径完整。

**把 `src` 和声明映射一起发布以降低漏文件风险。** 不采用，因为源码平面不是生产运行时的后备路径；扩大 payload 会掩盖 bundle 闭包错误，并把本地调试产物变成无意的发布约定。

**要求真正的跨包原子发布。** 不采用，因为 npm 注册表没有相应事务。不可变 release bundle、发布前全量验证、integrity 比对与幂等恢复提供可实现的边界，同时明确保留部分上传短暂可见的限制。

**在批准后由发布 job 重新构建。** 不采用，因为测试通过的 tarball 与实际上传的 tarball 将不再具有内容身份。工作流产物与校验和必须把测试输入直接传给发布步骤。

## 验收标准

- 一个 pack 入口从确定 commit 发现 `packages/*/*` 和 `apps/*` 的全部目标包，以 UTC 秒级时间戳与短 commit 生成并显示版本，再等待 Enter；它在任何注册表写入前生成完整 release bundle，并输出一个可复制的 publish 命令；`release` 在 pack 后再次等待，`--yes` 跳过两次确认。
- 静态 manifest 门禁和 tarball 内容门禁都拒绝发布 `src` 与 `.d.ts.map`，同时保留源码 manifest 中的 `exports["./src/*"]`。
- release bundle 记录完整包集合、commit、派生版本、tag、注册表和逐 tarball integrity；所有内部依赖都精确固化到该版本，publish 只消费该 bundle，绝不重建。
- 一个隔离集成测试从本地 tarball 安装消费方，并用普通 Node 启动安装后的默认 `dsh` TUI；删除任一所需动态 chunk 会使该测试稳定失败。
- 所有已发布 bin 和适用的公开运行时入口都有 tarball 安装后的执行覆盖，且解析路径证明没有回退到 monorepo。
- publish 可在部分成功后用同一 manifest 安全重跑；相同 integrity 被跳过，不同 integrity 被拒绝，最终验证要求所有版本与 tag 一致。
- GitHub Actions 的无凭据 job 生成并测试 bundle，受保护 job 上传完全相同的 bundle，发布 token 只存在于后者。

## 风险

全量 pack、安装和启动会增加 CI 时间与工作流产物体积。实现应缓存外部依赖和 pnpm store，但不得缓存或复用目标包的已安装 workspace 输出；并行执行安全的消费方 probe 可以降低时延。

把所有 tarball 都安装为临时项目的顶层依赖可能掩盖未声明的内部依赖。测试生成器应按被测应用的声明式递归闭包安装，并结合现有依赖门禁；对依赖面接近全集的 `@deepseek-ai/dsh`，仍需依靠 package manifest 与静态图检查发现未声明边。

不同平台的 optional dependency、native addon、PTY 与浏览器入口可能需要平台专属 probe。第一阶段至少在发布所用 Linux runner 和一个本地 macOS 路径上覆盖主 `dsh` 启动，后续矩阵按实际发布平台扩展；不能用跳过不稳定 probe 的方式把生产路径移出门禁。

恢复机制不能消除 npm 的部分可见性。发布失败期间，注册表可能短暂含有本次版本的一部分包；操作者与自动化必须以最终 bundle 验证结果而非单个 `npm publish` 的成功作为基线可用信号。
