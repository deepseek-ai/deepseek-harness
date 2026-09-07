# Agent Note: Windows sandbox process primitives 只有一个低层 owner

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-shared-win32-process-primitives.md) | 中文

## Problem

Windows ACL sandbox 拥有 restricted token、SID、DACL、grant 与 workspace policy，但其进程启动路径还同时承载通用 Koffi ABI、命令行引用、匿名管道、继承 stdio、Job 设置、wait 与 HANDLE 清理。第二个 Windows process consumer 否则只能依赖 sandbox policy 或复制 native resource 逻辑，而 allocation 与失败清理修复也必须在多份实现间保持同步。

## Decision

`@deepseek-ai/dsh-win32-process` 拥有 `sandbox-windows-acl` 当前消费的可复用 Win32 process ABI 与 native resource 操作。该包惰性加载 `kernel32.dll` 和 `advapi32.dll`，核验 x64 `STARTUPINFOW` 与 `PROCESS_INFORMATION` 布局，为 `CreateProcessAsUserW` 引用 argv，并提供带检查的 restricted-token pipe 与 inherited-stdio Job 操作。

Windows ACL sandbox 继续唯一拥有 restricted-token 创建、SID 与 DACL policy、grants、可写路径裁定、临时目录 policy 和公共 sandbox child result。它通过共享 binding context 扩展 policy-specific API，提供 primary token，组合 pipe drain 与 wait，并在自己的生命周期边界关闭调用方拥有的 Job。

每项 native allocation 与 HANDLE 在各个 shared operation 内只有一个 owner。process operation 会释放 Koffi out-parameter，并在受控失败前关闭它已经取得的每个 pipe、thread、process 或 Job handle。pipe 创建成功时，把 process 与 stdout/stderr read handles 返回给 sandbox。inherited-stdio 创建以 suspended 状态启动目标，把它分配给 kill-on-close Job，并只在分配后恢复，因此目标代码不会在 Job 外运行。分配失败会先终止 suspended target 再释放句柄；恢复失败会关闭已经分配的 Job。sandbox 保留既有 pipe-drain、direct-wait、result 与返回 Job 的生命周期。

该包只导出 sandbox 生产路径已使用的操作。ordinary `CreateProcessW`、精确 `applicationName`、parent-stdio release 与 whole-Job settlement 在 ordinary process consumer 出现前保持缺席。该包是 library，不是 Cordis service 或公共 Windows SDK。

## Verification

shared suite 覆盖 x64 ABI 值、命令行引用、binding extension、pipe EOF 与 drain allocation 复用、restricted-token process 创建、suspended 创建后的 Job 分配与恢复、wait 与 exit-code 读取、native allocation 释放，以及已取得资源的失败路径。sandbox 测试保留 restricted-token、fail-closed、pipe/inherit、result 与 disposal 组合行为，不重复低层矩阵。已提交的 header probe 与 Windows package 测试覆盖迁移后的 ABI 和 native 路径；Wine 提供模拟 Windows package 与组合信号。

## Alternatives considered

**把 process primitives 留在 sandbox package。** 拒绝，因为 process consumer 将被迫继承 ACL/token policy，或复制 native ABI 与清理路径。

**为每个 consumer 复制 Koffi 实现。** 拒绝，因为 struct layout、错误捕获与局部失败清理会出现多个 owner。

**在当前 consumer 出现前发布 ordinary-runner operations。** 拒绝，因为未使用的 `CreateProcessW`、application-name、parent-stdio 与 Job-settlement API 会冻结推测性义务，并扩大失败矩阵。

## Consequences

sandbox 保持公共行为，而通用 Win32 resource ownership 只有一个 package 与一个测试归属。该 package boundary 增加一个 workspace dependency 和发布 library；调用方必须显式拥有 policy、调度、result 组合与返回 HANDLE 的关闭责任。suspended 创建保证目标代码只在 Job 分配后启动，但不会让 runner 的 create-to-assignment 区间对外部终止具备原子性。后续 process consumer 只在其生产路径存在时扩展低层 package。
