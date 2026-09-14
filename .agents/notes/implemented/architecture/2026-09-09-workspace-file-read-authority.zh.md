# Agent Note: 工作区文件读取权限

Status: implemented

[English](2026-09-09-workspace-file-read-authority.md) | 中文

## Problem

Workspace Files 同时提供文件内容与工作区导航。对所有操作应用工作区包含限制，会在 Session 文件系统后端之上形成第二套读取策略，并阻止用户预览同一 Session 在工作区外可读的路径。HTML 预览还需要直接读取相对 JavaScript 与样式表文件，包括含 `..` 的路径，而启用脚本的文档可以使用浏览器网络。

## Decision

`read`、`readBytes`、`readAll`、`readRelated` 与 `stat` 继承被寻址 Session 的文件系统后端读取权限。工作区根是输入相对路径的基准，而不是读取边界；只要后端允许，就可以读取绝对路径和离开工作区的相对路径。服务仍要求普通文件、拒绝符号链接，并应用文本和字节上限。

`list` 与 `changes` 仍限于工作区，因为它们暴露工作区导航和观察，而不是读取一个具名文件。`list` 拒绝根外目录，`changes` 通过后端的工作区包含判定过滤观察。

`readRelated` 从基准文件所在目录解析相对路径。因此，只要 Session 后端允许，`..` 路径就可以读取工作区外的 JavaScript 或 CSS。Document Preview 把有界、静态声明的本地脚本与样式表打包进带 `sandbox="allow-scripts"` 的 HTML Blob iframe；不透明源阻止访问父应用，但浏览器保留正常网络访问。这种暴露是为渲染静态生成 HTML 而有意接受的安全取舍。

[Workspace Files 服务](2026-09-05-workspace-files-service.zh.md)负责分页、文件检查、列举和观察。[Document Preview](2026-09-08-document-preview-operations.zh.md)负责选择要打包的关联文件及 iframe sandbox。

## Alternatives considered

**把所有操作限制在工作区内。** 这会让预览采用比 Session 文件系统后端更窄的策略，阻止读取明确寻址的可读文件，并使位于外部资源旁的 HTML 无法渲染。操作本身代表工作区时，仍保留工作区包含限制。

**允许根外读取，但阻断 iframe 的全部网络。** 更严格的 CSP 可以降低数据外传风险，但也会拒绝静态 HTML 预览有意保留的外部资源与网络行为。不透明 sandbox 保护父应用，但不承诺网络隔离。

## Consequences

持有有效 Session 文件地址的调用方可以接收 Session 文件系统后端允许读取的每个普通文件的字节，包括工作区外文件。预览的 HTML 文档可以执行已打包的本地 JavaScript，并发起网络请求。工作区外文件不会产生 `changes` 帧，因此其预览需要显式刷新才能观察更新。
