# Agent Note: 将实验包隔离在默认产品之外

Status: implemented

[English](2026-09-12-default-product-experimental-isolation.md) | 中文

## Problem

在 npm 上公开可用不意味着实验包属于默认产品。直接 manifest 检查会漏掉依赖别名、传递安装路径、仅声明为开发依赖的运行时导入，以及由配置加载的插件。发布 smoke 会一起安装所有 tarball，因此消费者目录中存在实验包并不能说明默认产品需要它。

## Decision

[`verify-default-product-isolation`](../../../../scripts/verify-default-product-isolation.ts) 在静态 CI 和包 hygiene 中运行。它从所有应用与 Python runtime 出发，遍历运行时依赖、可选依赖和 peer，解析 workspace 与 npm 别名，并按 npm 前缀或仓库目录识别实验包。发布 denylist 的成员关系不影响此分类。启动器在 `OPTIONAL_BUNDLES` 里点名的组合包是唯一声明的例外（[随安装提供的可选组合包](2026-09-15-shipped-optional-bundles.zh.md)）。

源码检查还读取所选包的运行时导入、安装自带的 profile bundle 列表、bundle patch、随产品提供的 Agent preset，以及声明的配置树。它使用生产 patch 解析器加载默认 Web 各层，并使用启动时的同一个 patch 引擎完成组合。检查对象包括最终 entry 和应用 patch 后的 Include 树，因此仅按 id 覆盖 group 的 patch 也无法隐藏替换后的插件。禁用的插件行仍纳入检查；普通插件配置数据不会被解释为另一个 Loader entry 列表。默认入口缺失会使检查失败。

默认 Web 源码图从实际 HTML 入口中的 module script 出发，包括内联模块和本地引用的 Worker 入口。独立的实验预览可以存在而不加入此图；默认入口导入它时检查会失败。源码中的 Cordis 配置文件引用会将 Desktop patch 纳入同一证明。

[Host 启动 smoke](../../../../apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts) 在独立 Harness home 中通过构建后的 `dsh` 导出启动真实 Web profile。测试专用观察器在就绪后读取实际 Loader 行、注册的 fiber、注册回调所属模块和 Node 已加载模块缓存。[Chromium smoke](../../../../apps/web/tests/default-product-isolation.e2e.ts) 启动实际交付的页面，读取真实 Client Loader、registry 和模块缓存，并要求所有交付 entry 均已激活。两项检查都会拒绝其显式负例命令挂载的真实实验插件。现有 expected-output 和 Web CI lane 在完整构建后执行这些测试。

构建输入检查覆盖浏览器打包的两个阶段。[Client preset](../../../../packages/client/tsdown.client.ts) 在原始路径被折叠进 `lib/client.js` 前，拒绝非实验输出中的实验输入。[Web 图检查](../../../../scripts/web-product-bundle-isolation.ts) 从 `index.html` 沿真实 Vite 输出边遍历，覆盖延迟加载 chunk、Worker、CSS 依赖和资源。独立 preview 不属于产品图。缺少必需的模块或资源输入记录会使构建失败；失败的 Web 构建无法产生成功的完整 Client 构建记录。Notices 生成器通过显式分析标记检查其部分依赖图，该标记要求禁用输出写入。其他内存内产品构建仍执行这些检查。

[`verify-packed-install`](../../../../scripts/release/verify-packed-install.ts) 从 `@deepseek-ai/dsh` 遍历已安装依赖图，通过解析后的 manifest 名称识别别名和外部传递依赖。开发依赖以及安装在产品旁边的不相关 tarball 不参与遍历。缺失必需依赖会失败；允许省略可选依赖，但其名称不得指向实验包。

此检查执行现有的[实验包依赖隔离规则](../architecture/2026-08-18-experimental-agent-teams-packages.zh.md)。[发布策略](2026-09-12-experimental-publication-denylist.zh.md) 独立决定显式消费者可以安装哪些实验包。

## Alternatives considered

**只检查直接依赖名称。** 别名、运行时源码导入和配置加载的插件可以绕过该检查。

**拒绝任何已安装的实验 tarball。** 发布 smoke 有意安装整个发布族，包括可选启用的包。只有默认入口的依赖图能够回答这些包是否成为产品依赖。

**将全部 Web 源码视为默认入口。** 即使默认 HTML 和运行时导入从未到达独立的实验预览，这也会错误拒绝它。

**只检查最终 Vite 模块路径。** 稳定的 `lib/client.js` 路径可能包含前一阶段从实验包打入的代码。每个打包阶段都必须检查实际输入。

## Consequences

实验包可以发布而不加入默认安装或组合。源码、最终组合、构建输入、安装依赖和运行时 registry 检查提供相互独立的证据。SDK 的[源码启动兼容 patch](../../../../apps/cli/src/sdk-source.cordis.patch.yml) 通过计算出的文件路径选择，不在静态配置发现范围内。运行时 smoke 观察启动和 Client 激活；它们不替代后续每条用户触发路径的测试，也不替代显式安装的 profile 扩展测试。
