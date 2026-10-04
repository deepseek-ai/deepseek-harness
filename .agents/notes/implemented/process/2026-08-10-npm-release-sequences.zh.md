# Agent Note: 三条独立序列的私有 NPM 发布

Status: implemented

[English](2026-08-10-npm-release-sequences.md) | 中文

## 问题

这个仓库有三组互不相干的可发布包，却没有任何发布通道把它们送上 registry。

`packages/*/*` 与 `apps/*` 组成 `@deepseek-ai/dsh` 的运行面；`vendor/*` 是九个 rescope 过的 Cordis 框架包，各自带着上游的版本号；`native/system/packages/*` 是 Linux 平台包，有自己的 workflow。三组的版本基线、变更节奏和构建要求都不同：dsh 随产品迭代，vendor 只在同步上游或改动本地修改时才动，native 需要 musl 工具链和逐架构构建。把它们塞进一条发布流水线，等于每次产品发版都要重发框架和原生二进制。

挡路的还有两处硬门。全部 217 个 workspace manifest 都是 `private: true`，`npm publish` 直接拒绝。更隐蔽的是 933 条 dsh 兄弟包之间硬写的 `peerDependencies: "^0.0.1"`：`pnpm pack` 只替换 `workspace:` 协议，不动语义范围，而 `^0.0.1` 等于 `>=0.0.1 <0.0.2`——发 `0.0.2` 落不进去，发 `0.0.1-rc.1` 也落不进去（semver 规定不带预发布段的范围排除预发布版本）。这些条目至今没出事，只因为版本一直停在 `0.0.1`。

`scripts/publish-npm-baseline.ts` 是本机发布脚本：它把 pack 与 publish 放进同一个进程，需要人工在本机完成认证与重试，且把 vendor 排除在发布集之外。它不能作为 CI 发布的基础，但其中的 tarball payload 校验与已安装产物探针是验证过的零件。

## 决策

### 三条独立序列

`packages/`、`vendor/`、`native/` 各自一条 bump 序列、各自一次发布，不共享版本号、不共享触发、不互相等待。发 dsh 不重发 vendor，发 vendor 不重发 native。

| 序列 | 成员 | 版本基线 | tag | workflow |
|---|---|---|---|---|
| dsh | 发布集：`packages/*/*` + `apps/*` 中的公开成员，保留[私有实验包例外](../../../../packages/experimental/README.zh.md)；私有包仅加入共享版本 bump | 发布集、私有 dsh 包与 workspace 根共用一个 `0.0.x` | `dsh-v<版本>` | `release.yml`（pack）/ `release-publish.yml`（发布） |
| vendored framework | `vendor/*` 九个包 | 每包各自一条版本线 | `vendor-<包名>-v<版本>`（每包一个） | `release-vendor.yml`（pack）/ `release-vendor-publish.yml`（发布） |
| native | `native/system/packages/*` | 自己的 `0.0.x` | `node-addon-system-v<版本>` | `node-addon-system-release.yml` |

三组一律发到 npmjs.com 的 `@deepseek-ai` scope，且 access 按序列而非按 scope 区分：vendored 框架与 native 包是 `public`，dsh 族自 2026-08-13 其自身序列公开发布起即为 `public`（[理由](../../archived/process/2026-08-13-public-vendor-and-native-sequences.md)）。没有任何发布路径传 `--access`——一个选项无法服务级别互不相同的序列，且会覆盖真正拥有该级别的 manifest。

### 版本由本地命令写进仓库，CI 只核对与上传

每条序列有一条 bump-and-commit 命令：算出目标版本，写进相关 manifest，跑 `pnpm install --lockfile-only`，再把 manifest 连 lockfile 一起 commit。发布版本因此在仓库里查得到。tag 由人工在 commit 合入 master 后打；CI 不写仓库，也不需要写权限。

