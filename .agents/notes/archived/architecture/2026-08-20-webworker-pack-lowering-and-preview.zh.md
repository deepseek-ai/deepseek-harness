# Agent Note: pack 期 lowering 与单构建 preview

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-webworker-pack-lowering-and-preview.md) | 中文

## 问题

浏览器 worker 既不能在装载期编译模块，也不能由产品 webserver 提供页面：每个模块体必须以可直接运行的形态到达，页面必须是静态产物。两个面早期都发生过漂移。装载器曾携带一个兜底编译器，于是收集器的缺口表现为「启动变慢」而不是「镜像坏了」——而且 `acorn` 经包 barrel 混进了 `lib/worker.js`，一个只包装预 lowered 模块体的运行时根本不需要解析器。preview 曾是服务页面旁的第二份 HTML 模板，一个 served index 可以悄悄漂离的页面。

## 决定

**Lowering 只发生在 pack 期。** `@deepseek-ai/dsh-experimental-webworker-packer` 组合 profile、物化闭包、lower 每个 JavaScript 模块体；`LOWERING_VERSION` 与 `WRAPPER_PARAMS` 是 pack↔worker 的契约，与镜像布局的其余部分一起放在 `src/image-layout.ts`。装载器完全按镜像持有的形态包装模块体：仍带模块语法的模块体是一次点名镜像的拒绝，且 `startWorkerHost` 在挂载任何模块之前要求 manifest 的 `lowered` 等于本构建的契约。`lowerModuleSource` 是转换器唯一的面、packer 是它唯一的调用方；同一次解析会把具名静态 import、re-export 与动态 import、经 `require` 发起的调用，以及通过 `node:module` 或 `module` 具名导入在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用送入可达性遍历。保存下来的结果、经 CommonJS 获取的 `createRequire`、计算得到的请求名称与其他基准只在运行时解析；只能通过这些形式触达的目标需要镜像入口种子。worker 图内部的 import 一律指向拥有该值的模块——绝不指向包 barrel，那正是把解析器偷运进来的那条边。源码目录排除只用于运行期使用已构建 `lib/` 的 workspace 与 vendored 包；已安装第三方包会保留 `src/` 和 `dist/` 下的 JavaScript，因为其发布入口可能解析到这些位置。

**preview 就是服务页面加一个标签。** 一次 Vite 构建产出共享全部 chunk 的 `dist/index.html` 与 `dist/preview.html`；唯一差异是前插的一个引导入口，其模块负责连接 worker host。启动随之汇于一个协议：应用注入表的一方 settle `__DSH_BOOT_READY__` deferred——served 渲染器在渲染完的行之后用尾部脚本 resolve，worker 引导段在首个 await 之前安装、末行生效后 settle——client 入口在读取任何注入状态前 await 它，因此从标准入口起的链路逐字就是 served 链路。插件 combo 脚本与 map 都通过 tunnel；页面侧 loader 会在执行脚本 Blob 前，把每个仅 tunnel 可达的 map 内嵌为 Base64 data URL，从而不依赖另一条 object URL 的生命周期，并在 DevTools 中保留 indexed map 的组件名称。构建使用相对 base，产物可挂载于任意静态目录；served 形态在 serve 期渲染 `<base href="/">` 锚定深层 SPA fallback 路径，磁盘上的两个页面保持字节共享。

**仓库 preview 携带可选择的文件系统来源。** Packer 产出一份基础镜像，并为每套具名内置 fixture 产出一份小型 overlay 归档。没有来源 query 时，`preview.html` 会停在选择面板，可选择空文件系统、内置 fixtures，或归另一实现所有的 WebFS provider。合法的 `preview-fixture=none|<built-in-id>` query 会直接选择并跳过面板，供确定性的浏览器流程使用；该独立名称避开 Client 既有的 `fixture` transport 开关。Worker 先挂载基础镜像，再按顺序把所选 overlays 应用到仅限 `home/` 和 `workspace/` 的路径，随后才校验基础 manifest 并启动 Cordis。`packages/experimental/webworker-runtime/tests/fixtures/vfs-example/` 提供其中一套内置 overlay，Packer 无需理解 Session 或 Workspace。明文 JSONL 日志使用 persistence backend 的真实 project/session 目录布局，因此 Session Persistence 会冷读取它们，Workspace Registry 则根据其 `/dsh/workspace` header 派生 Workspace。主 Session 超过 Client 的 50-message page，并把代表性工具结果留在尾页；持久化的 one-shot 与 continuable child 用于验证 subagent catalog。WebFS 授权与用户数据仍属于独立 provider，绝不与该 fixture 共用目录。

