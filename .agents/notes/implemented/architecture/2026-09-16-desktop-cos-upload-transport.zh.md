# Agent Note: 通过腾讯 COS SDK 上传 Desktop 发布产物

Status: implemented

[English](2026-09-16-desktop-cos-upload-transport.md) | 中文

## 问题

发布对象此前通过指向腾讯 COS 端点的 AWS S3 客户端上传。该客户端默认的校验和配置可以用 `Content-Encoding: aws-chunked` 发送流式请求尾帧；S3 在存储前会移除该标记，而兼容路径可能把它保留为对象元数据。一次面向用户的应用下载在收到响应头后立即以 HTTP/2 `RST_STREAM` 失败，而同一连接上的相邻下载正常完成；被报告带有该标记的对象分段下载失败。这两项观察都不能证明唯一原因，但上传传输是本仓库自己拥有的部分，而 CDN 提供任何源请求都未产生的元数据本身就是缺陷，值得在继续追查之前先消除。

## 决策

[desktop-cos.ts](../../../../apps/desktop/scripts/desktop-cos.ts)使用官方 `cos-nodejs-sdk-v5` 包构造每个 Desktop COS 客户端：HTTPS、不保持连接、不跟随重定向、不切换备用域名、不做时钟偏移校正，无活动超时为 900 秒。[upload-target.ts](../../../../apps/desktop/scripts/upload-target.ts)与[installed-update-cos.ts](../../../../apps/desktop/scripts/installed-update-cos.ts)都从该工厂获取客户端，`@aws-sdk/client-s3` 不再是 Desktop 依赖。

所有上传对象——安装包、blockmap 和 YAML 清单，包括很小的字符串清单——都以一次 `putObject` 发送，其请求体是流，并携带显式 `ContentLength` 与预先算好的 `Content-MD5`。正是流使写入不可重复：SDK 只在请求体没有 `pipe` 时才重发请求，因此流式 PUT 只会尝试一次，两个上传器自身也不再添加重试。当调用方未指定时，SDK 还会注入空的 `Cache-Control` 头；工厂会移除该头，因此发布上传器仍然把缓存策略留给部署基础设施。

qualification 传输保持原有 store 接口与命名空间检查不变。它通过 `getObject` 配合一个对已接收字节计算哈希的 `Writable` 输出读取对象，因此对象从不整体驻留内存；只有确认的 `NoSuchKey` 表示对象不存在，其他任何状态码，以及早于声明长度结束的传输，都会让操作失败。

## 测试

[cos-loopback.ts](../../../../apps/desktop/tests/cos-loopback.ts)把真实 SDK 实例 `before-send` 中的 URL 重定向到每个测试独立的 loopback 源，并记录实际收到的字节，因此测试观察的是传输的序列化结果，而不是它的 mock。[desktop-upload-run.spec.ts](../../../../apps/desktop/tests/desktop-upload-run.spec.ts)与[installed-update-cos.spec.ts](../../../../apps/desktop/tests/installed-update-cos.spec.ts)断言确切的请求体字节、`Content-Length`、`Content-MD5`、不存在传输编码与内容编码、已签名的 `x-cos-forbid-overwrite` 头、HTTP 500 与连接中断时每个对象只发一次请求、读取 404/403/截断的处理，以及保留记录不包含凭据与原始服务端消息。

[cos-operation.spec.ts](../../../../apps/desktop/tests/cos-operation.spec.ts)验证跨重试的总截止时间、持续返回数据的响应流、未确认 PUT 的取消，以及关闭请求不影响其他操作。测试组合虚拟截止时间计时器与真实 socket 和流观测。

## 考虑过的替代方案

**保留 S3 客户端并在两条路径上都设置 `requestChecksumCalculation: WHEN_REQUIRED`。** qualification 传输原本已使用该设置，它能抑制尾帧。但它仍然通过兼容层写入一个厂商已提供受支持客户端的产品，发布路径也会依赖于某项配置始终正确，而不是依赖编码根本不会产生。官方 SDK 消除的是这一层，而不是调整它。

**对小体积 YAML 清单改用 Buffer 请求体。** 对几百字节而言 Buffer 更省事，也不需要流处理。但它会重新启用 SDK 固定的四次重试，使一次结果不确定的清单写入可能静默重复一个可变对象。统一的流式 PUT 保持单一写入路径和单一保证。

**使用 SDK 的 `uploadFile` 队列或分块上传。** 这些路径可并行处理大对象并提供进度上报。它们也会把单个对象拆成多个分块，带来分块级重试与上传状态，扩大一个必须恰好写入一次的产物的重复面。发布上传器对每个对象只发一次请求。

**只替换发布上传器，qualification 传输继续使用 S3。** qualification 传输写入同一系列 bucket，若把它留下，兼容路径就会继续存在于最可能用于与生产行为对照的对象上。

## 结果

对象写入不可重复，这正是本次故障所需的性质，传输也不再依赖 S3 兼容行为。代价是每个对象只有一次请求：超大安装包不会并行，也没有进度上报，与它替换掉的单请求行为一致。qualification 版本查询的所有 SDK 尝试共享 30 秒总截止时间；对象读取与 PUT 的总截止时间为 15 分钟。每次操作独立拥有客户端与取消信号。[cos-operation.ts](../../../../apps/desktop/scripts/cos-operation.ts)通过 SDK 传输将信号传给底层 HTTP 请求，并在返回前等待请求的关闭事件，超时也不例外。持续返回数据不会延长截止时间，过期信号会阻止后续重试建立连接。发布上传器保留独立的无活动超时。

该 SDK 的依赖树源自已停止维护的 `request` 包，会引入较旧的 `http-signature`、`tough-cookie` 和 `form-data` 版本；lockfile 的供应链检查接受它，替代方案是自行实现 COS 请求签名。

已经带有该保留编码标记的既有对象及其缓存副本不受本次改动影响。删除或重新上传它们，以及任何 CDN 缓存刷新，仍是单独的操作动作；本记录不包含任何云端操作。

「结果不确定的写入必须保持为一次可检查的尝试」这一发布决策由[打包与更新决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责；本记录改变的是实现它的传输。
