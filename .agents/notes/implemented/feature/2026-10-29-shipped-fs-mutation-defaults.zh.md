# Agent Note: 随发行版交付的文件系统修改默认值

状态：implemented

[English](2026-10-29-shipped-fs-mutation-defaults.md) | 中文

## 问题

[Apply patch 文件编辑](2026-09-28-apply-patch-file-editing.zh.md)以 opt-in 方式交付 `apply_patch`，并保持 `dsh-fs-observation-policy` 挂载，因此所有叠加 base 的 profile 都会拒绝对模型未读过、或读后已变化的文件执行 `write`、`edit` 与 `apply_patch`。维护者对随发行版交付的组合分别在开启该工具和禁用该策略的情况下跑了 benchmark，与基线比较后讨论得出了随发行版交付的默认值。

## 决策

- `dsh-base` 的 `tool-fs` 行（headless、SDK、ACP）与 Web 的 `standard` preset 写出 `applyPatch: true`。Web 的 `ptc`、`cordis` preset 写出 `applyPatch: false`，随发行版交付的 [PTC overlay](../../../../apps/cli/config/examples/ptc.yml) 在 base 行上也设为 `false`，因此 SDK 与 Desktop 的 PTC 工具集保持一致，无需一致性例外。
- `dsh-base` 的 `fs-observation-policy` 行以 `disabled: true` 交付。叠加 base 的 profile 中每个修改工具都直接作用于裸提供方：`write` 覆盖，`edit` 替换唯一的字面匹配，`apply_patch` 只凭上下文匹配应用 hunk。部署在该行上写 `disabled: false` 即可为三者恢复防护。`sdk-minimal` 不叠加 `dsh-base`，不受影响。
- `write` 与 `edit` 的提示语仍要求先读，但不再点名该策略；`apply_patch` 的提示语要求给每个 hunk 足够的上下文以匹配唯一位置，而非先读。
- 由于没有默认组合挂载策略包，它被归类为可选产品包。录的是策略拒绝的两个场景 `fs-policy-reject` 与 `apply-patch-rejected` 通过各自的 `runtime.cordis.yml` 把该行开回来；固定 token 预算的压缩场景在 live 与 replay patch 中都钉住 `applyPatch: false`，因为它们的阈值是按录制时的工具集调的。

## 考虑过的替代方案

**只在 Web `standard` preset 开启 `apply_patch`。** SDK/Desktop 一致性检查会把 SDK profile 的 `standard` 工具集与 Desktop preset 比较，仅改 Web 需要为一个没有产品理由的差异永久保留一致性例外；开启 base 行让两边保持一致。

**只对 `apply_patch` 关闭策略。** 曾实现并评测过一个让补丁跳过 intent waterfall 的 `tool-fs` 开关，但它让 `write` 与 `edit` 继续受随发行版交付的组合已不需要的防护，并在策略行之外增加了第二个配置维度；禁用该行在一处决定三个工具，并为需要防护的部署完整保留策略包。

**在 PTC preset 中也开启 `apply_patch`。** PTC 下该工具是 `run_code` 内的绑定而非 JSON schema，代价很小，但 PTC 组合是在没有它的情况下评测的；overlay 与 Web preset 保持评测时的工具集。

## 后果

叠加 base 的 profile 的默认模型请求带有 `apply_patch` schema 与提示语，因此固定预算压缩场景之外的所有录制请求预期都变化了。模型可以覆盖或编辑从未读过的文件；[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.zh.md)给出恢复防护或去掉该工具的一行 patch。沙箱围栏、Review 采集与 `fs/observed` 事件不变。

## 测试

`tool-fs` 单元测试覆盖无防护路径（`policy: false`）。keyless SDK smoke 通过随发行版交付的 `sdk` profile 对模型从未读过的既有文件执行 edit 并检查磁盘字节。`desktop-tools.expected.e2e.ts` 比较 SDK 与 Desktop 的 `standard` 和 `ptc` 工具集。录制 corpus 以随发行版交付的默认值回放；`fs-policy-reject` 与 `apply-patch-rejected` 在策略开回的情况下回放。
