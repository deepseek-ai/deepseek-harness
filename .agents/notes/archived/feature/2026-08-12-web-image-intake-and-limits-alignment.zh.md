# Agent Note: 整页图片拖放、上限投影预检与缩略图平铺

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-web-image-intake-and-limits-alignment.md) | 中文

## 问题

issue #2248 的第二步对齐，接在[附件展示 note](2026-08-11-web-attachment-display-alignment.zh.md) 之后（其附件栏、toast 与原子组件包的决策继续有效；本 note 取代其中历史画廊几何与灯箱 backdrop 的具体规格）。与 DeepSeek Chat 相比剩下的差距：图片只能拖到 composer 卡片上——拖到聊天记录区会让浏览器直接导航到文件；灯箱关闭钮是裸 `×` 文本字符（button 不继承字体，且该字形的墨迹在行框中心之上，因此明显偏斜），backdrop 用 `color-mix(label-primary 74%)`，dark 下反转成刺眼的白色蒙层；一条消息的多张图各自以最大 240px 的块竖着堆叠，因为画廊容器本身被钉在 240px；客户端完全不执行也不展示图片限额——用户可以攒 50 张图，直到提交后收到原始的 `attachment-error (TOO_MANY_IMAGES)` toast，眼看附件栏清空又回滚。

## 决策

**整页拖放。** InputBar 在 document 上绑定 `dragenter`/`dragover`/`dragleave`/`drop`（enter/leave 深度计数、视口边缘与 `dragend` 复位、按 `Files` 类型门控使文本拖拽保留原生 textarea 路径），并渲染 `ui-attachment` 新增的 `DropOverlay` 原子组件：经 body portal、不接收指针事件的全视口层（DeepSeek Chat DragMask 的视觉——白色 70% 加 10px 模糊，dark 为 `rgba(39,39,48,0.7)`，插画、标题、上限行），`disabled` 变体宣告锁定或忙碌的 composer。指针惰性是承重的：拖拽事件继续命中下方页面，深度计数永远看不到遮罩自己。document 级监听状态是安全的，因为 composer-bar slot 为 `kind: 'single'`。

**灯箱。** 关闭钮换成 `ui-primitives` 的 `IconCloseOutline16`（Modal 的先例——在 viewBox 内居中的 SVG 不依赖字体度量）。backdrop 用共享的对话框遮罩（`--dsw-alias-bg-mask-1` 加 `--dsw-mask-blur`，两个主题都是黑基色），画在独立的兄弟图层上，因为 `backdrop-filter` 画在容器上会把预览图自己也模糊掉。

**历史缩略图（DeepSeek Chat 规则）。** 一条消息仅有的一张图长边 240px、展示比例钳制在 [0.25, 4]，`cover` 裁切，特别高的图锚定顶部、特别宽的锚定左侧，从不放大；多张图渲染为固定 64px 方块，单个可换行的横排（10px 间距，用户消息右对齐）。assistant 连续的 `image` 块合并进同一个画廊，平铺而不是各占一行。

**上限对齐并投影。** 输入默认值是每条消息 20 张、每个源文件 32 MiB、源文件总量 100 MiB、每张图片一亿解码像素，以及源文件任一边 16384px。附件后端另行生成长边 2048px、独立安全上限 4 MiB 的持久主版本。模型请求使用各路由自己的像素和编码字节预算，因此源文件准入不采用提供方请求限制。HTTP 载体统一使用 `DEFAULT_MAX_REQUEST_BODY_BYTES = 160 MiB`，满足 100 MiB 总量经过 base64 和请求封装扩张后的加载时容量断言。512 MiB 总量无法通过当前传输，因为 base64 进入 JSON 后会需要一个接近 V8 字符串大小上限的 JSON 字符串。输入上限通过 `imageLimits` 会话投影到达客户端。它是每次启动恒定的单元，由 **apiproxy** 而非 attachment Service Definition 注册。`dsh-llm` 依赖 `dsh-attachment`，而 `dsh-session-projection` 经 `dsh-session` 到达 `dsh-llm`；在 seam 包注册投影会形成 project-reference 环。每条消息的数量和总量规则也由 proxy 强制执行。`SessionProjectionMap` 合并继续放在 proxy 的 sessions 协议文件中，客户端已经通过载体类型再导出使用它。

**加入预检与错误文案。** 两种加入手势汇合到 InputBar 的一个 `intakeImages` 包装：在 `addImages` 之前按投影检查数量、单图字节与总字节，违规的一批整体拒收（DeepSeek Chat 语义）并立刻弹出点名上限的横幅——不再有提交时的回滚戏码。宿主检查保留，兜底绕过 composer 的调用方。横幅文案遵循用户定下的一条原则：用户能解决的原因（模型不支持视觉、数量、大小、分辨率、格式——格式改为正面列出支持列表而不是回显被拒的 MIME 类型）用点明出路的产品句子；用户无法解决的原因（base64 损坏、引用丢失、读取失败）折叠为一条保留原因码的发送失败句子，因为产品当前面向开发者，可上报的码好过死胡同。非附件错误码保留原文加错误码的展示。

## 备选方案

**在 attachment Service Definition 构造函数里注册投影单元。** 天然的 seam 归属，也是第一版实现——被依赖图（上述环）和一个测试基建交互否决：基类构造函数调用 `ctx.inject` 使得 spec 中直接构造的 store 触发全局 invariant 宿主，后者往同一 root 重复挂载 `attachments` 服务。

**灯箱用 `--dsw-alias-bg-mask-photo`（0.88 黑、主题恒定、无人使用）。** 设计系统的照片查看器 token，也可能是 dsweb 灯箱实际的蒙层；用户选择与 settings 对话框遮罩一致（`bg-mask-1` 加模糊）——两者都能修复 dark 反转。

**在 `apply.ts` 的 `addImages` inject 里预检。** seam 纯度上的位置，因管线成本否决：投影仓没有暴露给 inject 工厂的非 React 面，而 InputBar 已经以惯用方式消费投影，且是两种手势的唯一调用方。

**用 `host.describe` 字段代替投影。** 与会话无关且更便宜，但要经注入 prop 链而非 `useProjection` 送达，而投影的键缺席语义（"未组合 attachment 服务 → 不预检"）是白拿的。

## 后果

拖到窗口任何位置都能进附件栏，超限加入在手势发生的那一刻就以点名上限的文案失败，历史图片像 DeepSeek Chat 一样平铺。载体的默认请求体预算扩大约 5 倍，并且仍是单请求驻留内存上界（桥把请求体整体缓冲；已记录在 connection README 的限制节）。fixture 传输用硬编码的默认数字镜像该投影——改配置的部署会与 fixture 模式的文案分叉，对 keyless 演示通道可接受。画廊左右切换、灯箱缩放与下载、非图片文件卡片仍然推迟（#2248）。