`release:dsh` 接受 `major`、`minor`、`patch` 或显式版本号，把同一个版本写进可发布族、`packages/*/*` 下的每个私有包**以及 workspace 根**。私有包不会获得发布 tag，仍位于 pack 与 publish 之外；它们跟随版本是因为[静态版本一致性门禁](../../archived/process/2026-09-03-workspace-version-coherence-gate.md)要求每个 dsh 包的版本等于根版本。根的检查接受预发布段，因此 `0.0.1-alpha.1`、`0.0.1-canary.1` 和 `0.0.1-rc.1` 等显式版本走同一条 pack、已安装产物探针和发布路径。发布 dsh 时，`alpha` 和 `canary` 分别映射到同名 npm dist-tag，包含 `rc` 在内的其他预发布版本映射到 `next`，稳定版本则沿用 npm 默认的 `latest`。其他发布家族保留各自的 dist-tag 规则。

基础版本号相同时，SemVer 按字典序比较字母数字型预发布标识：`alpha` 小于 `canary`，`canary` 小于 `rc`，所有预发布版本都小于稳定版本。npm dist-tag 是可变别名，不参与版本优先级比较。

### vendor：整族递增，每包保留自己的 tag

vendor 九包加了 scope 之后与上游脱钩，但保留各自的版本线。下一版本取 manifest 版本与最新 tag 版本中较高的那个，稳定版本之后递增 patch。首发版本：

| 包 | 上游版本 | 首发版本 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

以最新 tag 的版本为基线可避免重同步后复用版本：本仓标记 `4.0.1` 之后，上游若将版本恢复成 `4.0.0-rc.8`，只看 manifest 会再次算出 `4.0.1`。`release:vendor --prerelease rc.1` 或 `--prerelease alpha.1` 选择预发布版本，默认 npm dist-tag 为 `next`。后续预发布和稳定版本复用其基础版本号：`4.0.1` 接在 `4.0.1-rc.1` 之后。脚本按 SemVer 优先级比较，不使用会将预发布排在稳定版本之前的 `git tag --sort=v:refname`。

每次 vendor 发布都递增全部九个包，每包保留自己的版本和 `vendor-<package>-v<version>` tag。即使包目录没有源码变更，从不同仓库状态重新打包也可能改变其依赖范围或构建产物。整族递增可避免为这些不同的字节复用已有版本。

tag 预留包版本并标识其 commit，不代表发布成功。即使对应发布失败，bump 仍使用最新 tag。publisher 核对 registry 中的版本和 integrity，发布负责人核实整族发布完成。

`vendor/cordis` 也发布 `src`。它的 exports 声明了 `"./src/*"`，tarball 中缺少这些文件就会将消费方指向不存在的路径。

### 发布只在 GitHub 执行，由 registry 状态决定发什么

发布只从 GitHub Actions 执行，没有本机发布路径。publish 不读 tag、不读任何「本次发布包含什么」的清单，而是对每个打包好的 tarball 拿版本与 registry 比对，分三态：

| 状态 | 处置 |
|---|---|
| registry 上没有该版本 | 发布 |
| 已有该版本，且 tarball 的 sha512 等于记录的 `dist.integrity` | 跳过：这是同一批产物的重跑 |
| 已有该版本，但 integrity 不同 | 失败退出，报「内容已变但版本未 bump」 |

第三态拦住「改了代码却没 bump 版本」。前两态给出幂等——同一个 artifact 重跑 publish 不会重复发布，也不需要人工挑拣包。同一条规则还解决了「一次 vendor 发布携带多个 tag，而 workflow 只能从一个 ref 触发」的矛盾：workflow 从不从触发它的 tag 去推断该发哪些包。

三条序列都按这套判定，native 也在内：它通过自己的脚本发布，而不是 shell 循环——一串裸 `npm publish` 无法重试，registry 对「重发已存在的版本」的回答是永久失败，因此中途失败一次就没有前路了。

