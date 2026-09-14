# Agent Note: 构建产物豁免以失败的样式表为准

Status: implemented

[English](2026-09-10-built-bundle-css-exemption.md) | 中文

## 问题

[Node import sweep](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts)因 Node 无法加载 Dockkit bundle 的样式表而豁免该 bundle，并曾以一个精确的样式表路径作为接受证据：`packages/client/ui-dockkit/lib/components/dockkit.module.css`。该已构建 bundle 在导入自身样式表之前先导入 workspace 包 `@deepseek-ai/dsh-client-ui-primitives`，`tsx` 启动器又通过 tsconfig `paths` 把这个说明符解析进依赖的 `src` 树，因此 sweep 报告的是 `packages/client/ui-primitives/src/StateDot.module.css` 的 `ERR_UNKNOWN_FILE_EXTENSION`。固定路径在带有 client 构建输出的树上无法匹配，Windows 完整门禁的清单于是把这个豁免 bundle 报告为意外的基线失败。

## 决策

Dockkit 豁免接受 Node 对任意样式表因未知 `.css` 扩展名而拒绝加载。其他扩展名、其他错误码和无关的错误消息仍计为发现，能顺利完成导入的豁免 bundle 同样计为发现。

## 考虑过的替代方案

**在固定路径之外同时接受依赖的源样式表。** sweep 报告的正是该文件，但选中它的是 bundle 的导入顺序和启动器的路径映射。固定该路径认定的将是这两处细节，而非 `.css` 豁免。

**用同一规则分类每个 CSS 豁免。** Dockkit 固定路径是本次修改所纠正的已记录证据；另外两个样式表豁免从未被分类，收窄它们会在所报告缺陷之外改变其接受的内容。

**放弃分类，接受任何失败。** 届时因无关原因停止导入的 bundle 会隐藏在豁免总数之内。

## 后果

只要 Dockkit bundle 因 Node 未知 `.css` 扩展名拒绝之外的任何原因停止导入，sweep 就会报告它，该条目也不再断言失败的是哪个样式表。[限定范围的 resolve/load hook](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus.spec.ts)覆盖被接受的 Dockkit 样式表、依赖的源样式表、其他扩展名、任意消息、其他错误码和陈旧豁免，不修改共享构建产物。

[CI 观察决策](../testing/2026-09-08-ci-completion-observations.zh.md)保留其拥有的 fixture 完成与隔离决策；其已构建 Client 导入分类段落保留 sweep 摘要，并就被接受的证据链接到本文。
