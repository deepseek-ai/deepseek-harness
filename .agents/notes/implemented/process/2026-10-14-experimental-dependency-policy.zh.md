# Agent Note: 实验包遵守同一套依赖声明规则

Status: implemented

[English](2026-10-14-experimental-dependency-policy.md) | 中文

## 问题

如果 [verify-package-dependencies](../../../../scripts/verify-package-dependencies.ts) 的检查范围是 `packages/!(experimental)/*/package.json`，整个 experimental 组就不受“浏览器和类型关系只放 devDependencies”（[client 依赖规则](../../../../packages/client/AGENTS.md#dependency-declaration)）的约束，[发布依赖面](2026-08-26-published-dependency-faces.zh.md)也曾把覆盖范围写成“非实验包”。在这一范围下，有 4 个实验 client 包把 client、api、session 等包写成 peerDependencies。webworker packer 会沿 workspace peer 把这些包收进镜像，浏览器静态库因此成了扫描起点，agent-team-profile 打包时出现 82 条无法解析的请求。[实验包规则](../../../../packages/experimental/AGENTS.md)写明实验身份不放宽工程要求，这一豁免与之矛盾。

按同一套规则检查 6 个带 `dsh.client` 的实验包，全量共 46 条违规，全部出在实验包。另外，只从 Host 入口追踪运行时导入的 verifier 会把 inspector 的 `ws` 误判为只该放 devDependencies，因为它只在 worker_threads 入口里使用。

## 决策

- 检查读取 `packages/*/*/package.json`，experimental 包与正式包遵守完全相同的规则，不设组级豁免，依赖区段检查也没有其他针对实验包的例外。
- verifier 同时扫描包自己的 Host 侧 worker 和子进程入口，识别依据是包 `tsdown.config.ts` 声明的构建入口。`readHostBuildEntries` import 这份配置，在 `host` 和 `client` 两个构建 face（`DSH_BUILD_FACE`）下各求值一次默认导出并取并集，保留 platform 不是 browser、源码不在 `src/client/` 下的 entry。不靠猜源码写法。配置只能异步 import，所以 verifier 的状态读取是 async。
- 受影响的实验包清单和 lockfile 符合策略；从 `peerDependencies` 或 `dependencies` 移走的每一项都确认过不是运行时必需。cot-translation 对 translator 的 `TranslationError` 做 `instanceof` 判断，需要同一个类实例，因此 `peerRequiredHostExports` 收录了这个导出。
- 纯 Host 的实验包与正式包一样，只有列入 `hostPackages` 才受检查。是否扩大到全部纯 Host 包，另行决定。
- 本决定部分取代[发布依赖面](2026-08-26-published-dependency-faces.zh.md)的选包覆盖范围，该 Note 的选包段落链接回本 Note；它的其余决定保持有效。

## 考虑过的替代方案

**只修这几个清单，不改检查范围。** 很快会再出现；规则没有执行点等于没有规则。

**在 packer 里跳过浏览器静态库这类扫描起点。** 只是绕开症状，错误的清单还会影响 npm 安装和其他消费方。

## 后果

`pnpm run verify-package-dependencies` 覆盖带 `dsh.client` 的实验包，它接受的清单让 webworker packer 能打包 agent-team-profile 和 voice-input-bundle，inspector 的发布清单也保留它的 worker 运行时依赖。

这一取舍的代价：

- 发布的实验包清单只把浏览器和类型关系列为 dev 依赖，通过 npm 单独安装这些包的用户得到的 peer 提示更少。
- verifier 看不到 tsdown `banner` 注入的导入，例如 inspector worker 的 `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap`。这类依赖只因为已经声明而被保留；如果被误删，verifier 发现不了。
- `readHostBuildEntries` 会 import 每个受覆盖、带 Host face 的包的 `tsdown.config.ts`，并在两个构建 face 下求值其默认导出，所以门禁依赖每个这样的配置模块都能干净地 import，这些模块的 import 副作用也会在门禁进程里执行；例如 inspector 的配置会 import 包内的 [`scripts/build-devtools.ts`](../../../../packages/experimental/inspector/scripts/build-devtools.ts)。
- 实测：新增的 127 个 tsdown 配置加载约 2 s，全量耗时基本不变（不扫描时 4:27，扫描时 4:21）。

## 测试

[verify-package-dependencies.spec.ts](../../../../scripts/verify-package-dependencies.spec.ts) 锁定三种情形：实验 client 包把浏览器包写成 peer 时会被拒绝；列入 `hostPackages` 的实验包按 configured Host 包检查；只在 `tsdown.config.ts` 指定的 worker 入口里使用的运行时依赖保留在 dependencies。同一份 spec 还锁定 translator 的 `TranslationError` 属于 peer-required 分类。
