# Agent Note: 通用文件上传

Status: implemented

[English](2026-08-26-generic-file-upload.md) | 中文

## 问题

会话可以把粘贴或拖入的图片作为持久附件接收，但其他任何文件都进不了对话：composer 拒绝非图片字节，唯一与文件相关的入口是 `@` 路径引用，而它要求文件本来就能从宿主工作区读到。用户无法从浏览器把 PDF、数据文件或压缩包交给智能体，而 DeepSeek Chat 用户期待回形针加文件卡的上传交互（#2984）。

命令平面已经为图片建立了完整提交规则：命令必须同时消费文本与附件，或明确拒绝整次提交。`input.images` 声明和只支持图片的 RPC 载荷使通用文件在普通消息可用后仍走独立拒绝路径。Plan 和 goal 入口需要使用同一附件词汇，同时保留执行器强制规则，不能静默清除草稿。

## 决定

文件与图片使用不同存储方案，并进入同一个有序消息附件列表。图片的规范化附件流水线保持不变。其他被选中的文件进入同一个先进先出的后台上传队列，按字节原样保存且不设类型与大小限制，再在本进程内按同一 Session 暂存。相同字节在 `DSH_HOME/attachments/v1/file-objects/<digest-prefix>/<digest>` 下只有一个规范对象；每条模型可见的只读路径 `DSH_HOME/attachments/v1/files/<digest-prefix>/<digest>/<name>` 都是硬链接，因此不同显示名称不会复制内容。该队列可以配置，默认同时运行两项传输。独立的双端 `file-upload` Cordis 包拥有传输与暂存。其 Client `fileUpload` 服务同时接收所属 Session 标识与 `Blob`、精确字节或只能使用一次的 `ReadableStream<Uint8Array>`；它使用该标识组装原始路由请求，或直接调用生成的 Remote。其 Host `fileUploads` 服务拥有流式路由、编码 Remote 兜底、命令凭证解析器，以及以接收方 Agent 的 Session 对象为键的凭证表。编码准入和附件错误识别通过 `ctx.attachments` 完成，字节存储由附件提供方拥有。Session Controller 注册用于休眠普通 Agent 的解析器，并在 prompt 准入时消费凭证；Session 对象不公开文件传输。普通 Web 页面把每个活动请求体交给专用上传 Worker：Blob 请求体通过 XMLHttpRequest 发送并报告包含总量的字节进度，stream 则转移所有权并增量传入 Fetch。Worker-hosted 页面通过页面自有 Fetch 载体把请求体转交给 Host Worker，后者读取有界分片。页面线程不读取通用文件字节，也不做 base64 编码或 JSON 序列化。经过认证的 Host 路由显式使用 Connection 的流式请求模式，因此 bridge 会在消费请求体前分发，本地存储则把有界分片写入私有暂存对象并同时计算摘要。接收完成后，内容寻址对象以原子方式发布；取消或失败会移除暂存文件。上传任务和草稿状态属于常驻的 conversation 根，因此切到另一条 Session 不会停止传输，返回原 Session 时仍显示同一张文件卡和当前进度。移除文件卡会跳过排队中的传输或中止正在运行的传输。发送的消息在 `user/message` 里携带结构化的 `FileBlock`（`{ name, bytes, attachmentId }`），不新增会话事件类型。`LlmRuntime` 的请求组装把每个文件块，包括嵌套工具结果中的文件块，投影成确定性 handle 文本，指出文件与其只读保存路径。handle 会要求主 agent 委派文件任务时附上该路径，并在子级执行环境看不到路径时明确报告。提供方不会收到文件字节，模型在需要时用现有文件工具读取存储副本。

默认模式、激活的 Plan Mode 与 active goal 共用普通 queue、follow-up 和 steer 的附件准入。`/goal` create 和 edit 以及 `/plan` 进入接受同一套有序图片与文件批量；携带附件的控制子命令会在状态变更前拒绝。命令提交引用已完成暂存的文件凭证，不会再次读取或复制通用文件字节。Session Controller 先把每个文件凭证解析为持久引用，再由 `ctx.attachments.admitPromptContent()` 接收完整有序内容列表；附件准入会持久化图片，并让文件引用原样通过。原 Agent 已销毁时，Host 会拒绝发布上传完成凭证，并按 `rpcId` 去重已经存在的 prompt 重试。prompt 凭证在失败恢复期间保持可用，已接受的 queue 或历史 occurrence 被观察后才退休；只被命令使用的凭证保留到 Session 销毁。提交回显在序列化前经 `beginSubmission` 注册，通过 `pendingSubmissions` 携带混合附件，以 `rpcId` 关联，在 queue 或历史观察后只退休一次，并在失败时保留草稿。发送前，composer 把有序附件放进同一条不换行的横向附件栏：图片使用 64 乘 64 像素缩略图，通用文件使用 240 乘 64 像素卡片，带 16 像素圆角、蓝色文档图标、文件名加扩展名与大小，以及悬停或键盘操作时可用的移除按钮。QueueDock 使用相同顺序以及紧凑的缩略图和文件卡。发送后，Chat 把有序附件放进同一个右对齐、可换行的附件区域。只有一张图片时保留图片画廊的大图样式；一条消息含有多个附件时，图片使用 64 乘 64 像素缩略图，文件使用 240 乘 64 像素卡片，文件与图片在可用宽度内共用一行，空间不足时再换行。Trajectory 保持紧凑的用户消息预览，并增加本地化的通用文件数量。回形针、拖拽和粘贴按 MIME 分类；发送会等待每个文件上传完成。continuable 子代理 composer 禁用附件入口，Host 会拒绝收到的任何子会话文件块。

