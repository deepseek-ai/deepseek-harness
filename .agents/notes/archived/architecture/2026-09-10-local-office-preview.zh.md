# Agent Note: 通过 WASM PDF 字节进行本地 Office 预览

Status: implemented
Archived: 2026-09-11

[English](2026-09-10-local-office-preview.md) | 中文

## 问题

Office Open XML 文件是 ZIP 归档，因此文本回退无法提供有用的预览。文档转换必须留在本地，不抢占焦点，也不将文档内容放入模型对话。仅凭引擎成功状态无法证明输入具有声明的格式或生成了 PDF。

## 决定

[document-render Service Definition](../../../../packages/document/document-render/README.zh.md)、LibreOffice WASM 提供方及 Client/API 消费方构成转换能力。[启动组合](../../../../packages/document/document-render-auto/README.zh.md)仅在配置 `wasm.artifactDirectory` 时挂载提供方和 Remote 控制器。无效的显式配置会使初始化失败。Office Client 注册始终存在，为未配置的 Host 提供指引。可用性由生成的 Remote 命名空间决定，不发现可执行文件，也不维护重复的 Client 标记。

[WASM 提供方](../../../../packages/document/document-render-libreoffice-wasm/README.zh.md)使用固定的官方 LibreOffice 源码、Emscripten 和 LibreOfficeKit 适配器。每个 Node Worker 拥有一个引擎实例、其 pthread 和内存文件系统。终止 Worker 可取消同步引擎调用；每次转换均在返回前等待 Worker 停止。OOXML 检查在启动前验证归档成员、内容类型和资源限制。

VCL 回调在替换前请求字体族，或在字形回退时请求缺失的 Unicode 字符。Host 代码索引已安装字体元数据，将选中的文件复制到引擎内存，包括完整字体集合。精确匹配的已安装字体优先于配置的替代项；原字体优先的 fontconfig 别名在 LibreOffice 内保留此顺序。可选的初始字体族使用同一解析器。引擎不挂载 Host 文件系统，渲染不安装或下载字体。[构建配方](../../../../native/libreoffice-wasm/README.zh.md)记录源码与工具链版本、补丁及产物哈希。提供方使用期间，引擎包保持不可变；不同构建使用新目录。

[独立引擎发布](../process/2026-09-11-independent-libreoffice-package.zh.md)负责预编译 npm 打包，并将引擎编译与普通 DSH 构建隔离。

提供方返回调用方拥有的 PDF 字节，以及独立的 `succeeded`、`timedOut` 和 `cancelled` 事实。PDF 字节在清理前从引擎内存复制出来。API 消费方通过 [Workspace Files](2026-09-09-workspace-file-read-authority.zh.md)授权源文件，要求转换成功且未被中断，并直接编码 PDF。源路径和新鲜度版本保留在 PDF 传输中。Workspace Files 限制源文件读取；生成 PDF 仅受提供方的 `maxOutputBytes` 限制。无需临时 PDF 或文件租约。

Office Client 观察所选 Conversation 现有的 Deliverables 投影，在不打开 tab 的情况下预转换最近的 Office 文件。有上限的内存缓存每次读取都检查已授权的源文件元数据，并在后台和前台调用方之间共享进行中的转换。仅最后一个退出的读取方取消共享转换；失败不缓存，连接重置丢弃缓存字节。[Document Preview](2026-09-08-document-preview-operations.zh.md)负责格式选择、加载、取消和 PDF.js Worker。

PDF.js 官方 TextLayerBuilder 在适配宽度的 canvas 上负责选择边界和复制规范化，共享页面清理，并使用由组件拥有的 resize observer。其内容结束标记和堆叠规则限制空白区域中的选择；换行高亮被抑制。逐页取消使用 builder 的清理操作，而不 abort 第一页的信号，因为官方选择监听器跨页面共享。

缺失字体族观察值随 PDF 经过 Worker 和 Remote 响应。Office 插件在共享 PDF 滚动区域上方呈现 keyed 提示，关闭时移除其布局高度。字体解析器取源文档及主题显式引用与实际文档请求的交集，排除引擎默认字体和字体表清单；已安装别名和字形回退本身不代表字体族缺失。

## 考虑过的替代方案

**保留已安装的原生 LibreOffice 提供方。** 第二个提供方增加可执行文件发现、版本查询、子进程监督、临时文件和平台特定隔离。本设计将 WASM 用于全部受支持的 Office 预览。引入原生提供方需要证明存在 WASM 无法满足的渲染或部署需求。

**返回临时 PDF 路径。** Worker 已提供独立的 PDF 字节。将其写入磁盘、授权另一处文件读取并维护租约，会增加文件所有权，而没有当前消费方需要这些操作。源文件授权和输出限制直接应用于内存结果。

**自动操作已安装的 Microsoft Office。** Word for Mac 需要 GUI 自动化而非 headless 转换，会引入焦点变化和逐文件操作系统授权。原生 Office 自动化不属于本预览能力。

**使用在线转换器或自动下载引擎。** 远程转换会上传文档内容。自动安装增加运行时分发和更新责任；显式产物配置将部署留给运维者。

**将 PDF 页面转换为 PNG。** PDF.js 已负责 PDF 展示。栅格化增加另一条图像流水线，并失去现有 PDF 控件和可选择文本。

**添加面向模型的渲染工具或持久化预览事件。** Client 预览不提供模型输入。面向模型的工具需要记录事实并更新两种 SDK 投影，因此属于独立消费方。

**扫描全部字体表条目生成提示。** 字体表包含未使用的样式和模板。报告这些条目会使提示与实际渲染内容无关，因此收集从引擎初始化完成后开始，在 PDF 保存后结束。

## 影响

单一提供方设计假设 WASM 覆盖所需的 Office 渲染行为；这不是与原生 LibreOffice 完全等价的保真度证据。保真度取决于引擎构建和已安装字体。[真实引擎测试](../../../../packages/document/document-render-libreoffice-wasm/tests/libreoffice-wasm.e2e.ts)覆盖 DOCX、XLSX、PPTX、可选择中文文本和嵌入系统字体；仅有 ABI fixture 无法证明渲染保真度或完整浏览器展示。

WASM 实例有较高的内存与启动成本，因此提供方限制并发。[字体复用与图像分辨率决策](2026-09-11-wasm-preview-font-and-image-budgets.zh.md)负责共享 Host 元数据、Worker 请求记忆化和栅格导出限制；仅选中字体进入引擎内存。大型集合需要有界内存增长，CFF 导出需要受检查的栈空间。致命 abort 后不再调用 C++。设备没有覆盖某字符的字体时，无法在不添加字体的前提下正确渲染该字符。自行构建 WASM 会增加编译器兼容、补丁维护和再分发义务。

预转换消耗转换资源以减少前台等待；条目数和字节限制约束 Client 保留的结果。源文件和 PDF 字节不进入 Session 存储或持久缓存。[提供方测试](../../../../packages/document/document-render-libreoffice-wasm/tests/provider.spec.ts)覆盖独立输出事实、输入/输出拒绝、排队取消和活跃 Worker 终止。现有预览注册表、文件读权限和 Session 所有权决策保持有效。
