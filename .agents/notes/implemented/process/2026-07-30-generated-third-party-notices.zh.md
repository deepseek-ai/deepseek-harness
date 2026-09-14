# Agent Note: 生成的第三方声明

Status: implemented

[English](2026-07-30-generated-third-party-notices.md) | 中文

## 问题

本仓库开源需要披露所依赖的第三方软件及各自的许可证。这份披露必须完整，必须随依赖变化保持为真，还必须给出读者用得上的信息：哪些包最终会进到用户机器上，哪些只用于构建和测试。

手写清单无法长期满足其中任何一条。约一百行从各 manifest（元数据清单）推导出来的包名与许可证标识，只要有依赖新增、移除或换用许可证就会悄悄失真，而没有任何检查会察觉。

## 决策

[`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) 由 [`scripts/gen-third-party-notices.ts`](../../../../scripts/gen-third-party-notices.ts) 依据各工作区 manifest、`vendor/README.md`、`pyproject.toml` 与 `pnpm-workspace.yaml` 生成。根 README 双语两侧都从「许可证」一节链到该文件。

**新鲜度会得到维护，而非仅靠校验。** 只要暂存了生成器的任一输入——任何 manifest、工作区声明、根锁文件、`vendor/README.md`、某个 `pyproject.toml`、生成器自身，或持有构建期 pin 的脚本——pre-commit 任务就会重新生成该文件并将其暂存，改依赖的人不必事后再折返跑一次生成器。已提交的字节随后由 [`scripts/gen-third-party-notices.spec.ts`](../../../../scripts/gen-third-party-notices.spec.ts) 断言，而测试 lane 本就会跑这个文件——这项校验不增加门禁进程、不占调度位、也不新增 CI 步骤。需要单独校验时，`pnpm run verify-third-party-notices` 仍然可用。

有一处触发缺口是接受而非绕过的：lefthook 只检视磁盘上存在的文件，因此**删除** manifest 不会触发任何任务，移除一个包会落到测试 lane 的断言上。重构暂存文件列表以纳入删除的做法不成立——无论怎么给列表，lefthook 都会拿工作树过滤一遍。这个场景正由断言兜底。

文件默认只披露**直接**依赖。完整的 npm 闭包连同锁定版本已记录在 `pnpm-lock.yaml`（`pnpm licenses list` 可渲染），Python 闭包记录在 `python/sdk/uv.lock`；再用散文誊一遍只会得到一份更差的副本。唯一明确披露的传递依赖，是 `@anthropic-ai/claude-agent-sdk` 通过 `optionalDependencies` 声明的官方 Claude 平台载荷集合，因为这些包承载随产品分发的 Claude Code 可执行文件，而非普通的库实现细节。

**分层依据是分发内容，而非 manifest 字段名。** 安装的运行时库由 `DEV_ONLY_AREAS` 之外的 `dependencies` 或 `optionalDependencies` 识别；排除区域为根 manifest、`packages/test-support/`、`packages/test-support/client-runtime/`、`website/`、`native/`。发布所用的 tsdown 与 Vite 配置解析到的浏览器输入也属于运行时，即使它们位于 `devDependencies`；[浏览器第三方构建输入](2026-09-08-browser-third-party-build-inputs.zh.md)拥有这项分类。测试支撑依赖不会仅因字段写成 `dependencies` 就被交付，而生成器显式披露 `tsx`，因为源码启动通过其 ESM 钩子执行。

运行时层刻意覆盖**所有可挂载的插件**，而不止 CLI、Web UI 与 Python 运行时默认加载的那些。从源码运行时，用户可以通过 `cordis.yml` 挂载任何插件包；因此，`@modelcontextprotocol/sdk` 与 OpenTelemetry 系列即使没有任何默认装配引入，也会触达真实用户。对法务披露而言，披露不足才是代价更高的那个方向。

manifest 集合由根 `pnpm-workspace.yaml` 声明的 `packages:` 成员派生，其中包括 Landlock 工作区及其公开包，因此新增成员区域在声明当天就会被读取，而不必等谁想起来去补一份列表。许可证与仓库地址取自根工作区已安装的 pnpm store 和包本地链接场；某个包两处都解析不到时直接失败，而不是留下空单元格。`OVERRIDES` 收录已发布 manifest 答不上来的包：用 Rust 构建、发布时省略 `license` 字段的 npm 可执行包，以及 `modelcontextprotocol/servers` 系列——该仓库正处在 MIT 向 Apache-2.0 的重新许可过程中，实际条款按贡献逐条而定。运行时依赖的许可证若不在宽松清单内即为硬失败：交付 copyleft 是一项分发决策，不该被一次重新生成悄悄吸收。被源码收编的包会与 `vendor/README.md` 交叉核对，出现非 MIT 即报错；`pnpm-workspace.yaml` 的 `patchedDependencies` 列入运行时表格，因为 pnpm 在安装期就会打上这些补丁——交付产物携带的是改动过的 `@earendil-works/pi-tui` 与 `node-pty`，补丁文件本身就是改动的完整记录。

项目所有者另行授权分发每个官方 `@anthropic-ai/claude-agent-sdk` 版本，以及该版本通过 `optionalDependencies` 声明的官方 Claude Code CLI 与平台载荷。生成器将其表示为一项精确匹配直接包身份的例外，而非宽松许可证覆盖项：`SEE LICENSE IN README.md` 与 `SEE LICENSE IN LICENSE.md` 仍归类为非宽松，所有无关的非宽松运行时依赖仍以默认拒绝方式失败。存在该 SDK 时，生成器会读取其已安装 manifest，拒绝不符合官方 SDK 载荷前缀的可选包身份，推导当前 SDK、CLI 与载荷版本，核验已安装宿主载荷的身份、版本和声明许可证字段，并在单独的声明章节中渲染 SDK 声明的完整载荷集合。版本、声明许可证和载荷集合发生变化时无需新的身份授权，但仍须经过常规的依赖、锁文件、兼容性、条款和声明评审。

## 测试

断言新鲜度的同一个 spec 也用 fixture（测试前置数据）manifest 钉住分层规则，覆盖促成该规则的两个场景：测试支撑包的 `dependencies` 条目，以及没有任何应用挂载的插件包。它还把各解析器钉在那些原本会让某个包无声消失的形态上：不再覆盖全部收编目录的 `vendor/README.md` 表、含 extras 的依赖数组（`"httpx[http2]"`）、完全不带版本的依赖、作者自取名字的 `[dependency-groups]` 表，以及任何硬编码列表都不含的工作区成员区域。这些都是静默漏报路径——正是披露文件最担不起的失败方式。

Claude 分发测试证明：只有精确匹配的直接 SDK 身份会绕过通常的非宽松运行时拒绝；该绕过不会改变许可证分类；载荷集合来自 SDK manifest，而非版本或平台允许列表。SDK 身份错误、载荷缺失或存在无关的可选包身份时，测试都会失败。

## 考虑过的替代方案

**保留手写文件，发版时人工过一遍。** 用肉眼审阅上百行推导数据，恰恰是生成器能做对的活；而且在两次发版之间，文件自称「列出全部直接依赖」这句话无人验证。

**用专门的 `doc-sync`（文档同步门禁）校验。** 仓库里其他生成产物都是这么把关的，本次改动最初也是这个形态。但它要在本已冗长的矩阵里再占一个门禁进程和一个调度位；更糟的是，它唯一的失败方式，就是在别人推完一个无关的依赖升级几分钟后，通知对方回去重跑一次生成器。改为提交时重新生成消除了这次打断，而把断言放进测试 lane 本就会跑的 spec 里，则以零额外 CI 成本保住了这项保证。

**列出完整传递闭包。** 闭包有数千个包，锁文件里已带精确版本，铺开只会淹没读者真正要评估的直接依赖。文件转而指向锁文件与 `pnpm licenses list`。

**按 manifest 字段分层（`dependencies` 与 `devDependencies`）。** 机械上最省事，但在真实数据上两个方向都会出错，理由见上文分层段落。

**只按已交付装配的可达性分层**（`apps/*` 加 `python/sdk-runtime`）。这样得到的运行时层更紧凑，但会把 MCP 客户端与 OpenTelemetry 导出器判为仅开发用途——而运行已安装仓库的用户完全可以挂载它们。这会低估披露，对法务通告来说错在了更危险的一侧。

**将 Claude SDK 条款视为宽松条款，或新增可复用的非宽松允许列表。** 两种方案都会误述上游声明，并让无关运行时依赖继承从未授予它的授权。这项窄例外只匹配官方直接 SDK 身份；其可选载荷身份仅作为该 SDK 声明的数据被接受，并继续明确归类为非宽松。

**把披露文件做成双语对。** 其他根文档都是成对的，但这份文件是上游包名、SPDX 标识与网址构成的表格，可翻译的只有寥寥几段章节导语。`scripts/translation-pairing.ts` 的发现范围限定在 `README*`、`.agents/notes/**`、`docs/**` 与 `python/**`，根目录下的非 README 文件在构造上就不属于双语语料；双语入口由 README 对承担。

## 后果

此后改动依赖时，重新生成的披露文件会随同一个提交入库。触及 manifest 的提交多付一次生成器运行——约一秒；其余提交不受影响。若禁用钩子提交，代价推迟为一次测试 lane 失败，其报错会指明补救命令。

生成器需要已安装的依赖树，因此比纯源码生成器更重；发布元数据不可用的新包需要补一条 `OVERRIDES`，而不是默默渲染出空白许可证。这两类失败都会明确报错并指出补救方式。

分层规则是编码在一个常量里的策略。若新增了不参与交付的工作区区域——第二层测试基础设施、另一个站点——就要同步扩展 `DEV_ONLY_AREAS`，否则其依赖会被当作运行时依赖披露出去。

Claude 身份例外刻意比其启用的载荷披露范围更窄。升级 SDK 无需新的所有者授权，但如果已安装的 SDK 未公开自身版本、CLI 版本和至少一个官方平台载荷，或当前宿主载荷与 SDK 声明不符，重新生成就会失败。维护者仍须评审发生变化的条款与兼容性；生成器会阻止授权悄然扩大到其他包。
