# Agent Note: Web lane assertions name their input state

Status: implemented
Archived: 2026-09-30

[English](2026-09-27-web-lane-assertions-name-their-input-state.md) | 中文

## Problem

浏览器通道的三个场景在捕获 aria 区域时，golden 记录的状态只是被指针、键盘或一次进行中的 Host 读取所隐含，因此每次捕获都可能落到另一种状态上。

[workspace-new-session-folding](../../../../apps/web/tests/workspace-new-session-folding.e2e.ts) 捕获同一侧边栏的两份 golden。`sidebar.expected.md` 记录的是 Workspace 行显示出行操作单元格的状态，该行为由 [Rows.module.css](../../../../packages/client/ui-workspace/src/client/rows/Rows.module.css) 的 `.projectRow:hover` 提供；`first-batch.expected.md` 则以 `.sessionRow:hover` 记录第六个会话行，即该批次展开出的第一行。两次捕获因此都取决于指针所在位置，而场景自身的 “Show 11 more sessions” 点击会在指针静止时重排列表。串行自托管 master 通道在这个场景上失败时，两份 golden 的要求都没有满足——`treeitem "{{workspace}}"` 不带操作按钮，golden 记录为悬停的那一行渲染出普通的相对时间——2026-09-24 至 2026-09-27 观察到的九次失败运行全部如此。

[turn-tail-actions](../../../../apps/web/tests/turn-tail-actions.e2e.ts) 两次捕获聚焦后的 Copy 页脚：`running.expected.md` 记录其旁有一个 `tooltip "Copy"`，`settled.expected.md` 则不记录。只要最后一次输入来自指针，[Tooltip](../../../../packages/client/ui-primitives/src/Tooltip.tsx) 就忽略聚焦，而只有 keydown 会清除该标记，因此第一次捕获是否出现气泡，取决于场景最后一次点击之后测试框架是否按过键。

[plugin-install-cancel](../../../../apps/web/tests/plugin-install-cancel.e2e.ts) 在带高亮的插件卡片出现后只读一次 `data-plugin-status`。store 的 `enableInstalled` 先标记卡片，再启动由 Host 应答的目录重载，因此高亮先于重载把已启用的 bundle 写入列表即可观察：三次本地运行中状态在 `disabled` → `running` 之间用了 61 ms，失败的那次运行正是在这个窗口内读取的。

## Decision

每次捕获都先确立其 golden 所记录的状态。

folding 场景在侧边栏捕获前悬停 Workspace 行，在 first-batch 捕获前悬停该批次展开出的第一行，两个被悬停的行都由场景确立，而不再继承 Show-more 点击周围的布局。golden、折叠配额与行渲染均不变；场景现在执行的是 golden 读者本会执行的那次悬停。

turn-tail 场景先用一个不移动焦点的按键清除指针标记，再聚焦 Copy 按钮，并等待 running golden 记录的气泡。settled 捕获保留普通聚焦，这正是 Stop 点击让指针拥有最后一次输入之后、其 golden 所记录的状态。

install-cancel 场景改为轮询卡片状态，而不再单次采样，因此该断言观察到的是高亮所先于的目录重载。高亮仍保留在定位卡片的 locator 中，因为随后推进 `2400 ms` 时钟的那步仍以它断言卡片会脱离。

## Alternatives considered

**在 aria normalizer 中折叠悬停与非悬停两种渲染。** 两者陈述不同事实——一行被悬停，其余没有被悬停——且两份 golden 都在有意记录行操作单元格与相对时间。折叠它们是在删除断言而非稳定断言，这与通道中每一份有意记录带日期或带状态形式的 golden 所拒绝的取舍相同。

**投递空白事件并让指针停留在点击后的位置。** 批次插入时按钮随之移动，指针下的行仍由布局决定：下面的 folding 负向对照在指针位于侧边栏内、没有任何行被悬停时复现了该失败。

**在场景内禁用悬停样式或 tooltip 的模态规则。** 两者都是 golden 所证明的已发布渲染与交互行为；场景级覆盖将测试一个产品并不提供的页面。

**提高捕获超时或重试比较。** 两者都不能确立实际捕获到的是哪个状态；`captureStableAria` 本已等待连续两次快照相等，而错误的状态同样能满足它——这一限度已由 [CI 就绪与完成决策](2026-09-08-ci-readiness-and-completion.zh.md) 与 [连接与压缩 fixture（测试前置数据）前置条件](2026-09-12-connection-and-compaction-fixture-preconditions.zh.md) 记录。

## Verification

两个负向对照用已发布的断言复现了记录到的特征。folding 场景第一次捕获前改为悬停 New Session 行而非 Workspace 行时，`sidebar.expected.md` 失败：golden 记录 `treeitem "{{workspace}} Workspace actions …"`，实际得到 `treeitem "{{workspace}}"`。turn-tail 场景在聚焦 Copy 按钮前只做一次鼠标按下而不按键时不会出现气泡，running 捕获随后失败并缺少串行通道记录到的 `tooltip "Copy"`。两个对照在改动之后均通过。

本地按文件实测：`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/<file>.e2e.ts` → workspace-new-session-folding 改动前 15/15、改动后 20/20，turn-tail-actions 改动前 8/8、改动后 20/20，plugin-install-cancel 改动前 12/12、改动后 20/20。通道配置 `DSH_SNAPSHOT=replay DSH_WEB_SNAPSHOT_WORKERS=16 pnpm run test:web:ci` 连续三次运行中三个文件全部通过。

install-cancel 场景还记录过独立的 30 s 高亮卡片等待：启用点击关闭对话框后，`node 24 / snapshots and artifacts` 上有两次、把该文件恢复到改动前版本后用同一通道命令运行的本地一次，都未能找到卡片。当时页面时钟已暂停，因此可排除高亮到期。[拦截器生命周期决策](2026-09-27-plugin-install-interceptor-lifetime.zh.md) 负责已定位的目录请求停滞及其 fixture 修复。状态轮询仍覆盖卡片出现之后的读取。

串行 master 通道同时失败的 WebKit 用例不是场景竞态，也不属于本次改动：`declared-reasoning.e2e.ts` 启动 Playwright 的 WebKit，通道的步骤只取浏览器本体而未安装宿主库，于是 `browserType.launch` 以 “Host system is missing dependencies to run browsers” 失败。[ci.yml](../../../../.github/workflows/ci.yml) 明确说明持久 VM 镜像拥有 Playwright 的 Linux 系统包，并且只在非自托管池随浏览器安装依赖集，因此修复镜像或该池的归属是 runner 侧的改动，而非场景改动。在开发者机器上安装 WebKit 依赖后该文件的 8 个用例全部通过。

## Consequences

三个场景无论测试框架以何种状态进入，都渲染其 golden 记录的 aria，且没有任何 golden、产品界面或超时被改动。输入状态现在由每次捕获自己拥有：凡是捕获悬停行、聚焦的 Tooltip 锚点，或由后续 Host 读取发布的值的场景，都必须自行确立该状态。`document-preview.e2e.ts` 的电子表格选区读取属于同一类缺陷，仍留给它自己的改动。

[任务详情关闭断言](2026-09-28-detail-close-waits-on-observed-state.zh.md) 记录了同一类缺陷在客户端单测 lane 上的实例：被采样的状态来自一个提交后 effect，而不是来自尚未结算的输入。
