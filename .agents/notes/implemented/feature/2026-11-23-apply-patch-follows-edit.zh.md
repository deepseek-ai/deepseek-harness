# Agent Note: Apply patch 跟随 edit

状态：implemented

[English](2026-11-23-apply-patch-follows-edit.md) | 中文

## 问题

[随发行版交付的文件系统修改默认值](2026-10-29-shipped-fs-mutation-defaults.zh.md)通过在 `dsh-base` 的 `tool-fs` 行与 Web 的 `standard` preset 上写出 `applyPatch: true` 来开启 `apply_patch`，而 `ptc`、`cordis` preset 与 PTC overlay 写出 `false`，`tool-fs` schema 的默认值也是 `false`。Agent preset 列出完整的插件声明，没有共同的父级，因此每个内置默认值都要在每一行上重复，随发行版交付的各编码 preset 也会对同一工作区提供不同的文件编辑工具。

## 决策

- `tool-fs` 在显式的 `resolveConfig` 步骤（[`src/index.ts`](../../../../packages/fs/tool-fs/src/index.ts)）中把未设置的 `applyPatch` 解析为解析后的 `edit` 值；显式写出的 `true` 或 `false` 优先，schema 不再为 `applyPatch` 提供默认值。
- `dsh-base` 的 `tool-fs` 行（headless、SDK、ACP）、Web 与 Desktop 的 `standard`、`ptc`、`cordis` preset，以及随发行版交付的 [PTC overlay](../../../../apps/cli/config/examples/ptc.yml) 都不写 `applyPatch`，因此都在 `edit` 旁提供 `apply_patch`：原生执行下是 JSON 工具，PTC 下是 `run_code` 绑定。Web 的 `minimal` preset 与 `sdk-minimal` 设置 `edit: false`，不提供它。SDK 与 Desktop 的 `standard`、`ptc` 工具集保持一致。
- 固定 token 预算的压缩场景继续钉住 `applyPatch: false`，因为它们的阈值是按录制时的工具集调的。

## 考虑过的替代方案

**在每个内置行上写出 `applyPatch: true`。** 每个 preset 和 base 行都要重复这个值，新的组合开启 `edit` 时也必须记得写上；在 `tool-fs` 内推导默认值，只需在一处决定。

**在 PTC 与 `cordis` preset 中保持 `apply_patch` 关闭。** PTC 组合是在没有该工具的情况下评测的，但保持关闭会让随发行版交付的各编码 preset 对同一工作区提供不同的文件编辑工具。PTC 下该工具是 `run_code` 内的绑定而非 JSON schema，每个请求增加的内容很少。与 base 和 `standard` 的默认值不同，这两个 preset 开启它依据的是这种一致性，而不是单独的 benchmark。

## 后果

每个保留 `edit` 且未写 `applyPatch` 的 `tool-fs` 行都会注册 `apply_patch`，包括第三方 profile、preset 和插件中的行；[升级指南](../../../../docs/upgrade-guide/v0.2.3-alpha.2/apply-patch-default-on/guide.zh.md)给出关闭它所需的一个键。`dsh --dump-config` 只渲染显式写出的键，因此推导出的值只能在模型请求中看到，在输出中看不到。`tool-fs` 行开启 `edit` 而未写 `applyPatch` 的录制预期带有该工具的提示语与 schema。

## 测试

`tool-fs` 注册测试覆盖推导出的默认值和两种显式覆盖。`web-agent-presets.e2e.ts` 断言 `cordis` 工具集与 `ptc` 的 `run_code` 绑定中都有 `apply_patch`；keyless SDK smoke 检查原生工具和 PTC overlay 下的绑定；`desktop-tools.expected.e2e.ts` 比较 SDK profile 与 Desktop `standard` preset 的首个模型请求（含工具 schema）。
