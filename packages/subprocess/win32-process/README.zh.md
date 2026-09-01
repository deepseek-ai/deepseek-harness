---
description: "面向实现或排查 Windows ACL 沙箱的维护者，说明底层 Win32 进程原语。"
kind: "package-library"
---

# @deepseek-ai/dsh-win32-process

[English](README.md) | 中文

## 概述

供 Windows ACL 沙箱消费的底层 Win32 进程库。它唯一拥有仓库中可复用 restricted-process、stdio 与 Job Object 操作的 Koffi 绑定表；它不是 Cordis 服务，也不决定沙箱策略或公共 child 行为。维护沙箱原生进程路径或检查 handle 生命周期限制时，请阅读本页。

## 目录

- [Behavior](#behavior)
- [头部验证](#header-verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="behavior"></a>
## Behavior

- **唯一可复用 ABI owner** — `abi.ts` 拥有 sandbox process 路径消费的 Win32 常量与 x64 布局值。`ffi.ts` 懒加载 `kernel32.dll` 与 `advapi32.dll`，核验 `STARTUPINFOW` 和 `PROCESS_INFORMATION`，提供带类型的操作与错误格式化，并让 sandbox policy 通过同一组已加载库绑定剩余 API。
- **restricted-token 创建** — `RestrictedProcessSpawnOptions` 要求 sandbox 的 primary token，并使用 `CreateProcessAsUserW`。pipe 与 inherited-stdio 路径共用命令行引用、cwd、继承环境块、返回值检查与句柄清理。
- **管道进程原语** — `spawnPipedProcess()` 创建匿名 stdin/stdout/stderr 管道，立即关闭 stdin，并返回两个读取端；调用方负责等待进程与排空管道。任一局部失败都会关闭该操作已经拥有的句柄，并在各自 Win32 生命周期结束后释放每个 Koffi 输出槽与结构体分配。
- **继承 stdio 的 Job 原语** — `spawnInheritedJobProcess()` 创建一个 kill-on-close Job，临时把当前 stdio 句柄设为可继承，以 suspended 状态创建 restricted child，把它分配给 Job，再恢复初始线程。目标代码不会在 Job 分配前运行；受控的分配或恢复失败会终止 suspended child，或在释放全部已拥有句柄前关闭已分配的 Job。
- **显式结算归属** — `waitForProcessExit()` 等待并关闭进程句柄。`drainPipe()` 在排空期间复用一个 native count slot，释放该分配并关闭管道读取句柄。sandbox 保留既有调度、result 组合与调用方拥有的 Job 关闭行为。

Windows ACL 沙箱在这些原语上增加 SID、DACL、grant、workspace 与公共 child policy。

<a id="header-verification"></a>

<a id="header-verification"></a>
## 头部验证

process、stdio 与 Job 的常量以及选定结构体的大小和偏移由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp) 对照 MinGW Windows 头文件检查：

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp && ./abi-probe.exe
```

Koffi 的 `STARTUPINFOW` 与 `PROCESS_INFORMATION` 定义还会在模块加载时断言各自的 64 位大小；其余已记录偏移和常量由该探针提供证据。

<a id="model-experience"></a>
## Model Experience

### 进程原语

#### 模型看到什么

没有直接内容。本包向 sandbox 提供 `Win32ProcessBindings` 与进程原语；sandbox 拥有全部模型可见工具、输出与诊断，本包不贡献提示词或工具 schema。

#### Token 影响

没有直接影响。消费方决定进程输出是否进入工具结果或后续模型请求。

#### KV Cache 影响

本包不贡献稳定请求前缀，因此不会使模型 KV Cache 失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅在 Windows 原生加载** — 导入通用类型可跨平台进行，但解析绑定表会加载 Windows DLL，并在其他宿主失败。跨平台测试注入绑定表，不加载原生 API。
- **没有公共进程服务** — 本包刻意不把原语包装成 Cordis 或 Node streams。消费方必须拥有自己的策略、异步调度、输出上限、取消与最终句柄关闭。
- **只继承环境** — 进程创建传入空环境块。sandbox 会先通过 `SetEnvironmentVariableW` 建立改动，因为经 Koffi 传入显式环境块会使 `CreateProcessAsUserW` 以 `ERROR_INVALID_PARAMETER` 失败。其他需要改写环境的调用方必须在调用原语前建立环境，或使用自己的 runner 进程。
- **只有 restricted-token 消费方** — ordinary `CreateProcessW`、精确 `applicationName`、parent-stdio release 与 whole-Job settlement 在 ordinary process 消费方出现前均不提供。
- **创建到分配之间的中断** — 目标以 suspended 状态启动，不能在 Job 分配前执行，但 runner 若在进程创建到分配之间的极窄区间被外力终止，可能留下 suspended target。本包不声明原子 Job 附加保证。
- **header 证据限定架构** — 已提交的 ABI probe 与布局常量覆盖仓库当前 64 位 Windows 目标。支持新的指针宽度或不兼容 Windows ABI 前，必须先更新 probe。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。操作只持有调用内的 native handle。
