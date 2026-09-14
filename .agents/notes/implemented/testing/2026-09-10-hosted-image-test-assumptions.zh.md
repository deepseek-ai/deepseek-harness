# Agent Note: coverage 套件里的托管镜像假设

Status: implemented

[English](2026-09-10-hosted-image-test-assumptions.md) | 中文

## 问题

[故障切换支路](../process/2026-09-09-blacksmith-failover-leg.zh.md)会把这套测试跑在本仓库不拥有的池上——Blacksmith 的临时镜像，以及自有的 `vm-backup` 与 `dsh-win-ci` 备用池。在托管镜像上，coverage 各通道的失败来自用例从未点明的宿主属性：宿主是否提供可用的用户级 systemd scope，决定了被 mock 的 PTY 退出会与哪种 containment 竞争；受管 scope 在 ACP 拆卸时报告信号失败；读端被抢占时会把非法 UTF-8 残余用例假定为独立分块的写入合并成一个分块；以及 Windows Server 镜像直接拒绝 `CoCreateInstance(CLSID_FileOpenDialog)`。

## 决策

这些用例明确声明各自依赖的宿主属性。

`packages/subprocess/subprocess-local/tests/local.spec.ts` 中模拟 PTY 退出的用例明确选择 fallback containment。不验证平台选择的用例使用 `internals = { platform: 'darwin' }`。终端释放生命周期用例不设置平台，并让 `probeLinuxNative` 返回 false，以验证宿主默认平台的选择，同时避免启动真实 Linux scope。两种安排都避免了模拟退出与 scope bootstrap 竞争。平台固定时再 mock 探针属于冗余，因为固定平台会绕过该探针。

`disposal contains a spawn-failure rejection that races teardown` 断言结算契约，而不是这场竞争的某一方获胜：已经发布其 pre-exec 失败的 bootstrap 以该失败 reject，先停住 bootstrap 的 teardown 则以被请求的 `SIGTERM` 结算。只有 Linux scope 会记录停止这一支，因为 win32 job owner 会把被取消的启动转成 rejection，fallback 启动器则因目录缺失而 reject。

`plugin-config dispose graces reach the real ACP run` 配置 5000ms 的 dispose 宽限。该用例的 mock 按设计既拒绝 stdin EOF 也拒绝 `SIGTERM`，因此用例会等满两个宽限（约 10s），并自带 30s 的用例预算，高于本地单测入口授予的 5000ms 默认值。采用这些宽限时仍会发生 scope 信号失败，增加宽限不能证明终止已完成。[直接进程停稳决策](../bug-fix/2026-09-12-linux-scope-direct-kill-settlement.zh.md) 规定了 fallback kill 成功或独立证明直接进程不存在后所需的进程事件与新取得的 scope 证据。

`packages/experimental/ptc-runtime-python/tests/runtime.spec.ts` 的两个非法 UTF-8 残余用例都用 `time.sleep(0.001)` 控制写入节奏：`os.sched_yield()` 会让被抢占的读端把多次写入合并成一个分块，而被包裹的 `Buffer.concat` 测量的正是该分块（在正确实现下，托管镜像测得 2563，超过了 2048 的界）。两个用例的载荷都保持在该界之上——`0xFF` 用例 3200 字节，CESU-8 用例 1100 个 `ED A0 80` 序列（3300 原始字节，超过按原始字节计费会触及的 3072 字节预算）——因此少计仍然会在 2048 之上触发 flush。两者各自带有 20s 的用例预算，容纳带节奏的写入与解释器启动。

`packages/experimental/ptc-runtime-python/tests/stray-fragments.spec.ts` 的原生输出分块封存测试保留真实 Python 子进程，但把 stdout 读取拆成单字节事件。操作系统的管道合并无法保证达到封存一块所需的 1024 个片段：run 34465259316 的全部断言通过，却未覆盖该分支。可控读取覆盖反复封存和末尾换行合并；精确输出与复制总量上限检测字节丢失和前缀反复复制。

Linux coverage 通道授予 `DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'`，与 Windows coverage 通道一致，因为当该通道的分区、worker 与同级门禁共用一个宿主时，`subprocess-local` 与 `bash-sandbox` 的处置用例会超过 5000ms 默认值。

Windows 文件夹对话框冒烟测试改为通过 PowerShell 探测 `CoCreateInstance(CLSID_FileOpenDialog)`，而不再按 `process.platform` 分流。回答 `CLASS_E_CLASSNOTAVAILABLE`（0x80040111）的镜像会跑干净的拒绝用例并跳过真实对话框用例，因此 `win32-dialog.ts` 在没有可开对话框的宿主上仍保有文件覆盖率。该激活过程抛出的任何异常都按拒绝解读，因此因其它原因探测失败的宿主只会失去真实对话框用例；完全无法运行的探测则保留 win32 假设。

## 备选方案

**把 coverage 通道排除出托管支路。** 否决：该支路的意义就是把同一套测试跑在另一个池上，而这些失败点出的是真实的宿主依赖，不是一个该池无法支撑的套件。

**只抬高通道的每用例预算。** 否决：更宽的预算改变不了那些成本或行为确定的用例——被 trap 的 ACP 子进程仍然会等满两个宽限，被合并的读端仍然会抬高测得的峰值。

**同时固定平台并 mock 探针。** 因冗余而否决：固定平台会在原生探针被调用前选择 fallback。验证宿主默认平台选择的测试则不设置平台，并控制探针结果。

**削减非法 UTF-8 的载荷以让用例更快。** 否决：低于 2048 的界之后，断言再也无法为它所点名的少计而失败，等于让该回归失去守护。

## 后果

钉死选择的 fixture 避免了非预期的 containment 选择：`linux-scope` 与 win32-job 两条路径仍由各自的专用用例覆盖，而不是经由这些用例抵达。ACP 处置用例每次运行约 10s 墙钟，每个残余用例约 3.5s，还需加上宿主调度与原生清理的额外开销。托管镜像证据：run 34449848541 在这些用例上失败，run 34457655892 在本改动加 90000ms 通道预算下转绿，`windows node 24 / coverage` 在连续五次托管运行中为绿，其中探针报告拒绝（`clsid-probe=refused`）。
