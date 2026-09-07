# Agent Note: 门禁运行器快速失败

Status: implemented
Archived: 2026-09-04

[English](2026-08-27-gate-runner-fail-fast.md) | 中文

[并行推送前门禁](2026-07-06-parallel-pre-push-gates.zh.md)拥有 `scripts/run-gates.ts` 中有界的门禁调度器；本笔记为该调度器新增一个调度选项。

## 问题

`scripts/run-gates.ts` 中的门禁调度器会把一个聚合流程里的每个独立门禁都跑完，然后报告 `run-gates: N passed, M failed`。某个门禁失败并不会停止其余门禁；只有 `needs` 依赖失败的门禁会被跳过。当聚合流程已经确定失败时，剩余门禁仍在消耗运行器时间，产出的证据也无法改变结论。最大的单项成本是 `ci-coverage` 聚合流程里的插桩覆盖率运行，实测约 27 分钟；在 `ci-consumers` 中，Node 兼容性冒烟检查与构建相互独立，因此它会在构建失败、结论已定的情况下继续运行。

GitHub Actions 不提供原生的跨作业取消：`fail-fast` 只作用于矩阵内部，而 `all checks passed` 聚合流程要等所有必需作业结束后才落定，因此它无法提前取消兄弟作业。仓库内唯一可用的杠杆就是门禁调度器本身。

## 决策

`run-gates.ts` 接受一个快速失败调度选项。启用后，首个阻塞性门禁失败（`allowFailure` 不为 true 的门禁）即中止整个聚合流程：共享的 `AbortSignal` 终止每个运行中门禁的整个进程树，所有尚未运行的门禁记录为 `skipped`，错误信息为 `aborted by fail-fast: <label> failed`（当宿主信号中止运行时为 `aborted by fail-fast: host interruption`）。退出状态保持为 1——即使被终止的子进程捕获信号并以 0 退出，这类结果也带有中止标记、记为 `skipped`，绝不记为通过。在中止生效前已结算的门禁保留其真实结果，因此汇总行仍如实反映哪些门禁产出了证据。

终止覆盖整棵进程树，而不只是直接的 pnpm 包装进程：POSIX 向分离子进程所在的进程组发信号（`kill(-pid, SIGTERM)`，5 秒后无条件升级为 `SIGKILL`），并额外按进程表逐个信号所有传递性后代——嵌套 run-gates（`ci-consumers` 里的 `check:node-compat` 与 `check:ci:lint:contracts-ready` 门禁）分离出去的叶子进程因此不依赖内层调度器自己的升级也能被杀掉。后代列表在 spawn 时预填、随后在子进程运行期间每 5 秒刷新（枚举是异步的——慢的 WMI/CIM 调用以自身 10 秒超时封顶，绝不会阻塞门禁的输出排空或退出处理；门禁结算时仍在途的枚举会被取消，而不是留着持有 stdio 句柄；子进程退出后才结算的快照仍会被合并，因为子进程可能已消失而孙进程仍持有 `close` 未触发——这正是中止需要该列表的时刻），每个采样 tick 把新枚举结果并入存活过滤后的缓存，被已退出中间进程 reparent 的后代因此跨 tick 仍被跟踪；中止时把新枚举结果并入同一列表，随后在升级时再次信号：组杀会重收直接子进程并 reparent 其分离后代，之后按父 id 不可达，因此结算要等进程组与已捕获后代都消失。仅在中止路径上，有界 pipe-drain 定时器会在中止后 10 秒强制关闭 stdio 流，因此持有写端的后代进程（包括不可中断 I/O）无法让 `close` 一直挂到作业超时；普通运行保持等待，而不是在有存活泄漏时报告通过。Windows 立即运行 `taskkill /PID <pid> /T /F`，因为不带 `/F` 的 taskkill 无法终止控制台进程，而门禁命令正是控制台进程；与 POSIX 相同的进程表枚举在 Windows 上也提供后代列表，每个捕获的后代同样被 taskkill——因为以已退出 pid 为根执行 `taskkill /T` 找不到任何东西，而 Windows 从不 reparent，已退出根的子孙仍以它为父、通过进程表可达；与 POSIX 相同的采样节奏让缓存跨过已消失中间进程的进程表记录（枚举以 10 秒 PowerShell 超时封顶，挂起的 WMI/CIM 调用不会拖住中止路径）。没有这一步，Windows 上不存在信号转发，只杀包装进程会在共享自托管池上留下孤儿脚本树。只有在启用快速失败时，子进程才会分离到自己的 POSIX 进程组；普通运行保持子进程在宿主进程组内，终端 Ctrl+C 仍能送达它们。快速失败运行上的宿主 `SIGINT`/`SIGTERM` 会转发到中止路径，因此被中断或被运行器取消的运行会排干并杀死自己的门禁进程树，而不是留下孤儿。