registry 的两个行为决定了「怎么尝试一次发布」。写入之间至少间隔两秒并带退避重试，因为连续背靠背发多个包会超出 registry 自身的处理速度，换来 `E409 Failed to save packument`。而每次重试都先重查 registry：报出来的失败可能对应一次其实已经落地的写入，所以「该版本现在存在且 integrity 与本 tarball 相同」算作已发布，而不是又一个待放置的版本。

对 dsh 和 vendor，`release:publish --dist-tag <tag>` 覆盖该族默认发布通道。vendor 发布 workflow 接受可选的 `dist-tag` 输入；省略时保留该族默认值。覆盖值必须是合法的 npm dist-tag。发布任何 tarball 前，publisher 检查每个打包成员：所选 tag 必须已指向预期版本，或者该 tag 和版本都不存在。tag 指向其他版本，或版本已经发布但缺少所选 tag，都会在上传前拒绝整次发布。原有 integrity 检查与重试继续生效。跳过的版本不会重新绑定 tag。

预检不会原子性地预留 npm tag。发布负责人协调可能在检查后更改绑定的外部发布者。专用 dist-tag 也不会让稳定版本被已有依赖范围排除：隔离需要预发布版本，并核查实际打包产物中的依赖范围。

### workspace 内部引用走 `workspace:` 协议

所有指向 workspace 成员的引用都用 `workspace:` 协议。每个消费者的所有依赖区段对 DSH 使用精确的 `workspace:*` 引用，对 vendor/native 使用 `workspace:~` 引用，包括原生入口的可选平台包。vendor 与 native 的补丁版本必须保持面向消费者的 API 和二进制接口兼容。本地 workspace 链接方式不变。

`scripts/check-workspace-constraints.ts` 读取 `pnpm-workspace.yaml` 声明的全部成员及根清单，按依赖目标而非消费者目录校验范围。依赖修复器保留 vendor/native tilde 范围。因此，发布的 DSH peer 要求匹配的发布版本，而不接纳后续兼容版本。

### 发布依赖门面使用显式策略

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) 按已发布的 Client 与 Host 用法分类 workspace 关系，让受管包只保留 Cordis peer，并应用一份较小的显式 Host 名册。[发布依赖门面与有限 peer 中继](2026-08-26-published-dependency-faces.zh.md)记录选包规则与理由。

`pnpm run benchmark:npm-resolution` 使用当前安装的 npm 手动测量该依赖图。`pnpm run benchmark:npm-resolution:next` 还会逐个尝试每个可达且未配置的 Host 包，再串行复测领先候选。两个命令都使用回环 metadata registry 并拒绝包归档请求，因此耗时不包含包下载。调度器负载与 metadata 完成顺序会使墙钟阈值失去确定性，所以两个命令都不进入聚合门禁。

### optional 依赖绝不在模块作用域被加载

`optionalDependencies` 里的依赖，或带 `peerDependenciesMeta.<name>.optional` 的 peer，在安装出来的树里可以不存在——这份「可以不存在」正是 optional 的全部承诺。而静态 import 在引入方模块加载时就求值，于是一个缺失的包不再表现为「这个能力不可用」，而是变成所有能走到该模块的代码的加载失败。这种失败只在「缺了该包的安装树」里出现，而本仓没有任何测试构造这种树：workspace 安装总是把每个包都装上，所以单测、快照、打包安装探针全都会过，而那个拒绝了这个 optional peer 的消费者拿到的却是坏的包。

[`verify-optional-dependency-imports`](../../../../scripts/verify-optional-dependency-imports.ts) 堵掉这个洞。它从每个包自己的 manifest 读取「这个包允许谁缺失」，再扫描会发布出去的文件——`packages/*/*/src/` 与 `apps/*/src/`——且两个编译门面各扫一遍。`vendor/` 不在范围内，那是[受 vendoring 政策管辖](../../../../vendor/README.md)的固定上游源码。值与类型的判定对着绑定好的 Program 做，而不是看 import 写法，因为 `verbatimModuleSyntax` 是关的：编译器本来就会消除绑定解析为类型的 import，所以 `import type {}`、`import {}`、内联 `type` 说明符、以及解析为类型的具名绑定都不产生产物、一律放行，而裸 import、值绑定、星号 re-export 会被保留、一律报错。只有 type 相位会消除 import：`import defer` 仍然解析并链接它的模块，只推迟求值，所以门禁把它算作一次加载。

