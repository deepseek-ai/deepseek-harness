# Agent Note: 跨进程会话写租约

Status: implemented

[English](2026-08-31-cross-process-session-write-lease.md) | 中文

## Problem

JSONL 后端的写句柄认领只在单个后端实例内部排除第二个写入方。两个进程——两个 CLI 会话，或宿主与 SDK 运行时并存——可以对同一会话执行写打开，把追加交错写进同一个日志文件，撕坏压缩帧与 seq 连续性。该 seam 需要一份仲裁者位于所有写入进程之外的持久跨进程写所有权，因为没有任何写入方能活过所有故障模式。

## Decision

`SessionWriteLease`（packages/session/session-persistence-jsonl/src/lease.ts）在日志旁的 `session.lock` 上持有内核锁，贯穿写句柄的整个生命期：POSIX 经由固定版本的原生依赖 `fs-ext` 以非阻塞 `flock(2)` 加锁，Windows 持有由规范锁路径派生的命名内核信号量（计数 1，`CreateSemaphoreW`，实现在 src/win32.ts 既有 koffi 绑定旁）——零文件系统足迹的内核对象，随最后一个句柄关闭而销毁。竞争映射为 `SessionAlreadyOwnedError`；持有者的描述符或句柄关闭时内核释放锁，包括任何形式的进程死亡，因此崩溃的持有者从不阻塞后继者，也不存在任何过期簿记。活着但卡死的持有者保有锁直到其进程退出：剥夺停顿写入方的所有权被否决，因为其复活后的追加会撕坏日志；POSIX 上删除锁文件仍是该场景的显式放弃手段。由于 POSIX 锁指向 inode 而非路径，获取后会校验所锁 inode 仍是锁路径上的文件，否则重试。锁在写打开既有工件时立即获取，新建会话则仅在首次物化写入之前获取——未物化的会话不留任何文件系统足迹，已取得锁的句柄即使物化失败也保有锁直到关闭；释放从不删除锁文件，保住后续加锁者用于校验的稳定 inode。浏览器 worker 部署将 fs-ext 存根为立即成功：它是单进程部署，进程内写认领已排除所有写入方。

## Alternatives considered

**TTL 记录加续约与 rename 认领（最初实现，review 中被替换）** —— 日志旁的 JSON 记录携带 owner 令牌与过期时间，按间隔续约，过期后以原子 rename 接管。它在所有文件系统上都能活，但本质是一个微缩的分布式算法：续约定时器、丢失检测、带复核与归还的接管认领——而其残余的多方竞态仍允许有界的双写重叠（一个续约间隔）。内核仲裁删除了整族竞态及其全部机制，代价是一个原生构建依赖和上述卡死持有者语义。

**`proper-lockfile`** —— npm 生态对同一 TTL 模型的"过期判定加 touch"实现。它保留"先删后建"的接管竞态，用 mtime 加 inode 检测失主（弱于 owner 令牌），且自 2021 年起再无发布。

**fs-ext 自带的 Windows 实现（`LockFileEx` 字节区间锁）** —— 被 CI 实证否决：Windows 的字节区间锁是强制锁，任何读到被锁文件的进程都会硬失败（ripgrep 遍历会话目录时以 os error 33 崩掉）。

**Windows 共享模式独占打开（`CreateFileW` 拒绝 `FILE_SHARE_WRITE`）** —— 读者不受影响，但持有期间钉住锁文件的名字与目录：CI 显示数十个套件的临时根清理因仍打开的句柄阻塞递归删除而报 EBUSY，用户删除会话目录也会撞上同一堵墙。命名信号量保住内核仲裁，且文件系统足迹为零。

**POSIX 也手写 ffi（经 koffi 调 `flock(2)`）** —— 免去 node-gyp 安装期编译，但意味着自有两个平台的锁实现及其错误映射；`fs-ext` 交付了有维护、可固定版本的 POSIX 侧，Windows 侧复用 `win32.ts` 已自有的 koffi 绑定。

## Consequences

跨进程排他的代价是一个 node-gyp 编译的原生依赖（`fs-ext`，已在 `pnpm-workspace.yaml` 的 `allowBuilds` 列入允许）、每个物化会话一个由释放刻意留下的锁文件，以及卡死持有者规则：卡住的进程阻塞该会话的写入方直到其退出。它换来的是即时崩溃恢复（无等待期）、零续约流量，以及删除了 TTL 设计只能"管理"而非"消除"的全部接管竞态。咨询式 `flock` 在部分网络文件系统（NFSv3）上不可靠；位于此类挂载上的根目录会退化为仅进程内排他。POSIX 上删除活跃会话的锁文件按设计即放弃排他——harness 自身从不这样做；agent-loop 的 resume 测试刻意用它模拟卡死的第一个生命周期，并在 Windows 上跳过：那里的锁是任何文件操作都无法放弃的内核对象。