该选项通过 `DSH_GATE_FAIL_FAST` 开启（可接受值：`1` 或未设置；其它值通过既有的 `flagEnabled` 契约响亮失败），作用于 `ci.yml` 中所有由 run-gates 驱动的聚合作业：三个阻塞性 Linux 作业（`node-24` 静态、`node-24-coverage`、`node-24-consumers`）、Node 兼容性矩阵（`node-compat`）以及两个驱动聚合流程的原生 Windows 车道（`windows-build`、`windows-coverage`）。`scripts/ci-workflow.spec.ts` 固定了这些作业上的该标志，并固定 `windows-observational` 上不存在该标志，移除它会令 CI 门禁失败。

`windows-observational` 车道保持完整执行：它按设计是 `continue-on-error`，存在的意义是每次运行尽量收集 Windows 原生证据，因此首个失败不应截断其余部分。`windows` Wine 车道和 `windows-native-tests` 运行的是单个脚本或 Vitest 命令，不是 run-gates 聚合流程，因此调度选项不适用于它们。master 串行备用车道（`serial-linux-selfhosted`、`serial-windows`）和手动运行器基准测试不设置该标志：它们是完整性演练，必须执行完整聚合流程以证明池的可用性。

## 结果

红色拉取请求运行会更早结束。最大节省在 `ci-coverage`：失败的豁免重型门禁会中止多分钟的插桩覆盖率门禁，而不是让它跑完。

代价在诊断侧：一次推送只返回第一条阻塞性失败，而不是完整失败集，因此解决多个独立失败可能需要更多次推送-修复往返。被终止的门禁记录为带快速失败错误的 `skipped`，因此 `N passed, M failed, K skipped` 汇总行仍然如实反映哪些门禁产出了证据、哪些没有。忽略 `SIGTERM` 的门禁会在 5 秒宽限期后被强制终止。同时扛过两种信号仍存活的进程树，只有在直接子进程的 stdio 保持打开时才会拖住聚合流程；一旦 `close` 触发，进程组存活轮询在 8 秒后放弃，运行以响亮的 `gate tree not quiescent` 警告结算，而不是报告一棵干净的树。

## 备选方案

**跨作业取消看门狗。** 一个轮询兄弟作业结论并调用运行取消 API 的作业可以在首个失败时停止所有车道。它不是原生能力，会增加轮询依赖和令牌暴露面，并丢弃其它作业已并行产出的证据。已拒绝；调度器层面的快速失败与作业拓扑正交，不带来上述任何负担。

**把三个 Linux 作业合并成一个检查。** 单个作业可以原生快速失败，但会失去独立的运行器分配——其排队延迟重叠的收益记录在[独立 CI 消费方构建](2026-07-30-independent-ci-consumer-build.zh.md)笔记中——并且会让覆盖率长尾成为整个作业的尾部。已拒绝；快速失败在既有作业拆分内生效即可。

**只向直接子进程发信号。** 第一版实现向 pnpm 包装进程发送 `SIGTERM`，依赖 pnpm 把它转发给脚本子进程。探针确认了 POSIX 上的转发。已拒绝：Windows 没有信号转发，只杀包装进程会在共享自托管池上留下孤儿脚本树；上述整树终止覆盖两个平台。
