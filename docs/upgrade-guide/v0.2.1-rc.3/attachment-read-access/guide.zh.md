---
kind: upgrade-guide
description: "图片读取请求必须携带完整附件引用，并且不再检查 Session 关联。"
---

# 图片读取请求需携带完整附件引用

[English](guide.md) | 中文

## 变更

在 0.2.1-rc.3 中，`session/attachment` 接收 `{ sessionId, attachmentId }`，并在请求中的 Session 历史里查找完整图片引用。现在，请求必须使用 `{ sessionId, attachment: ref }`，其中 `ref` 是包含 `attachmentId`、`mediaType`、`bytes`、`width` 和 `height` 的 `ImageAttachmentRef`。Client 的 `session.readAttachment()` 也改为接收完整引用，不再只接收 ID。

Host 把该引用交给已有的 `AttachmentStore.readImage(ref)`，将 ID、实际格式、字节数、宽度和高度与存储对象校验。响应仍为 `{ attachment, data }`，`data` 包含 base64 字节。响应保留传入引用，包括可选的 `name` 和 `originalDimensions`；这两个字段是调用方提交的显示信息，不根据文件校验。对象缺失、损坏或与引用不符时会明确失败。

连接身份认证和 Gateway 权限检查仍然适用。任何有权为请求中的 `sessionId` 调用该接口的身份，都可以读取同一存储中的图片，包括仅被其他 Session 引用或未被任何 Session 引用的图片。处理函数不检查图片关联或 Session 是否存在，授权通过后不再因 Session 不存在而返回 `session/not-found`。

## 迁移

1. 把 wire 调用从 `{ sessionId, attachmentId: ref.attachmentId }` 改为 `{ sessionId, attachment: ref }`，使用消息图片块中的完整引用。把 Client 调用从 `session.readAttachment(ref.attachmentId)` 改为 `session.readAttachment(ref)`。
2. 把返回的 `name` 和 `originalDimensions` 视为调用方的显示信息。只有 ID、媒体类型、字节数、宽度和高度会与存储对象校验。
3. 如果部署依赖 Session 关联来隔离图片，请在升级前改用独立 Host 实例及各自的 `DSH_HOME` 目录。随附组合不会在一个 Host 内按 Session 选择独立存储。Gateway 权限约束接口调用，不约束图片的 Session 关联。
4. 确认获准调用的请求可以凭完整引用读取其 Session 中没有记录的图片，即使该 Session 不存在也可以读取。Gateway 拒绝的请求、缺失图片和固有元数据不符的引用必须失败。已有 Session 日志和存储图片无需迁移。
