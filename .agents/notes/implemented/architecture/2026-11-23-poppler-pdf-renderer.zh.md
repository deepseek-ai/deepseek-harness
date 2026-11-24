# Agent Note: 用 Poppler 渲染 PDF，按文件类型排序选择渲染后端

Status: implemented

[English](2026-11-23-poppler-pdf-renderer.md) | 中文

## 问题

`document_render` 过去在 Office 套件的 LibreOffice 转换器中栅格化所有输入，包括 PDF。该转换器是常驻进程，单个实例约占 600 到 900 MiB。在内存上限 2 GiB 的 Linux x64 容器中渲染 280 多页的扫描 PDF 会内存耗尽。栅格化 PDF 并不需要 Office 引擎，而 Host 上常常已经装有 Poppler 的 `pdftoppm` 和 `pdfinfo`。

## 决策

[Office 套件](../../../../packages/document/office-kit/README.zh.md)有两个图片渲染后端：`libreoffice` 和 `poppler`。`OfficeImagesRequest.renderer` 指定只使用其中一个；`poppler` 只接受 PDF，指定的后端不可用时以 `unavailable` 失败。未指定 `renderer` 时，提供方按 `renderers` 配置中该输入类型的顺序取第一个可用后端，默认为 `office: [libreoffice]` 和 `pdf: [poppler, libreoffice]`，最后一项不预先检查，直接使用。只有「不可用」才会换下一项。Kit 能导入时 LibreOffice 可用；`subprocess` 服务存在且能找到两个已配置的可执行文件时 Poppler 可用。后端在队列准入前确定并写入 operation，因此结果注明所用后端，缓存的渲染结果不会跨后端复用。

Poppler 通过 `ctx.subprocess` 以 argv 启动短生命周期子进程，不占用 LibreOffice 转换器槽位，但共用队列的准入、并发和源字节预留。提供方与进程之间不传递文件：每个进程从 stdin 读取 PDF（写入时处理背压），`pdftoppm` 把 PNG 图片首尾相接写到 stdout。因此 subprocess 提供方在哪个执行环境中运行进程（包括 SSH 主机），Poppler 路径都能工作，也不需要文件系统提供方。每个进程的工作目录是解析出的可执行文件所在目录，该目录在那个执行环境中一定存在。一个 `pdfinfo` 报告页数，取其最后一行 `Pages:`，因为标题等文档属性先输出，其中可能包含伪造的行。页数超过 `maxImages` 或页码超出文档的选择，提供方在渲染前以 LibreOffice 路径的错误码拒绝。`pdftoppm -cropbox` 对每段连续页码各渲染一次；提供方在数据到达时按 PNG chunk 边界切分其 stdout，字节数超过剩余预算时终止它，并要求每页恰好一张图片。页面像素与尺寸只在渲染后按每张图片的 PNG 头检查，超过 `maxPixels` 或 `maxDimension` 的图片以 `output-too-large` 失败。一个 `timeoutMs` 期限覆盖一次渲染的全部进程；取消、超过期限和提供方卸载都会终止正在运行的进程，每次调用都等进程退出后才结束。

[`document_render`](../../../../packages/document/tool-document/README.zh.md) 向模型提供 `renderer` 参数，对非 PDF 输入在读取前拒绝 `poppler`，并在结果文本中注明所用后端。显式请求的 `poppler` 不可用时，提示模型省略 `renderer` 或改用 `libreoffice`。

## 考虑过的替代方案

**只保留 LibreOffice 一个渲染后端。** 提高容器上限或降低并发都改变不了常驻引擎的占用；而且 LibreOffice 把 PDF 导入为绘图文档，会花掉栅格化本不需要的内存。

**让模型自己在 shell 里运行 `pdftoppm`。** 模型需要自己找可执行文件、管理临时 PNG 文件并读回，渲染能否成功还取决于各部署的沙箱和审批。由工具渲染，所有后端都受同样的图片上限和附件流程约束。

