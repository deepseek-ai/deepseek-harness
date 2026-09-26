# Agent Note: 独立打包引擎的 Node Office 转换

Status: implemented

[English](2026-09-11-node-office-kit.md) | 中文

## 问题

二进制 Office 和 OOXML 文件需要经过文档排版才能预览。转换必须留在设备上，不能打开 Office 应用，也不能将源字节加入模型对话。原生引擎需要按平台分发，而浏览器转换会在 Host 和 Client 两侧重复字体传输、worker 生命周期与资源限额管理。

## 决策

[文档渲染能力](../../../../packages/document/README.zh.md)将转换委托给独立发布的 `@deepseek-ai/libreoffice-kit` Node API。[kit 归属决策](2026-09-14-independent-libreoffice-kit.zh.md)负责源码维护、兼容版本和 npm 分发。DSH 负责 Session 文件授权、转换并发、私有临时文件、输出限制和 Remote 传输。[Web bundle](../../../../packages/bundle/web-app/README.zh.md)使用稳定 ID 声明转换服务与共享文档预览入口。服务负责带授权的转换 Remote 方法，其描述符由 `api/remotes` 挂载；Office UI 共享文档预览的 Loader 生命周期。

[平台引擎决策](2026-09-15-platform-office-engines.zh.md)要求使用 kit 已声明的原生目标引擎，未声明原生目标时使用 WASM。缺失或无效的必需引擎会拒绝转换。共享的[有界提供方](2026-09-15-bounded-office-conversion.zh.md)负责准入、转换复用以及持续到临时文件清理完成的取消。预览消费该提供方，不注册另一个转换器，也不依赖 Office 创作 skills。

服务和 Remote 方法接受 DOC、DOCX、XLS、XLSX、PPT 和 PPTX。Client PDF 预览通过此路径显示 Word 和 PowerPoint；[浏览器表格预览](../feature/2026-09-16-browser-excel-preview.zh.md)独立读取 XLSX、XLS、CSV 和 TSV。LibreOffice 导入前，kit 校验 OOXML 输入的有界 ZIP 成员和内容类型，以及二进制 Office 输入的 OLE 复合文件头。将文本改为 Office 后缀不能通过校验。kit 不提取二进制格式的字体表，因此这些格式不返回缺失字体诊断。kit 在调用方拥有的私有目录中独占创建新的 PDF。DSH 读取并校验完整输出后才删除临时文件。[服务的 Remote 方法](../../../../packages/document/office-to-pdf/README.zh.md)通过 [Workspace Files](2026-09-09-workspace-file-read-authority.zh.md)授权源文件访问，保留源路径和版本，并返回 PDF 字节。源文件读取上限与生成 PDF 上限相互独立。读取权限探测和延迟读取（包括超限失败后的复查）采用同一个源路径／版本快照，防止转换将字节发布到另一个源身份下。预览字节不会进入 Session 存储或持久缓存。

converter 复用首个转换 Worker 返回的字体元数据；原始字体缓冲区和解码后的字符覆盖范围仍只属于单次转换。Worker 读取字体时校验索引中的文件。已安装字体族的精确匹配优先于配置的替代字体，完整的字体族、样式、字重、斜体、宽度、字距、语言与码点请求保留各自的匹配结果。WASM 回调将包含完整字体集合的原始字体文件导入 MEMFS。原生引擎还保留各平台的字体发现能力。两条路径均不下载或安装字体；原生操作系统管理的字体内存不受显式导入预算约束。字体变化后，重新创建 converter 会刷新元数据。

kit 维护 serif、sans-serif 和 monospace 的默认优先组，其中包含中文正文字体。西文文本缺少中文字形时，先尝试同类的常用正文字体，再搜索其余字体目录，避免仅因文件排序靠前而选用手写体。provider 的可选 `fontFallbacks` 替换这些有序组，不重复维护默认值。优先规则保留已安装原字体的精确匹配，并以其他覆盖字体作为最后兜底；它们不是字体白名单。原生适配器将缺失字体的选择写入私有 VCL profile。已安装的度量兼容字体可能在查询该表前被选中，平台的字形回退仍然可用。原生平台的选择及完整字体集合的导入要求检查导出 PDF 实际使用的字体。

DSH 按可配置分辨率导出栅格图片，默认 192 DPI，对应共享 PDF 画布在设备像素比 2 时的 96 CSS DPI。文本与矢量仍可缩放；JSON 过滤选项替代隐式选项时，显式书签导出保留引擎默认行为。Node WASM 使用 LibreOffice 的 CPU 过滤器降采样图片。原生转换使用独立的平台引擎。

