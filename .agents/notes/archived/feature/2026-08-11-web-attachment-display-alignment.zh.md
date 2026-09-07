# Agent Note: Web 附件展示经附件原子组件对齐 DeepSeek Chat

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-web-attachment-display-alignment.md) | 中文

## 问题

Web 输入框的图片界面缺乏基本可用性（用户反馈，issue #2248）。删除按钮以 `top/right: -6px` 挂在 72px 缩略图外侧，被附件栏的 `overflow-x` 盒子裁切，点击经常落空；预览只能双击打开，除了 tooltip 没有任何提示这个操作；附件栏超出输入框宽度时在胶囊内部直接出现原生横向滚动条；图片接收被拒和发送失败（例如所选模型不支持图片输入时的 `attachment-error`）以常驻的内联红条显示在卡片上方。这些界面在 DeepSeek Chat 里都有用户熟悉的既定设计：单击预览、卡片内部悬停显示的删除按钮、隐藏滚动条的箭头翻页、顶部居中的短时 toast。

首个多模态版本把这些界面记录在[Web 多模态 Note](2026-07-22-web-multimodal-image-input-and-durable-attachments.zh.md)中；本 Note 取代其中的展示与交互细节（缩略图几何、点击方式、错误呈现），其附件服务边界、准入与持久化决策继续有效。

这些 UI 还全部住在 `dsh-client-ui-conversation` 里——附件栏内联在 700 行的 `InputBar` 中，历史图片和灯箱分散在 `chat/` 与 `skeleton/`——没有其他界面可复用的接缝，纯 props 的纪律也无从约束。

## 决定

附件展示位于 `@deepseek-ai/dsh-client-ui-attachment`（`packages/client/ui-attachment`）：`AttachmentRail`（64px、16px 圆角缩略图，单击 `onOpen`，卡片内部的删除按钮悬停或聚焦显示、`pointer: coarse` 下常显，隐藏滚动条配两端圆形箭头并依滚动几何重算，纵向滚轮转横向平移且单次钳制 60px，新增条目滚到栏尾），`MessageImage`/`ImageGallery`（单击预览），以及 `ImageLightbox`。这些组件仍是包内的纯 props 组件。`ui-conversation` 声明输入框附件与消息图片 slot，并提供草稿 id、图片加载、接收回调及其 locale seat；动态 ui-attachment 客户端 entry 等待这些声明并注册呈现。[动态渲染与附件归属 Note](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.zh.md)负责这项包集成决策；本 Note 记录的视觉行为保持不变。

两个浮层都 portal 到 body：从聊天消息打开的灯箱位于带 transform 的祖先之下，`position: fixed` 会被困在祖先的盒子里（遮罩只盖住聊天列），因此 `ImageLightbox` 与 `Toast` 经 `createPortal(document.body)` 渲染，从任何打开位置都覆盖整个视口。短时横幅是 `ui-primitives` 的 `Toast` 原子（距视口顶部 120px，水平中心跟随可选锚点——composer 卡片，因此横幅在聊天列上居中——`role="alert"`、`pointer-events: none`，停留三秒再一秒淡出，`onDone` 卸载，按展示序号作 key 使相同文案重新播报）。`InputBar` 把接收拒绝（`addImages` 返回的原因）和 `promptError` 都改走 toast，替换内联红条，`ModelSelect` 的模型选择被拒也走同一原子，其菜单内带 Retry 的错误条仍是目录加载的呈现面；状态机 notice 条不受影响。DeepSeek Chat 源码（本地参考副本）提供了目标行为：其 `ImageThumbnailInInput`（64px 卡片、透明度过渡的删除钮）、`ScrollArrows`（哨兵驱动的翻页）与 `useToast` 用法。

## 备选方案

**组件留在 `ui-conversation` 里只改样式。** 被用户否决：附件面预期还会长（文件卡片、上传进度），而仓库的插件纪律禁止其他插件 import `ui-conversation` 内部实现，在插件里生长只会堆出无法复用的一坨。原子组件包给了同样的组件一条被允许的 import 路径。

**导出附件原子组件并由 `ui-conversation` 直接导入。** 被包集成决策否决：直接导入组件会绕过动态插件生命周期与跨插件 slot 组合。conversation 包仍持有数据与渲染位置，ui-attachment 则持有其中可选的呈现 entry。

**Toast 放在 `ui-conversation`。** 否决：短时横幅没有任何会话特有的东西，`ui-primitives` 是零 cordis 原子组件的既定归属，其他界面也可能复用。

**保留内联红条，只给图片接收加 toast。** 否决：`promptError`（issue 截图里的 `attachment-error`）恰是用户实际抱怨的界面，一个输入框里存在两种错误呈现会让红条成为孤例。

## 结果

输入框与历史图片界面的交互模型与 DeepSeek Chat 一致，纯 props 组件通过 conversation slot 的 locale seat 渲染，无需触达应用状态。代价是一个真实的动态包边界：`ui-attachment` 带有标准插件脚手架（客户端 bundle、invariant 伴生、双语 README、tsconfig face、逐文件 100% 覆盖率），省略该插件会让两个可选附件 slot 保持为空。错误横幅是短时的——用户移开视线四秒就会错过消息，这正是 DeepSeek Chat 自己做的取舍。非图片附件仍不支持；附件栏的卡片模型已就绪，但输入框的接收仍只认图片（记录于包 README 的限制一节）。
