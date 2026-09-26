# Agent Note: WASM 预览的字体复用与图像分辨率

Status: implemented
Archived: 2026-09-11

[English](2026-09-11-wasm-preview-font-and-image-budgets.md) | 中文

## 问题

Office 转换在不同文档间重复解析字体元数据，并在同一文档内重复匹配字体。图片较多的文档还会在 PDF 导出时花费大量时间，重采样高于预览显示分辨率的图像。这些成本需要分别控制，因为字体复用不会减少图像解码或重采样。

## 决策

[WASM 提供方](../../../../packages/document/document-render-libreoffice-wasm/README.zh.md)在初始化时建立一次字体元数据快照。每个转换 Worker 接收结构化克隆。Host 保留名称、字体面属性、路径、大小和修改时间；字形覆盖、请求缓存及导入字节属于 Worker。重新加载提供方会刷新快照。Worker 读取已索引文件时校验文件，已经导入的字体在该次转换内仍可使用。

每个 Worker 记忆化完整请求：字体族、样式、字重、斜体、字宽、字距类型、语言及有序码点。缓存保存 MEMFS 路径和缺失字体族观察值。命中时重放这些观察值，因为初始化请求可能在文档字体收集开始后再次出现。Worker 终止时释放缓存及引擎内存。

运行时 PDF 过滤器选项将栅格图像降低到可配置的 `maxImageResolution`，默认 192 DPI。[共享 PDF 画布](../../../../packages/client/ui-sidebar-documentpreview/src/client/pdf/document.ts)按 96 CSS DPI 乘以设备像素比渲染；默认值覆盖像素比 2。文本和矢量图形仍可缩放。JSON 过滤器选项替换隐含过滤器数据时，显式导出书签保留 LibreOfficeKit 的默认行为。

[本地 Office 预览决策](2026-09-10-local-office-preview.zh.md)继续负责转换生命周期、授权、缺失字体展示和 PDF 传输。

## 考虑过的替代方案

**在每个转换 Worker 内索引字体。** 这会将发现工作移出 Host 事件循环，并立即识别新安装的字体，但会在不同预览间重复读取完整字体文件并解析元数据。提供方快照消除重复工作，代价是同步初始化，以及字体变化后显式重新加载。

**只缓存字体族名称。** 样式、语言、字距类型和缺失字符可能选择不同文件。完整请求键保留这些区别，同时仍能命中重复排版请求。

**所有预览保持 300 DPI。** 更高栅格分辨率保留高像素比及放大时的细节，但增加图像导出工作。可配置的 192 DPI 默认值符合常见显示目标，无需栅格化文本或重新构建引擎。

## 影响

提供方冷启动包含索引成本，不计入转换时限。共享元数据不保留原始字体缓冲区，各 Worker 仍会读取选中字体并按需解码字形覆盖。安装或替换字体后需要重新加载提供方；索引后发生变化的文件可能使后续转换失败。

降低图像分辨率以高倍缩放下的栅格细节换取更少的导出工作。它不是引擎内存上限：LibreOffice 仍可能解码全分辨率原图、加载大型字体集合，或耗尽构建时设定的 WASM 内存上限。此实现不引入持久化字体缓存、文件系统监听器或跨文档引擎实例。

[字体测试](../../../../packages/document/document-render-libreoffice-wasm/tests/fonts.spec.ts)覆盖完整请求键、重复缺失字体族观察值、快照隔离和失败导入。[提供方测试](../../../../packages/document/document-render-libreoffice-wasm/tests/provider.spec.ts)覆盖快照复用和重新加载。[真实引擎测试](../../../../packages/document/document-render-libreoffice-wasm/tests/libreoffice-wasm.e2e.ts)检查默认及覆盖 DPI 设置时的导出图像尺寸、可选择文本和页数；仅验证 ABI 参数转发无法证明过滤器行为。
