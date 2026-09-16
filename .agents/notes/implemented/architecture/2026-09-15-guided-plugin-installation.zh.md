# Agent Note：引导式插件安装

Status: implemented

[English](2026-09-15-guided-plugin-installation.md) | 中文

## 问题

安装对话框把 spec 直接交给 `pnpm add`，并把 pnpm 的终端当作全部说明：打错字、已装过的包、不存在的路径、注册表不可用，最后都是同一个红色退出码，人得去读 pnpm 输出才知道是哪一种，而且一旦开始就停不下来。失败的运行，或者装进来一个没有组合包 patch 的包，会把依赖留在 profile 里，列表上却没有任何东西能显示或移除它。启用是一个在知道要装什么之前就得勾的选项，装完的包散在列表某处。

## 决定

**宿主先读 spec，再安装。** `PluginManager.inspect` 用 `parseInstallSpec` 把 spec 分成注册表名、绝对路径、git 地址、压缩包，拒绝 pnpm 或注册表不会接受的写法，再通过 `pnpm view` 问注册表、或读目录的 `package.json`，得到名字、版本、描述和组合包声明。`pnpm view` 在 profile 目录里运行，让注册表和代理设置与安装一致。没有组合包 patch 的包在这一步、在 pnpm 运行之前就被拒绝：管理器只安装组合包。答复带七种 problem 之一；客户端把每一种渲染成输入框下的一句话，spec 保留可改。列表里已有的名字由对话框直接拒绝，不问宿主。

**失败或被取消的安装恢复 profile 文件。** `installBundle` 在 pnpm 运行前快照 `package.json` 与 `pnpm-lock.yaml`，在 pnpm 失败、运行被取消、或 pnpm 装入的包没有声明组合包 patch 时把它们放回去。这只针对安装反转了[管理器的决定](2026-09-14-current-profile-plugin-management.zh.md)中"保留部分改动"的部分：没有产出可用组合包的安装，不能留下一个页面无法显示的依赖。删除仍沿用那个决定。已下载文件可能留在 `node_modules` 与 pnpm 缓存中。

**失败在事实所在处分类。** `classifyInstallFailure` 依据运行的结束方式和 pnpm 的输出——它的 `ERR_PNPM_*` 码和 Node 的 errno 名——给出 `packageResult.kind`。客户端把 kind 显示成一句话，把 pnpm 输出折叠进详情。对日志的解析只存在于这一个函数，用夹具驱动的测试钉住。

**取消属于管理器，不属于信号。** 对话框为每次运行生成一个 request id；宿主在它之下流式转发运行的输出与阶段，`cancelInstall` 只在 pnpm 退出且文件恢复后才答复。对话框等到这个答复才把 spec 重新交回；中止的 RPC 或断开的连接都不算确认。只有检查末尾接受 `AbortSignal`：返回编辑或关闭会丢掉一次注册表查询，没有人等它的结果。

**启用在事后。** 运行以 `enabled: false` 安装；完成画面为它新增的组合包提供**立即启用**，对话框关闭，列表滚动到它。在人看到装了什么之前，不会启用任何东西。

**当下的结果是 toast。** 要等下次启动的变更、被更高层覆盖的变更、被取消的运行、被拒绝的操作，各弹一条 toast 后自行消失；页面上不留任何东西。

**被拦下的安装脚本在失败界面批准。** pnpm 11 把依赖脚本留作未决时，失败的运行报告待决定的包名（[管理器的授权](2026-09-14-current-profile-plugin-management.zh.md)），失败界面列出它们并以**允许这些脚本并重试**取代普通重试；store 带着 `approvedBuilds` 用同一个已检查的 subject 再跑一次，安装完成界面说明允许了哪些脚本。正因如此，`pnpm-workspace.yaml` 不在恢复的文件之列。没有待决定的名字时，失败退回到手动放行的提示。

## 考虑过的替代方案

**在客户端校验 spec。** 否决：规则属于 pnpm、注册表和 profile，客户端无法导入拥有这些规则的宿主包。

**用 HTTP 直接查注册表而不是 `pnpm view`。** 否决：决定安装能否成功的注册表、代理与认证设置都在 pnpm 的配置里，`pnpm view` 读得到，直接 fetch 得重新实现一遍。

**通过中止 add RPC 来停止运行。** 否决：断掉的 RPC 说不清 pnpm 是否停了、manifest 是否已恢复，对话框会在一次仍在写 profile 的运行之上把 spec 重新交回。管理器的 `cancelInstall` 只在清理完成后答复，对话框等它。

**继续列出不是组合包的依赖。** 否决：管理器管理的是组合包，它拒绝安装的包无法经由它列出或移除；检查在写入任何东西之前就拒绝这样的包。

## 后果

`inspect`、`cancelInstall` 以及 `plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state` 事件加入管理器的 Remote；`listBundles` 携带标题、行与覆盖项；`ChangeResult` 增加 `cancelled`、`bundle` 与 `packageResult.kind`；配置增加 `pnpmCommand` 与 `inspectTimeoutMs`。对话框是围绕同一张主题卡的四个画面。

## 测试

`packages/boot/plugin-manager/tests/install-spec.spec.ts` 钉住 spec 形式与失败分类器的输入；`manager.spec.ts` 用桩住的注册表查询和真实目录驱动 `inspect`，流式转发一次运行，停下一次运行并检查恢复后的文件，并检查变更事件；`operations.spec.ts` 覆盖注册表查询。`packages/client/ui-plugin-manager/tests` 覆盖 store 的阶段、经宿主确认的取消、装后启用、toast 与页面的四个画面；`apps/web/tests/plugin-manager.e2e.ts` 经真实宿主拒绝已装名字、不存在的路径和坏名字，并实时切换一个组合包及其中一行，`plugin-install-cancel.e2e.ts` 从对话框停下一个真实子进程、检查恢复后的文件，并在第二次尝试时装成，`plugin-install-approve.e2e.ts` 用假 pnpm 把脚本留作未决、从对话框允许后在重试中装上。
