# Agent Note: Forge 提供方命令规则

Status: implemented

[English](2026-11-11-forge-provider-command-rules.md) | 中文

## Problem

[Session 变更请求绑定](2026-10-09-session-change-request-bindings.zh.md)在 forge-session 内部识别 `gh` 命令，因此每接入一个代码托管平台的 CLI（如 `glab`）都要修改 forge-session；而 `glab mr view 7 -R group/app` 这类数字编号需要了解该 CLI 的选项与 URL 形式。识别结果供 Session 投影使用，因此必须在重放与检查点下保持确定；提供方在 Session 执行过命令之后才启用时，也应能绑定这些命令。

## Decision

每个提供方通过 `ctx.forgeSession.registerCommands` 注册一条声明式的 `ForgeCommandRule`：其可执行文件、创建子命令、各带选项的引用子命令组与原始 API 请求子命令组、变更请求页面路径、JSON URL 成员，以及一个纯函数 `select`，把一条解析后的命令映射为 URL 或只读查询。API 请求（如 `glab api`）只绑定其路径指向的变更请求，因为其输出可能列出许多变更请求。[forge-github](../../../../packages/experimental/forge-github/src/commands.ts) 注册 `gh`，[forge-gitlab](../../../../packages/experimental/forge-gitlab/src/commands.ts) 注册 `glab`。forge-session 保留共用部分：字面量 shell 拆词、选项解析、输出读取、在调用所在 shell 中的查询，以及投影。

`forgeChangeRequests` 的状态版本由已识别规则派生，即 `5 × 2^32` 加上排序后 `id@version` 对的哈希，因此按其他规则集折叠的检查点会被丢弃，日志重新折叠。改变规则集的注册会释放投影并以新版本重新注册，再刷新监听方；切换期间已释放的句柄仍可读取。注册结束后，其规则仍被识别，直到服务重启或另一条规则替换其 id 或可执行文件。

## Alternatives considered

**在 forge-session 内按 CLI 识别。**每次提供方变化都要修改 forge-session，其测试还要承担其他 CLI 的选项集。

**把规则放在 `ForgeProvider` 上。**forge-session 可以从 `ctx.forge` 读取规则，但 forge 的 Service Definition 就会带上只有一个 Consumer 使用的字段。

**规则只作用于之后的事件。**只折叠注册之后的事件，会漏掉 Session 在提供方加载之前执行的命令。

**固定的状态版本。**按当前加载的规则折叠，一旦规则变化，就违背了"恢复的检查点加后缀重放等于完整重放"这一规则。

**注销时重建。**关闭时提供方先于 forge-session 卸载，因此每次退出都会按更小的规则集写入检查点，每次启动都要重新折叠所有 Session。

**由各提供方解析选项。**逐词解析会在每个提供方中重复。

## Consequences

新增提供方规则或提高规则版本，会使每个 Session 重新折叠一次；Session 再次打开之前，Session 列表不显示它的缓存绑定；重新注册不发出投影变化事件，因此已打开 Session 的摘要要在后续事件之后才显示重新折叠的绑定。规则版本由提供方负责。运行时卸载提供方后，其命令仍被识别，直到重启，但不再执行反查；不加载该提供方启动时，只由其命令产生的绑定会消失，绑定记录保留。每次启动时投影先在没有规则的情况下注册，提供方注册规则后再注册一次。识别规则见 [forge-session README](../../../../packages/experimental/forge-session/README.zh.md#use-this-package)。
