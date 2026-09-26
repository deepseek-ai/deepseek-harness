# Agent Note：job 注册表吸收观测 record；独立的 activity seam 被移除

Status: implemented

Superseded：下文描述的 record 声明（`JobStart.record`、`RecordingJob`、`readRecord`、`pumpJobOutput`）与拆分的线路（会话控制流上的 `SessionJob.record`、`ctx.jobOutput`）已收敛为一个输出环与 `ctx.jobs` 上的直接操作——见 [jobs seam 收敛](2026-09-03-jobs-seam-consolidation.zh.md)。把独立 activity seam 吸收进 `ctx.jobs` 的论证仍然成立。

[English](2026-09-01-jobs-absorb-activity-record.md) | 中文

## 问题

[activity 观测 seam](../feature/2026-08-24-activity-observation-seam.zh.md) 把实时输出流做成了 `ctx.jobs` 旁边的第二个注册表：生产者要把同一份工作登记两次（job 管生命周期，activity 管观测），手工保持两个终态一致（`observeBackgroundActivity` 要等 `proc.done` 才映射 outcome，防止 pump 失败把错误终态冻上去），通过 `ActivityCorrelation.jobId` 关联两行，并给每个观测调用包上注册表缺失的降级分支。Web 客户端维护两份名册（session-control 的 `jobs` 帧与 activity control 流）并逐行做 join。合并前实测：八个配对调用点；生产者人口为——后台 bash/pwsh（双注册表）、PTY 发送与 subagent 委托（仅 jobs）、前台 workflow（仅 activity）。

唯一没有 job 的 activity 是前台 workflow 镜像。拆分带来的其他一切——独立观察者、绝对偏移读取、有界保留——都是 record 的性质，不是注册表拆分的性质。

## 决策

`ctx.jobs` 拥有观测 record；`packages/activity/`、`packages/api/activity-controller` 与 correlation 词表被移除。

- **`JobStart.record?: true`** 声明可观测输出 record。`run(job)` 现在收到 job 的生产者面——`record: true` 的 start 收到 `RecordingJob { id, append(text, {channel?, gapBefore?}), updateDetail(detail) }`，其余收到普通的 `RunningJob { id, updateDetail(detail) }`——因此 id 在 starter 运行前签发（starter 抛出仍然不登记任何东西；序号被跳过）。starter 内暂存的写入在登记提交时可见。`updateDetail` 对所有 job 可用，让 `job_list` 也能看到实时进度行；未声明 record 的 `append` 记日志并丢弃。
- **没有 `end`。** job 结算——生产者 outcome、kill 或 teardown——是 record 唯一的关闭：裁剪到结算保留量并发出最后一个 `onOutput` 信号。双结算配对（`ActivityHandle.end` 与 teardown 强结的 first-wins 对账）被删除，而非重新实现。
- **`readRecord(id, from, caller)`** 是非消耗多读者视图（绝对 UTF-8 偏移，低于保留窗口为 `lossy`），围栏与其他 job 读取一致；永不置 `reported`。模型面的 `readOutput` 游标原样保留——两个投影服务不同读者，刻意保持分离。
- **`jobs-local`** 吸收块环（`retainBytes` 运行期 256 KiB，`settledRetainBytes` 结算后 16 KiB），`pumpJobOutput` 在 seam 旁替换 `pumpActivityOutput`。生产者把 pump 的末次排空折进 `hooks.done`，让 record 在结算关闭前握有最后的字节。
- **wire 按角色拆分。** `SessionJob.record`（恰在 record job 上存在）在会话控制流上标记行可观测；`api-job-controller` 的 `job` 命名空间上的 `job.follow({sessionId?, jobId, from?})` 流式发送 anchor/output/status 帧，围栏读取者由请求的 session 解析。`api-activity-controller` 删除；其名册流是冗余的（jobs 帧就是名册），observe 机制位于 `api-job-controller`（`observe.ts`，客户端 `ctx.jobOutput`），它在自己的 apply 里解析所依赖的 Remote 面。
- **`ui-activity` 改回上游名字 `ui-jobs`**，渲染单一名册：`jobsBySession` 行，恰在 `record` 存在时可展开。双名册 join 被删除。
- **前台 workflow 有意失去实时面板。** `tool-workflow` 的 activity 镜像被移除；前台 run 只通过已记录的 run/member 生命周期事件呈现，逐行的 `workflow/phase` / `workflow/log` 叙述在 workflow 获得 `run_in_background` 并登记 record job 之前没有观察者。jobs 保持纯后台注册表——没有 `foreground` 模式位、没有模型不可见行、没有无 run 行。