报错会点名这个包、点名是哪条声明把它标成 optional 的，并按顺序给出出路——把它作为类型引入（声明合并需要的仅此而已），或者调整写法让模块作用域不再需要这个包。动态 `import()` 只是把失败推迟到首次使用，它属于那种确实需要这个包、并且自己处理缺失的调用方；会想到它，往往说明这个依赖并不 optional，所以门禁不把它作为解法给出。

初始化与启动无关、且兼容 CommonJS 的必需 Host 依赖可以使用 `createLazyRequire(specifier, import.meta.url)`。调用方保留 type-only import，传入字面量依赖 specifier，并在所属操作中调用返回的 loader。`verify-package-dependencies` 会把该字面量识别为 Host runtime edge，因此 Client/Host 包即使没有静态值 import，仍会把它保留在 `dependencies`。该工具只缓存成功加载，并保留调用方相对解析；它不会把 optional 依赖变成必需依赖，也不会隐藏首次使用失败。

### 发布族对象

这个领域里的实体是**发布族**：一组共享版本基线与 tag 命名、可整体发布的包。新增一族等于加一个子类和一条 workflow lane，不改核心。

| 对象 | 职责 |
|---|---|
| `ReleaseFamily` | 一族的身份：成员发现、版本基线、tag 前缀、打包 payload 规则、已安装入口 |
| `ReleaseMember` | 一个可发布包：目录、包名、版本、manifest |
| `publishOrder` | 按 npm 会安装的依赖段加 peer 声明做拓扑序，同层按包名排；安装依赖成环是报错而不是随意定序，任何排不进去的 peer 边被丢弃并点名 |
| `pack` | 把整族打进一个目录并记录上传顺序 |
| `verify` | 族的版本基线、完整打印出来的发布顺序；发布时还要求本次运行来自该族的 tag、且成员可发布 |
| `verify-packed-install` | 把一个或多个 pack 目录的 tarball 装进一次性 consumer，并驱动已安装的可执行入口 |
| `publish` | 上面那三态 |
| `process` / `tarball` | 启动命令、读取打包 tarball 的唯一正家，其中的入口守卫让每个脚本都可被 import |

dsh 族套用仓库的发布 payload 策略（拒绝源码与声明映射）。vendored 族保留上游 payload，因为那些 manifest 导出 `./src/*`，去掉 `src` 会发出一个导出映射指向不存在文件的包。

### workflow 形状：PR/push 上 pack，从手动 dispatch 工作流发布

`pack` job 一趟遍历整个发布集，把每个成员打进同一个目录，写出上传顺序，整个目录作为一份 artifact 上传；它位于 `release.yml` / `release-vendor.yml`。发布集是一个整体——绝不会出现一半的包已经上了 registry、另一半还在构建。

