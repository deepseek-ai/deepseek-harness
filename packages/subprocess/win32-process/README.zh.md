---
description: "面向实现或排查 Windows ACL 沙箱与普通子进程 Job runner 的维护者，说明底层 Win32 进程原语。"
kind: "package-library"
---

# @deepseek-ai/dsh-win32-process

[English](README.md) | 中文

## 概述

供 Windows ACL 沙箱与普通子进程 Job runner 消费的底层 Win32 进程库。它唯一拥有仓库中可复用 process、stdio 与 Job Object 操作的 Koffi 绑定表；它不是 Cordis 服务，也不决定沙箱策略或公共 child 行为。维护任一原生进程路径或检查 handle 生命周期限制时，请阅读本页。

## 目录

- [Behavior](#behavior)
- [头部验证](#header-verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="behavior"></a>
## Behavior

- **唯一可复用 ABI owner** — `abi.ts` 拥有两条 process 路径消费的 Win32 常量与 x64 布局值。`ffi.ts` 懒加载 `kernel32.dll` 与 `advapi32.dll`，核验 `STARTUPINFOW` 和 `PROCESS_INFORMATION`，提供带类型的操作与错误格式化，并让 sandbox policy 通过同一组已加载库绑定剩余 API。
- **restricted-token 创建** — `RestrictedProcessSpawnOptions` 要求 sandbox 的 primary token，并使用 `CreateProcessAsUserW`。pipe 与 inherited-stdio 路径共用命令行引用、cwd、restricted-token 空环境策略、返回值检查与句柄清理。
- **管道进程原语** — `spawnPipedProcess()` 创建匿名 stdin/stdout/stderr 管道，立即关闭 stdin，并返回两个读取端；调用方负责等待进程与排空管道。任一局部失败都会关闭该操作已经拥有的句柄，并在各自 Win32 生命周期结束后释放每个 Koffi 输出槽与结构体分配。
- **继承 stdio 的 Job 原语** — `spawnInheritedJobProcess()` 创建一个 kill-on-close Job，临时把当前 stdio 句柄设为可继承，以 suspended 状态创建 restricted child，把它分配给 Job，再恢复初始线程。目标代码不会在 Job 分配前运行；受控的分配或恢复失败会终止 suspended child，或在释放全部已拥有句柄前关闭已分配的 Job。
- **ordinary Job runner 原语** — `CurrentTokenProcessSpawnOptions` 要求已解析的 `applicationName`、完整 target 环境，以及三个专用于 target stdin、stdout 与 stderr 的 runner CRT 描述符。`spawnCurrentTokenJobProcess()` 通过 Node 导出的 `uv_get_osfhandle()` 把这些描述符映射为 OS handle，拒绝无效结果，临时把 handle 设为可继承，并通过 `STARTF_USESTDHANDLES` 传入。它使用 `CREATE_UNICODE_ENVIRONMENT` 传入排序后的 UTF-16LE 环境块，再以 suspended 状态通过 `CreateProcessW` 创建 target、把它分配给 unnamed kill-on-close Job，并只在分配后恢复。原始命令行 argv 项保持不变，runner 也可以关闭自己的 carrier 描述符，而不触碰 Node 自身的标准流。
- **ordinary 停稳操作** — `pollProcessExit()` 单独发布 direct exit，`isJobEmpty()` 则读取 `QueryInformationJobObject(JobObjectBasicAccountingInformation)`，直到 `ActiveProcesses` 归零。带检查的 Job 终止与 handle 关闭使 runner 保持唯一 native owner。
- **显式结算归属** — `waitForProcessExit()` 等待并关闭 sandbox process handle；ordinary runner 的 process polling、Job accounting 与 checked Job termination/closure 是独立操作。`drainPipe()` 在排空期间复用一个 native count slot，释放该分配并关闭管道读取句柄。每个调用方拥有自己的 result 组合与返回 handle。

Windows ACL 沙箱在这些原语上增加 SID、DACL、grant、workspace 与公共 child policy。

<a id="header-verification"></a>
## 头部验证

process、stdio 与 Job 的常量以及选定结构体的大小和偏移由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp) 对照 MinGW Windows 头文件检查：

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp && ./abi-probe.exe
```

Koffi 的 `STARTUPINFOW` 与 `PROCESS_INFORMATION` 定义还会在模块加载时断言各自的 64 位大小。该探针还固定指针与 handle 宽度、Unicode 环境标志，以及用于判断停稳的基础 Job accounting record 大小与 `ActiveProcesses` 偏移；其余已记录偏移和常量也由该探针提供证据。

<a id="model-experience"></a>
## Model Experience

### 进程原语

#### 模型看到什么

没有直接内容。本包向 sandbox 与 ordinary runner 提供 `Win32ProcessBindings`、`CurrentTokenProcessBindings` 与进程原语；两者拥有全部模型可见工具、输出与诊断，本包不贡献提示词或工具 schema。

#### Token 影响

没有直接影响。消费方决定进程输出是否进入工具结果或后续模型请求。

#### KV Cache 影响

本包不贡献稳定请求前缀，因此不会使模型 KV Cache 失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅在 Windows 原生加载** — 导入通用类型可跨平台进行，但解析绑定表会加载 Windows DLL，并在其他宿主失败。跨平台测试注入绑定表，不加载原生 API。
- **没有公共进程服务** — 本包刻意不把原语包装成 Cordis 或 Node streams。消费方必须拥有自己的策略、异步调度、输出上限、取消与最终句柄关闭。
- **restricted-token 空环境** — `CreateProcessAsUserW` sandbox 原语传入空环境块，并先通过 `SetEnvironmentVariableW` 建立改动，因为经 Koffi 传入显式环境块会以 `ERROR_INVALID_PARAMETER` 失败。ordinary `CreateProcessW` runner 则要求完整 target 环境，并传入排序、双 NUL 结尾的 UTF-16LE 块，其中包括 `=X:` 驱动器条目，而不修改自身环境。
- **没有 standalone process API** — 本包只暴露当前 sandbox 与 ordinary-runner consumer 所需的操作，不拥有 Node streams、公共 handle、output policy、cancellation 或 durable state。
- **创建到分配之间的中断** — 目标以 suspended 状态启动，不能在 Job 分配前执行，但 runner 若在进程创建到分配之间的极窄区间被外力终止，可能留下 suspended target。本包不声明原子 Job 附加保证。
- **header 证据限定架构** — 已提交的 ABI probe 与布局常量覆盖仓库当前 64 位 Windows 目标。支持新的指针宽度或不兼容 Windows ABI 前，必须先更新 probe。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。操作只持有调用内的 native handle。