[Office 查看器](../../../../packages/client/ui-sidebar-documentpreview/README.zh.md#office-preview)位于文档预览的 `client/office/` 目录，与其使用的加载生命周期、PDF 正文和读取器类型同属一个包。这些组件放在同一包中，既减少一个独立 UI 启动入口，也无需跨插件运行时导入。其有界缓存校验已授权的源元数据，在读取方之间共享待完成转换，仅在最后一个读取方离开时取消，不缓存失败，并在连接重置时清空。用户打开预览时才开始转换。缺失的已声明字体族随 PDF 返回，可通过文档工具栏的警告图标查看；字体表清单与无关的引擎默认字体不构成警告。共享预览入口的 `office` 缓存设置复用页面全局注入通道，因为模块启动图携带包标识而不传递 Loader 配置。重新加载页面后采用更新的 YAML 值。

Office 响应使用 Typert 二进制结果投影和 Connection multipart 封装。Client 直接收到一个由 `ArrayBuffer` 支撑的 `Uint8Array`，不会生成 base64 字符串或单独的解码缓冲区。构建后的浏览器场景会同时验证 multipart 附件和 PDF Worker。缓存字节限制不约束临时传输或查看器内存。

[kit 归属决策](2026-09-14-independent-libreoffice-kit.zh.md)定义 npm 分发和随应用打包的离线转换。

Desktop 通过现有的目标 Node pnpm 依赖安装流程安装 kit，并保留完整依赖树。Worker 路径和可执行权限仍由普通包文件承载。[Desktop 构建指南](../../../../apps/desktop/README.zh.md) 负责目标选择与打包；每个签名应用仍需在目标平台验收。

[Python 可执行分发](2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)将 kit、目标引擎及其依赖闭包保留在可执行文件旁。安装后的 wheel 冒烟测试会迁移载荷，要求仅存在目标后端，并通过该引擎转换一次 DOCX。各平台的打包与发布限制由[平台引擎决策](2026-09-15-platform-office-engines.zh.md)说明。

声明检查仅放行精确的 API 与引擎包名及 MPL-2.0 条款，继续拒绝无关 MPL 包或变更后的非宽松条款。每位接收者都必须保有访问 kit 对应 LibreOffice 源码版本、补丁、构建说明与许可证声明的权限；引擎包保留各自的第三方声明。向组织外部分发受覆盖的可执行文件时，须满足 [MPL 源码可用性要求](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。

[纯浏览器预览](../../../../packages/experimental/webworker-runtime/README.zh.md)用返回不可用错误的转换器替代 kit 入口，并从 VFS 镜像排除其引擎依赖树。保留 Host provider 的可加载性，可以沿用正常的 Office 错误展示，而无需向浏览器分发 Node Worker、原生辅助程序或 WASM 转换资源。

## 考虑过的替代方案

**保留浏览器 Worker 转换。** 这需要向 Client 分发引擎、提供浏览器字体 RPC 和配置共享内存响应头。Node 已经拥有授权磁盘访问能力，可以向所有 Client 提供转换后的 PDF。

**使用已安装的 soffice CLI 或自动化 Microsoft Office。** 可执行文件发现和环境中的版本削弱可复现性；Office GUI 自动化还会改变焦点并需要应用权限。随包辅助进程拥有固定引擎，不要求安装这两类应用。

**在 Host 进程中加载原生 addon。** 解析器崩溃或同步阻塞会影响 Host。独立的原生辅助进程具有可单独终止的生命周期，其磁盘交换方式也适用于 WASM 适配层。

**任何原生错误都触发回退。** 使用另一引擎重试损坏的包或失败文档会隐藏发布缺陷、重复计算，并使输出取决于失败时机。平台选择要求使用 kit 已声明的原生目标引擎，未声明原生目标时使用 WASM；原生失败后不会使用 WASM 重试。

**返回临时 PDF 路径，或将页面栅格化为 PNG。** Client 需要 PDF 字节来使用现有查看器和可选择文本。暴露临时路径会增加授权与租约管理；PNG 则会建立另一条渲染管线并丢失 PDF 控件。

**每次渲染重新索引所有字体，或只按字体族缓存。** 重复索引主导小文档成本，而仅以字体族为键会丢失样式和字形差异。共享元数据与完整请求键减少重复解析，无需保留字体缓冲区或引入文件系统监听器。

**安装时编译、运行时下载引擎或字体，或使用在线转换器。** 这些方案增加工具链或网络要求，并可能将私有内容移出设备。预构建 tarball 使安装与转换不依赖这些操作。

**保留独立的 Office UI 包。** 其读取器、缓存和字体提示共享预览生命周期与 PDF 展示消费者。独立插件增加包、启动接线和 Loader 开关，却没有独立演进的 UI 职责。Host 转换与 Remote 授权仍保留独立插件。

**移除共享的 Client 转换缓存。** tab 内状态无法在读取方之间共享进行中的转换或已保留的 PDF。有界缓存减少这些重复工作，同时保留各读取方的取消和已授权版本检查。

**添加面向模型的渲染工具或持久预览事件。** 预览不会提供模型输入。这样的工具需要日志事实及两套 SDK 投影，仍属于独立消费者。

## 后果

原生与 WASM 的保真度仍取决于构建、源文件格式、已安装字体及平台字体发现。没有覆盖字体就无法恢复缺失字形。图片分辨率限额不限制图片解码或总进程内存。WASM 为大型字体集合和 CFF 字体保留有界内存增长与受检查的栈空间；致命运行时中止会阻止后续 C++ 清理调用。宏与文档链接更新由实际支持的 LOKit 选项和固定源码补丁禁用；这不构成操作系统沙箱。

[提供方测试](../../../../packages/document/office-to-pdf/tests/provider.spec.ts)、[Loader 组合](../../../../packages/bundle/web-app/tests/document-preview.spec.ts)和[浏览器场景](../../../../apps/web/tests/document-preview.e2e.ts)负责 DSH 生命周期、授权与展示证据。引擎验收还需要真实 DOC/DOCX/XLS/XLSX/PPT/PPTX 转换、外部 PDF 文本、字体、页数与图片检查、迁移安装和损坏包拒绝，以及同输入的原生/WASM 性能样本。模拟辅助进程和微基准不能证明这些结果。各目标的真实构建机与 Desktop 安装包需要独立验收；一个本地架构成功不能证明整个矩阵。