## 曾考虑的替代方案

- **`foreground: true` job 模式**以保留前台 workflow 面板：它需要两个耦合的执行点（出生即 reported 与 `job_list` 过滤），两者一旦分叉就会双投递或向模型泄漏行，而它换来的只是一个可被 `run_in_background` 替代的边缘特性。
- **用 record 服务模型读取**（删除 `readOutput`）：模型读取是生产者格式化的（截断与 spill 提示、sandbox 标记）且消耗型；record 是原始、带 channel 标签、非消耗的。统一二者要么把生产者特有格式化搬进注册表，要么把噪声混入观察者流。
- **保留拆分但共享实现**（公共注册表库）：它消除重复骨架，但保留真正的成本——双重登记、终态配对、correlation、第二条 wire 名册与第二个包族。

[先前 seam note](../feature/2026-08-24-activity-observation-seam.zh.md) 反对用持久会话事件或 control 流承载实时输出的论证仍然成立并原样沿用：record 是进程本地观测状态，从不是会话事件，「模型可见 ⟺ 已记录」不受影响。

## 评审修正

对已合并设计的评审确定了上文各节未言明的五点：

- **泵的等待资源恒定。** `pumpJobOutput` 对生产者的 `done` 只订阅一次，同一时刻只保留一个待触发的 timer；结算清掉 timer 并唤醒当前等待。此前每个轮询轮次都对同一个 pending promise 赛跑，每轮留下一个 reaction 直到任务结束——默认节奏下跑一天的任务会累积上百万个闭包。
- **客户端卸载等待载体静止。** `ctx.jobOutput` 的 effect disposer 是异步的，await 每条打开的 `RemoteStream.dispose()`：Cordis 会 await 异步 disposer，而一个在旧 iterator 仍在关闭时就宣告卸载完成的 fiber，在 HMR 下可能与下一个插件实例重叠。
- **名册标记 record，不计字节。** `SessionJob.record: true` 取代了 `outputTotal`：`append` 不提交名册变更（只有生命周期提交触发 `onJobsChanged`），镜像的计数在输出到达的瞬间就陈旧了；而为一个没有任何行需要的数字按 append 广播整份名册被否决。实时偏移随观测流的 `opened` 锚帧到达。
- **record 是尽力而为的实时预览。** 生产者按轮询轮次复制 stdout 与 stderr，同一窗口内的写入先 stdout 落地；pipe 捕获无法还原真实交错（只有 PTY 或 `2>&1` 可以），客户端拼接 chunk 时也不区分 `channel`。`channel` 留在 wire 上，因为它正是让这一限制可见、也是将来区分渲染 stderr 所需要的东西。
- **声明决定生产者面的类型。** `JobStart` 是按 `record` 判别的联合类型：`RecordingJobStart.run` 收到 `RecordingJob`，`PlainJobStart.run` 收到没有 `append` 的 `RunningJob`，注册表给普通 job 构造的面根本没有这个方法——注册表无处存放的输出成为不可表达，而不是警告后丢弃。
- **Web e2e 的保活是 barrier 而非时钟。** 后台命令守在测试拥有的、位于 job cwd 的文件上，由场景显式 kill，因此 CI 卡顿不可能先把任务结算掉；每个场景是一个测试，绝不是共享 job id 的测试链。

## 后果

每个可观测行都是可 kill 的 job；没有生命周期的纯观测面需要新的归属（harness 诊断属于 inspector 平面，不在这里）。未来的远端 job provider 必须同时实现生命周期与 record。record 的保留配置在 `jobs-local`；观测 wire 的节奏配置（`observeFlushMs`、`observeMaxFrameBytes`）在 `api-job-controller`。
