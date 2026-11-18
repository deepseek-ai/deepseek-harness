# Agent Note: 图片读取使用附件存储访问权限

Status: implemented

[English](2026-10-23-store-scoped-image-reads.md) | 中文

## Problem

历史图片加载会为每个未缓存的附件读取请求中的 Session，并搜索其事件内容。搜索用于确认 Session 引用了图片；它不负责定位字节，存储路径已经能由内容寻址 ID 推导。每次读图因此增加了与历史长度成正比的工作。用户反馈的加载延迟还涉及上传；这项发现本身不能确定全部延迟的来源。

## Decision

Session 关联不构成图片访问限制。连接身份认证和 Gateway 权限检查允许调用 `session/attachment` 后，任何调用者都可以通过完整的 `ImageAttachmentRef` 读取同一附件存储中的任意图片，包括仅被其他 Session 引用或未被任何 Session 引用的对象。请求保留 `sessionId`，供现有 Session 资源权限检查使用。该检查通过后，处理函数不要求该 Session 存在，也不会仅因其不存在而返回 `session/not-found`。所有身份使用相同的读图路径。

Client 已经持有消息中的完整图片引用，将其作为 `attachment` 与 `sessionId` 一起发送。Session Controller 直接调用已有的 `AttachmentStore.readImage(ref)`。本地提供方校验规范 ID，在自己的对象目录内推导路径，校验 SHA-256，并把实际格式、字节数、宽度和高度与传入引用比对。对象缺失、不可读、损坏或与引用不符时，操作失败。取得引用无需查询 Session 历史。

响应保留传入引用。可选的 `name` 和 `originalDimensions` 是调用方提交的显示信息，不根据存储对象校验。Client 现有的历史图片缓存继续按 Session 管理结果和对象 URL；Host 不增加图片字节缓存。

该规则缩小了 [Session observation](2026-08-25-session-observations-and-projection-owned-client-state.zh.md) 与[历史传输激活策略](2026-08-18-session-history-and-event-transport.zh.md)涵盖的读取范围。[工作区文件读取](2026-09-05-workspace-files-service.zh.md)保留自己的文件系统授权。

## Alternatives considered

**保留 Session 到图片的 Map 或 projection。** 索引可以消除重复扫描，但保留了产品不需要的访问限制，并增加派生、生命周期和失效处理。

**签发图片签名票据。** 票据为同一项不需要的 Session 关联限制增加签发和验证状态。

**只优化 owner 的读取。** 这会让不同身份使用不同的图片访问规则，并让获准调用的非 owner 继续承担扫描成本，没有相应产品需求。

## Consequences

调用方知道有效图片引用，且有权为请求中的 Session 资源调用该接口，就可以跨 Session 读取对象。本地 ID 是规范化字节的 SHA-256。对于准入时原样保留的已知 PNG、JPEG 或 WebP 字节，调用方可以计算 ID，取得格式、字节数和尺寸，并通过获准的读取请求探测对象是否存在。这些必需的引用字段不一定来自 Session 日志。

图片隔离需要独立 Host 实例及各自的 `DSH_HOME` 目录。随附组合在每个 Host 中使用一个附件存储，不会按 Session 选择存储。身份认证、Gateway 操作与资源检查、固定存储路径、摘要校验和明确失败仍是必需的。

图片读取不再依赖历史长度或 Session 物化。文件读取、完整性校验、编码和传输仍有耗时；本次改动不说明上传或模型推理延迟已得到改善。已有 Session 数据和 fork 引用无需迁移。

## Verification

附件读取不得查询或遍历 Session 历史。验证必须区分获准的跨 Session 图片读取与被 Gateway 拒绝的调用，并覆盖正常引用、无效 ID、固有元数据不符、可选显示字段原样保留、缺失和损坏的对象、旧历史页以及 fork 继承图片。性能证据必须区分历史扫描、存储操作和传输，不能把用户反馈的全部延迟归因于扫描。

诊断脚本是 [`image-read.perf.ts`](../../../../packages/api/session-controller/tests/image-read.perf.ts)，通过配套的 [tsdown 配置](../../../../packages/api/session-controller/tests/image-read.perf.config.ts)编译。基线 worker 使用改动前的控制器与 `{ sessionId, attachmentId: ref.attachmentId }`；候选 worker 使用当前控制器与 `{ sessionId, attachment: ref }`。两者使用相同图片 fixture、工作量和输出校验，并通过同一套已构建的 Local store 执行 `readImage(ref)` 校验。在候选检出目录的根目录编译并运行：

```sh
pnpm exec tsdown --config-loader native --config packages/api/session-controller/tests/image-read.perf.config.ts
(cd packages/api/session-controller && node --expose-gc .dsh-build/image-read/image-read.perf.js --expect-no-history)
```

运行单独编译的基线 worker 时不带 `--expect-no-history`；诊断请求必须匹配基线控制器仅接收 ID 的请求字段。基线负对照加上 `--sample typical --expect-no-history`，该实现会查询和遍历历史，因此负对照必须失败。父进程为每种工作量运行五个新子进程，每个子进程使用已加载的 Session，并对每张图片执行第一次未缓存读取。图片是确定性合成的 1024 × 768 PNG；两种工作量分别为 120 轮、960 个事件、8 张图片，以及 2,000 轮、16,000 个事件、32 张图片。fixture 写入可能已经预热操作系统的文件缓存。

`controllerMs` 覆盖从直接调用控制器到返回 base64 的时间。`storeMs` 包含文件 I/O、SHA-256 和文件头校验；`snapshotMs` 单独测量取得历史快照的时间。`scanAndDispatchMs` 是进入存储前的时间减去 `snapshotMs`，因此也包含分派开销，不是独立的扫描计时。JSON 序列化和本机回环 HTTP 传输使用保留的响应单独测量。`requestJsonBytes` 与 `idOnlyRequestJsonBytes` 比较序列化后的请求长度，不测量请求传输时间。冷 Session 恢复、Gateway 处理、浏览器渲染、远端网络延迟、上传和模型推理均不在测量范围内。PR #7021 记录 worker 修订，以及在这些限制下测得的修改前后结果。

内存端点在 fixture 准备完成后，以及所有图片响应完成后执行 GC。第二个端点仍保留 Session、已准入的图片引用和每个 base64 响应。这两个保留内存端点包含准备阶段拥有的对象，峰值 RSS 则从进程启动累计，包含 fixture 生成。它们不单独测量图片请求内存，也不规定保留内存预算。
