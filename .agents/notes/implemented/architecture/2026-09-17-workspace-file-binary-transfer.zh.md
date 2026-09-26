# Agent Note: 工作区文件二进制传输

Status: implemented

[English](2026-09-17-workspace-file-binary-transfer.md) | 中文

## 问题

文档预览需要原生字节。将文件内容编码为 base64 会在压缩前使载荷增加约三分之一，并要求浏览器解码。独立的文件 Fetch 路由还会重复 Gateway 的方法分发、Session 查找和错误处理。

## 决策

[Remote 方法架构](2026-08-02-typert-remote-method-calls.zh.md)负责方法分发与生命周期；本记录规定二进制成功响应的编码及 Client 校验。[工作区文件服务](2026-09-05-workspace-files-service.zh.md)提供单一的二进制 `readBytes` Remote。其必填选项对象独立选择字节 `range` 和用于相对目标解析的 `baseFile`。未传 `range` 时读取完整文件。这避免为正交的选择设置不同方法名，同时保留有界的 `fs.readBytes` 和 `fs.readByteRange` 读取。

Typert 递归识别一元结果类型中的 `Uint8Array`，包括根值、可选字段和容器。生成的结果 codec 提供 `encode()` 处理类型可能包含字节的子树，并通过 `decode()` 校验还原后的值，不逐字节遍历、复制或冻结字节载荷；Client 声明将每个字节缓冲区限定为 `ArrayBuffer`。Gateway 执行生成的 encoder，保持 strict JSON 值不变，并为源码模式调用执行运行时字节识别；随后向 Connection 返回 JSON 兼容元数据及相对于结果的字节附件。Connection 负责标准 `FormData` 部分，并在 JSON 元数据中保留 RPC 信封和关联 id；它不检查业务值，也不依赖 Typert 反射。附件表将字节部分与 JSON 结果中的路径关联，字段名仍由业务拥有。Client 恢复基于 `Blob.arrayBuffer()` 的 `Uint8Array` 视图，Gateway 将校验交给生成的解码器。普通结果与错误继续使用 JSON 响应。Gateway 负责方法分发、Session 查找、取消、结果投影及挂载生命周期；功能代码无需 multipart 读取器或专用路由。

## 考虑过的替代方案

- 分立的 `readAll`、范围和关联文件方法混合了路径与读取范围两个独立选择。单一选项对象支持组合，无需再增加方法。
- 工作区专用 Fetch 路由让二进制传输独立于 Remote，但需要功能专属的方法分发、Session 查找与错误解码。
- 整体结果的二进制标记或保留的 `data` 字段会将传输与某一种业务结果耦合。按类型生成的 codec 和附件路径支持独立命名及嵌套字段，无需新增整体结果分类。
- 自定义元数据前缀需要自有的帧格式与长度校验。FormData 将这些机制交给平台，代价是 Blob 复制。
- 元数据 HTTP 头会限制较长的 Unicode 路径。Multipart 字段将路径保留在正文中；HTML 仍置于隔离的 Blob iframe，不作为可导航的 Host 响应。

## 影响

字节范围仅保留 `maxBytes` 内的请求字节，不受 `maxFileBytes` 约束。完整读取保留有上限的整个文件；这不是流式预览或零复制优化。HTTP 连接断开后，桥接器中止请求信号，并排空已准备的响应块，不再写入 socket：取消 Node multipart 响应体可能与其生产方竞争，导致未处理的 `ERR_INVALID_STATE` 拒绝。Office 授权探测使用同一 Remote 的单字节范围；转换后的 PDF 仍通过独立的 Office Remote 传输 base64，并使用其有界解码器。插件调用方迁移到 `readBytes` 选项，并停止将其 data 按 base64 解码。仍不支持二进制参数、事件和流条目；递归类型要求运行时值无环。不改变 Session 事件或持久化格式。

## 验证

Workspace 测试覆盖完整与分段读取、基准文件解析组合、上限、Session 查找、取消以及二进制 RPC 往返。Connection 和 Gateway 测试覆盖嵌套及多附件、帧格式、关联关系、畸形 multipart，以及取消或撤销的调用；Typert 测试覆盖递归结果 codec、Client 声明，以及对二进制输入和流的拒绝。构建后的浏览器场景验证原始 PNG 字节以及 HTML、PDF、图片和文本预览。本机 benchmark 使用相同合成文件比较完整与分段读取，并区分传输/解码和完整读取路径。