**把选项命名为 `builtin` 和 `system`。** 这两个名字描述的是打包方式而不是栅格化程序；一旦 Poppler 随应用分发，或在系统中找到 LibreOffice，含义就会混淆，也无法让模型预期输出。引擎名在各部署中始终准确。

**运行失败后自动退回下一个后端。** Poppler 处理损坏或加密的 PDF 失败时，会悄悄在本次改动要避开的高内存引擎中重跑请求，使期限翻倍，并掩盖结果或错误来自哪个后端。只有在准入前检测到的「不可用」才会换后端。

**渲染前用 `pdfinfo` 检查页面尺寸。** `pdfinfo -box` 能报告每页的裁剪框和旋转，从而在栅格化之前拒绝超限页面。但 Poppler 每次调用只接受一个连续页码范围、逐页渲染，预检需要多启动一个进程并再传一次整份 PDF，稀疏的选择还要列出首尾页之间的每一页。渲染后按 PNG 头检查已经能以 `pdftoppm` 实际产出的尺寸执行上限；代价是超限页面会先被渲染再被拒绝，占用一段瞬时内存。

**通过 Host 临时目录交换文件，子进程执行环境读不到 Host 文件时视 Poppler 为不可用。** 写入 `source.pdf`、读取 `page-N.png` 需要与进程共享文件系统。已挂载文件系统提供方的 Host 路径映射能识别 SSH 组合，但那样 PDF 渲染会在 SSH 组合下悄悄退回 LibreOffice，结果取决于文件系统提供方和 subprocess 提供方恰好怎样搭配。改用管道后，Poppler 路径与执行环境无关，也不再需要临时目录和文件名解析。

**只在文档中写明 Poppler 需要 Host 上的 subprocess 提供方。** 在 SSH 组合中，提供方仍会用远端进程打不开的 Host 路径启动 Poppler，每次渲染都会以 `invalid-document` 失败，而不是正常工作或被跳过。

## 后果

在装有 Poppler 的环境中，PDF 渲染不再启动 LibreOffice 转换器，内存随每个进程结束而释放。Poppler 进程在 DSH 沙箱之外运行，除操作系统外没有内存上限，只有 `timeoutMs` 约束它们；提供方既不安装 Poppler，也不检查其版本。使用 SSH 提供方时，Poppler 必须装在 SSH 主机上，PDF 每启动一个进程就经过连接传输一次。每次渲染启动一个读取页数的 `pdfinfo`，并为每段连续页码各启动一个 `pdftoppm`，每个进程都接收完整的 PDF。由于页面尺寸在渲染后才检查，超限的页面会先被栅格化再被拒绝，其图片在 `pdftoppm` 和提供方的 PNG 缓冲区中短暂占用内存，上限是剩余的 `maxBytes`。Poppler 与 LibreOffice 的栅格化方式不同，因此同一请求的图片取决于 Poppler 是否可用；结果中的 `renderer` 字段和文本让这种差异可见。

Office 套件的测试用带 stdin 和 stdout 流的脚本化子进程提供方覆盖后端顺序与退回、显式请求与不可用请求、连续页段拆分、文档属性伪造的 `Pages:` 行、跨多次读取的 PNG 切分、图片数不符、格式错误或被截断的 PNG 流、渲染后的像素和尺寸上限（等于与超出）、数量和字节上限（等于与超出）、读取缓慢和写入失败的 stdin、退出码映射、超时、取消和卸载时的终止、按后端缓存，以及配置校验。另有一个测试在本机 subprocess 提供方能找到两个可执行文件时，通过它用真实 Poppler 渲染生成的 PDF，其中一个的标题伪造了更小的页数。工具测试覆盖 `renderer` 参数、对非 PDF 输入的拒绝、结果文本和不可用提示。

## 相关记录

[有界的共享 Office 转换记录](2026-09-15-bounded-office-conversion.zh.md)定义两个后端共用的队列、缓存和准入。
