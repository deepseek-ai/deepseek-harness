# Agent Note: Install failures keep their diagnostics in the dialog

Status: implemented

[English](2026-10-28-plugin-install-failure-diagnostics.md) | 中文

## Problem

一次插件安装失败时，界面可能显示通用的“安装过程中出错，原因见安装详情”，而展开后的详情只有“无输出”。对话框渲染的是实时的 install-log 流和失败 kind，而解释这类失败的 Host 诊断从未进入该流。打印了空输出的 pnpm 运行，其诊断（`result.shortMessage`，缺省为 `pnpm failed`）只写进完整日志和返回结果，从未被流式发送，因此对话框的终端一直是空的。在 pnpm 运行前就中止安装的 GitHub 连接检查，其捕获的输出只留在 `packageResult.output` 里。客户端同时也忽略了已结束结果中的 `packageResult.logPath` 和 `stage`，所以即使诊断已被记录，失败界面也没有指向完整日志的入口，也无法说明安装其实已经完成、失败发生在启用 bundle 时。

## Decision

**install-log 流携带对话框所展示的每一次运行的 Host 诊断。** 没有打印任何内容就失败的 pnpm 运行，会把 Host 为其记录的那条诊断流式发送出来，于是完整日志和对话框显示同样的文本。GitHub 连接检查会报告它实际执行的 `git … ls-remote` 命令行，并去掉 http(s) 仓库 URL 中的用户信息；当它的网络失败或超时中止安装时，`installBundle` 把该命令、捕获的输出和这次失败的退出状态作为该次安装唯一的 install-log 运行、以调用方的 request id 发出。安装仍能继续进行的检查失败不发送任何内容。超时的检查里 Git 没有返回退出状态，所以该运行不带退出码结束；返回结果记录强制填入的状态 1，因为 `PackageResult.exitCode` 是数字，而 `PackageResult.timedOut` 说明该状态只是失败被读取成的状态。命令行本身仍只在模块内：`installBundle` 在返回的普通 `PackageResult` 上剥掉它，因此不会多出 wire 字段。

**失败界面保留已结束结果所报告的内容，而不只是实时流。** `InstallState` 持有已结束的 `packageResult.logPath`——结束对话框的那次运行，位于 Host 文件系统——详情把它标为完整日志。`InstallState['failure'].stage` 与 `ChangeResult.enabled` 补充一句话：安装已完成，启用 bundle 时失败；只有当这次变更确实要求启用时才出现，把启用留给**立即启用**的安装不会声称启用失败。已结束界面里没有任何流式运行的详情会说明对话框没有收到终端输出，而不会断言运行本身没有输出；安装进行中也不会这样说。通用提示句点明失败的是安装命令，但失败步骤是应用已启用的 bundle 时，只使用启用阶段的那句话。安装应答与日志走不同传输，因此首个 chunk 晚于应答到达的运行会作为已结束的运行保留在已结束的对话框里，既不会被丢弃，也不会显示成运行中。

不新增 wire 类型、公开导出或配置键：`ChangeResult.packageResult.logPath`、`ChangeResult.stage`、`ChangeResult.enabled` 和 `packageResult.timedOut` 本来就把这些事实带给每个消费方。检查的命令行是 `github-connection.ts` 内模块级的 `GithubConnectionFailure`。

## Alternatives considered

**让客户端从 `packageResult.output` 合成一次终端运行。** 否决：对其他读取方（agent 工具和完整的 Host 日志）来说 install-log 流仍然不完整，而且对话框会出现两种“运行”的概念——一种来自流，一种从结果重建。

**把 `packageResult.output` 渲染成单独的 Host 诊断块。** 否决：它会以第二套样式和文案路径重复终端界面，而且失败检查的命令行仍然缺失。

**给 `ChangeResult` 新增失败阶段字段。** 否决：`stage` 已经区分安装和启用，而且只有启用需要自己的提示句；第二套阶段词汇会让每个消费方为一个事实学两个字段。

**保留通用提示句、只依赖详情。** 否决：这次要修的正是被该提示句指向的空详情面板，因此提示句不能承诺对话框并不显示的诊断。

**在流式运行里也报告检查被强制的退出码。** 否决：流描述的是进程实际做了什么，而被期限终止的 Git 没有返回任何状态；结果保留强制状态只是因为它的退出码字段是数字，JSDoc 已写明这一点。

## Consequences

- 安装失败后总有可行动的信息：静默失败时的 pnpm 诊断、GitHub 连接失败时出错的 Git 命令及其输出、结束对话框那次运行的完整日志，以及已启用的安装在应用阶段失败时点名失败步骤的一句话。
- 通用提示句在所有词典中变为“安装命令失败，原因见安装详情”；详情里的无运行提示改为说明对话框没有收到终端输出。
- GitHub 连接失败会报告 `timedOut` 并返回强制状态 1，而它的流式运行不带退出码结束；展示的命令行去掉 URL 用户信息，Remote 应答里也不会多出 `argv` 字段。
- 详情里的日志路径只覆盖结束对话框的那次运行，且是 Host 路径，因此更早的换源尝试与远端浏览器可能都够不到它。
- 不新增配置、wire 字段或公开包导出。

## Related

[Guided plugin installation](../architecture/2026-09-15-guided-plugin-installation.zh.md) 拥有安装对话框的各个界面、安装前的 spec 检查和失败分类；本记录扩展了它的失败界面和 install-log 流。

## Testing

- `packages/boot/plugin-manager/tests/operations.spec.ts` 钉住无输出诊断的流式发送；`github-connection.spec.ts` 钉住去掉 URL 用户信息的记录命令行与超时状态（含结果里的强制状态）；`manager.spec.ts` 钉住以 request id 发送的唯一检查运行、超时下缺失的退出码、返回的 `packageResult` 不含命令行，以及 pnpm 可能自行解决的检查失败不发送任何运行。
- `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` 钉住已结束的日志路径、stage 与启用事实、首个 chunk 晚于应答到达时保留的运行，以及重试时的重置；`components.client.spec.tsx` 钉住启用阶段的提示句（只对要求启用的安装）、完整日志行，以及已结束界面的无输出提示句。
- `apps/web/tests/plugin-install-github.e2e.ts` 展开一次真实 GitHub 连接失败的详情，找到 Git 命令、它的输出和日志路径；`apps/web/tests/plugin-install-silent-failure.e2e.ts` 让一次真实安装通过不打印任何内容的包管理器失败，并在详情中找到该运行的命令行、诊断和完整日志。