## 考虑过的替代方案

- **把上传存进项目根目录**（OpenHands / ChatGPT `/mnt/data` 的形态）。拒绝：用户目录里的文件可能被编辑、移动或删除，会打断会话日志的稳定引用，污染 `git status`，还要求工作区必须存在。`DSH_HOME` 用内容寻址保存冻结的只读字节；执行世界可见性由投影路径提供，之后还可以补一步拷贝进工作区。
- **专用的 `read_file` 工具。** 拒绝：handle 文本指向一条普通路径，现有 `read` 工具（以及模型的其他文件工具）已经覆盖它；再加一个读工具只会分裂模型行为而不增加能力。
- **把内容急切注入提示词。** 对文件的拒绝理由与当年对 `@` 引用完全相同（[web 文件引用](../../archived/feature/2026-07-27-web-file-and-session-references.md)）：附加时相关性未知，惰性工具读取让每次内容访问都留在日志里。
- **类型白名单与大小上限。** 现阶段拒绝：DeepSeek Chat 的白名单存在是因为其服务端要解析上传，而本 harness 只存字节、让模型自己读。流式载体和存储让内存占用与有界分块大小相关，因此上限属于磁盘与传输策略，不用于保证请求安全。
- **新增 attachment/file 会话事件。** 拒绝：图片已经采用的「块内联在 `user/message`」模式即可满足模型可见 ⟺ 可日志重建，无需扩大事件词汇。
- **有附件时阻止所有命令。** 拒绝：`/goal` 目标与 `/plan` 进入需要参考文件，统一拒绝会使这些文件没有进入模型的命令路径。
- **任何命令成功后自动发送附件。** 拒绝：`/model` 与 `/compact` 等状态命令不表示模型可见输入。附件是否成为用户消息由命令生产方负责。
- **把目标附件存进 goal 领域。** 拒绝：一条普通的已记录用户消息就能让后续 Goal Round 获得相同历史，无需扩大 goal schema 或把附件复制进 Round 提示词。
- **任何命令成功都消费附件。** 拒绝：`/goal pause` 或 `/plan off` 会清除无关卡片。只有生产方明确成功才消费附件；无法使用附件的语法形式返回错误。
- **只在客户端执行声明。** 拒绝：直接 RPC 调用方可以绕过 composer。`CommandRuntime` 在处理器运行前强制检查声明、存储可用性、同一 Session 的文件凭证解析、图片 base64 准入与图片限制。
- **通过 `ctx.connection` 暴露上传并沿 Session 构造器传递该对象。** 拒绝：Connection 不拥有文件传输，中间对象层也不使用这项依赖。独立上传服务直接接收 Session 标识，并允许普通浏览器与 Worker-hosted 页面替换载体，无需扩大 Connection 或 Session。

## 后果

- 上传字节永不删除且没有大小上限，`DSH_HOME` 的增长无界；垃圾回收与图片保留问题一同继续挂起。
- 投影路径只在对应执行环境中有效：无法映射 `DSH_HOME` 的沙箱或远程文件系统会得到显式的无路径 handle，模型会报告无法读取该文件。基于存储的读取兜底被推迟。
- 暂存上传按 Session 存在 Host 内存里；上传与发送之间 Host 重启会出现 `FILE_NOT_STAGED`，客户端重新添加文件即可。
- 浏览器到 Host 的传输使用一次不带断点续传偏移的流式 HTTP 请求；连接或 Host 失败后的重试会从第一个字节重新传输整个文件。
- `ReadableStream` 上传只消费并转移一次 stream；重试必须重新创建 stream，而且在未来 API 允许生产方提供长度前，进度不能报告总量。
- 浏览器上传 Worker 由自包含函数的字符串形式生成。需要运行时 import 时，必须改用由 tsdown 打包的独立 Worker 入口。
- 命令必须声明接受附件。命令拒绝时保留文本草稿与全部附件卡，供用户重试。
- 子代理不独立上传文件。主 agent 委派时传递保存路径；只有同机或继承父级历史且执行环境能映射该路径的子级可以读取。
- 上传的文件尚未进入 `@` 补全；该联动是计划中的后续阶段。
- 命令注册表准入带类型标记的 `CommandSubmitAttachment` 联合类型，其中的文件成员携带暂存凭证，再向处理器提供一个冻结的有序 `ImageBlock | FileBlock` 数组。注册表不安排模型输入；`/goal` 增加一条已记录 follow-up，`/plan` steer 有序附件块。
- 从菜单选择弹窗命令不会提交 composer 的整套内容。附件保持可见，直到用户提交命令行或移除附件。
- 声明、存储缺失、未知凭证与图片限制拒绝发生在处理器运行前。生产方语法拒绝和图片准入后的取消可能留下无引用的内容寻址对象，由后续附件垃圾回收处理。

## 测试

单元与集成覆盖原样与流式存储、文件名清洗、声明为 2.19 GiB 的请求通过流式 bridge 且不发生总量缓冲、原始字节与 RPC wire 准入、Blob 与可转移 `ReadableStream` 载体、后台上传并发上限、进度与取消、跨 Session 上传常驻、命令通过文件凭证提交且不再次读取字节、read-only 与 workspace-write 权限下的 native 和 PTC 投影、上传暂存、有序 queue 与 steer 提交、队列转 steer、pending 回显退休与失败恢复、active plan 和 goal 的附件入口、`/plan` 与 `/goal` 混合附件、子代理拒绝、composer 与 Chat 附件布局，以及 Trajectory 文件摘要。keyless `file-upload-round` 快照记录浏览器上传、模型读取文件与答案呈现。