`pack` 无凭据，在每个 pull request 和每次 master push 上跑，所以一个 pull request 就能证明发布集仍能完整打出来。发布则位于独立的 `release-publish.yml` / `release-vendor-publish.yml` 工作流，仅 `workflow_dispatch`（因此不会作为 PR check 出现）：它重新打包当前树，再按顺序逐个发布，挂在 `npm-publish` environment 后面等人工审批。pack 的 run 按 ref 分组，并发的 pull request 不会互相顶掉；全局 `Release-publish` 分组落在 `publish` job 上，因为 dist-tag 是共享的 registry 状态。dsh 发布成功后，发布操作者按[发布记录](../../../../docs/session-format-status.zh.md#updating-the-record)核实其 Session 写入器；若交付了更高的 Session 格式，则更新该记录。

dsh 的验证会一并安装 vendored 族的 pack 产物。harness 的包把 vendored 框架声明成 peer，而那些包属于另一条序列，无凭据的 job 无法从私有 registry 取到——所以 dsh 的 `pack` job 为验证而打包 vendored 族，发布的仍只有 dsh 那一份。发布工作流（`release-publish.yml`）重新打包当前树，只发布 dsh 族。

验证还会打一份 Landlock entry 的 tarball——`dsh-sandbox-local` 把它声明为普通 `dependencies`——同时略去可选依赖。那些可选项背后的平台包需要 musl 工具链且每个架构各构建一次，单台 runner 产不出来；而装不到它们的消费方也必须能起，这正是「可选」在这里的含义。因此验证按目录内容读取 tarball，而不是读发布顺序：一个目录可能只装着为满足跨序列依赖而打出来的包，任何发布顺序都不描述它。

已安装消费方探针会捕获 npm 的 HTTP 诊断信息，并在安装失败时输出。即使 npm 将 peer manifest 获取失败报告为版本未定义的 `ERESOLVE`，日志中仍能看到 registry 响应码和缓存状态。

### 本次带出的仓库改动

| 项 | 内容 |
|---|---|
| 发布集 manifest | 去掉 `private: true`；按序列补 `publishConfig.access` 与带各自 `directory` 的 `repository` |
| 发布集边界 | `packages/*/*`、`apps/*`、`vendor/*` 的全部成员 |
| 依赖协议 | 每个 workspace 消费者对 DSH 目标使用 `workspace:*`，对 vendor/native 目标使用 `workspace:~` |
| 根 `AGENTS.md` | 「vendored 包是 `private: true`」这条约定不再成立 |
| `vendor/README.md` | 记录「`src` 加入 `cordis` 的 `files`」这条本地修改 |
| native 三包 | `publishConfig.access: public`，且其 workflow 不传 `--access` |

## 曾考虑的替代方案

**`<base>-<时间戳>-<短 SHA>` 版本号。** 曾计划用于持续 dev 发布。它与「把发布版本留在仓库里」冲突：版本内嵌 commit SHA，而把版本写回会产生新的 commit，于是 SHA 只能指向被发布的父 commit，这条链要靠约定解释。改用数字版本后，`0.0.1-rc.1` 这类预发布号已经覆盖「先验证再正式发」。

**用 `vendor/published.json` 账本记录每包的已发版本与 commit。** 这是 tag 方案之前的设计。它新增一份必须与 registry 不漂移的状态文件；per-package tag 提供同样的 commit 指针，而 tag 本来就要打，不引入第二处状态。

**事件级 tag（`vendor-r1`、`vendor-r2`）。** 为「一次发布事件携带多个包版本」准备。既然由 registry 决定发什么，workflow 就不再从 tag 推断集合，per-package tag 够用，而且每个 tag 携带的是它自己那个包的真实版本。

**把九个 vendored 包统一到一条 `4.0.x` 版本线。** Cosmokit 会从 `1.8.1` 跳到 `4.0.1`、丢失上游血缘；九包内部的上游范围（`^1.8.1` 之类）会立刻失配，必须改写 vendored manifest。

**只发布目录有变更的 vendor 包。** 目录 diff 不能证明从不同仓库状态重新打包会产出相同字节。递增全部九个包可避免未改目录的 integrity 冲突，代价是增加版本号。

**只按版本号判断「是否已发布」，不比对内容。** 参照流程根本不查 registry：publish 逐个上传，重复版本由 npm 拒绝。只按版本号跳过会漏掉「改了代码没 bump」，而这是唯一会安静地把旧字节留在 registry 上的错误。代价是引入一次 registry 查询和对构建可复现性的依赖。

**只做打包后安装验证，不起本地 registry。** 参照流程是把 tarball 解包成一棵树、用普通 Node 驱动，这绕过了版本范围解析。曾提议在 CI 里起本地 registry 补这一层，被否：产物正确性已由既有测试覆盖，发布路径由 master 的排练覆盖，而 pull request 只需证明发布集能打出来。用 `file:` 说明符安装依然会对每个内部依赖走一遍范围解析。

**按入口闭包挑一部分包发。** 从 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-web-frontend` 沿 `dependencies` 爬得到 156 个包，比全量少 61 个。但本仓的插件是 `cordis.yml` 按名字挂载的、不是被 import 的：`vendor/cordis-plugin-group` 与 `vendor/cordis-plugin-logger-console` 落在依赖闭包之外，却是运行时必需。照代码依赖挑的失败形态是「消费方装完起不来」，而且要额外持续证明「没漏任何挂载项」。私有 scope 下多出来的包对组织外不可见。`python/`、`docs/` 与 `website/` 不属于 release family 成员。

**在 `scripts/publish-npm-baseline.ts` 上扩展。** 它是本机发布脚本，把 pack 与 publish 放在同一进程，与「无凭据 pack、受保护 publish」的分离相反。它验证过的零件——payload 校验与已安装产物探针——被搬运复用，以免 `pnpm run duplication` 判重复。

**一个 workflow 用 `family` 输入选择序列。** 两套版本模型塞进一个文件，会让 concurrency 组、tag 前缀、排练触发条件全部分叉成条件表达式。一族一个文件更短也更好读。

**在发布期改写依赖范围。** 与协议相比，改写逻辑只在 CI 执行过，本机 `pnpm install` 看不出它是否正确，而且每次发布都要重来一遍。

**在 CI 里执行 bump 并把版本推回仓库。** 需要给 workflow 仓库写权限，且发布分支上的版本 commit 会与人的 commit 竞争。bump 与 commit 留在本地，CI 只核对与上传。

## 后果

发布脚本是带入口守卫的可 import 模块，其判断都有单测覆盖：tag 命名、发布顺序与环报告、版本基线运算，以及各族的 payload 策略。入口守卫阻止 import 执行发布命令。

一个 pull request 会为两条序列跑完整的 pack（无凭据），并把打包好的 dsh tarball 装进一次性 consumer，用普通 Node 驱动 `dsh --version`。这个探针刻意只有一条命令：它证明 `files` 选出了完整 payload、发布出去的范围可解析，不涉及任何交互行为。

代价：

- **tag 可能与 registry 漂移。** 即使发布失败，tag 仍预留版本；发布负责人另行核实 registry 中的完成状态。
- **版本基线依赖 tag 可见。** shallow clone 或未拉取 tag 的 checkout 可能复用已预留的 vendor 版本。`fetch-depth: 0` 是前提，不是优化。
- **协议改写触及 1504 处依赖声明。** 它不改变本机解析（pnpm 本来就从 workspace 解析），但改变了发布出去的范围写法。
- **私有包需要凭据才能安装。** 任何消费方——CI、沙箱 e2e、外部使用者——都要持有 scope 凭据，Landlock 三包也在其中；它们从未发布过，所以没有切断既有的匿名安装路径。
- **`repository` 指向的组织与运行 workflow 的组织不同。** 用 token 发布不受影响；npm 的 OIDC attestation 要求二者一致，届时要么把 `repository` 改指过去，要么从它指向的组织发布。
- **字节可复现性是假定的，没有实测。** 「integrity 相同则跳过」这一态建立在「同一 commit 两次 pack 得到相同字节」之上。目前没有任何东西测量过它：若构建嵌入了绝对路径或时间，重跑会误报失败。在第一次可能被重跑的发布之前实测，若不成立就退到比对 tarball 内逐文件内容哈希。
- **用较旧的 artifact 重跑 publish 会把 `latest` 拉回旧版。** 发布是按版本决定的，所以在较新版本之后重发较旧的一批，会让稳定 dist-tag 再次指向旧版。排练用的是预发布版本，它永远不占 `latest`。
- **首发是一次大步。** 九个 vendored 包与整个 dsh 集一次发出，任何 payload 缺陷都会集中在同一次发布里暴露——这正是先用预发布版本把完整链路走一遍的理由。