两个包以 `@deepseek-ai/dsh-experimental-*` 名义放在 `packages/experimental/`，私有且在官方发布之外。承载产品承诺的边界仍在产品包里：注入表、`__DSH_TRANSPORT__` 与 `/plugins` bundle 字节由 `dsh-host-webserver`、`dsh-client-modules`、`dsh-client-connection` 拥有。

## 曾考虑的替代方案

**保留装载期转换器作安全网。** 它把坏镜像变成无人归因的耗时回归，并且让「这个模块体是谁 lower 的」从外部不可回答。

**契约常量留在转换器里，信任 tree shaking。** 转换函数确实被摇掉了，但 `acorn` 未声明 `sideEffects`，仅 barrel 一条边就把整个解析器带进了 worker bundle。

**独立的 preview 模板。** 已退役的 `preview.html` 模板复制了服务文档并发生漂移（语言、标题、入口接线）。在 `closeBundle` 从 built index 派生页面则彻底消灭了第二份文档。

**用顶层 await 顺序而非 deferred 去闸标准入口。** 兄弟 module script 互不等待对方的顶层 await；`??=` 安装的 deferred 使握手与求值顺序无关，且失败的握手能 reject 进 boot 页的失败呈现。

**在 Worker 启动时生成示例状态。** Preview 专用的 Session 或 Workspace 创建分支会绕过冷 persistence 读取，还会让 runtime 拥有测试数据。静态镜像文件与既有用户数据经过相同的发现和分页路径。

**通过 WebFS 注入示例。** WebFS 拥有用户选定的 durable storage 及其生命周期。让内置演示依赖它，会使静态 preview 受浏览器持久化状态影响，并模糊哪些字节来自部署。

**每套 fixture 各打一份完整基础镜像。** 完整镜像变体会重复 runtime package closure，并使组合数量平方增长。受限 overlay 只保留一个不可变基础镜像，选择面板可组合零到多个数据源，未来 WebFS 水合也能复用同一个 pre-boot 应用点。

## 后果

- `lib/worker.js` 不含解析器（当刀落时为 423.5 kB → 246.3 kB，早于 shell 进程层落地）。
- `diff dist/index.html dist/preview.html` 恰为一个 script 标签；`packages/experimental/webworker-packer/tests/image-loadable.spec.ts` 钉住装载器契约的两半，transform 语义套件钉住 `createRequire` 请求发现，`apps/web/tests/preview-boot.e2e.ts` 则在 web 浏览器车道钉住 preview 可用性（boot 到可交互页面），替代已撤编的 `apps/web/scripts/preview/` 探针脚本。
- 转换 corpus 会先通过 Node 导入每个已构建 bundle，再比较 lowered export。固定豁免会点名真正不可导入的 bundle，并在其恢复可导入时失败：`win32-process` 是 Koffi 类型 owner 并承担重复类型豁免；`sandbox-windows-acl` 可正常导入，不承担该豁免。
- served 的 `<base href="/">` 锚存在的原因是：相对资产 URL 在 SPA fallback 深路径下会解析进请求目录；只有与相对构建 base 一起才可移除它。
- 镜像以确定性 gzip 压缩的 tar 交付（`vfs-image.tar.gz`；MTIME 0、OS 字节 0xff）：静态托管不压缩二进制 content-type（类型白名单、CDN 尺寸帽），压缩必须随制品走；worker 用浏览器原生 `DecompressionStream` 在下载的同时解压 fetch body。
- Preview 会停在 pre-boot 来源选择面板。内置示例提供可复现的 Workspace 与冷 Session 语料，无凭据、零模型调用即可检查工具卡、subagent 导航和向前分页；空白选项保留首次启动覆盖。Fixture 测试通过生产 reader 校验物理日志，浏览器验收同时验证两种选择。
