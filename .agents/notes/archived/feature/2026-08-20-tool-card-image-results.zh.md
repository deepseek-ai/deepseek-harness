# Agent Note: 工具卡片的图像结果

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-tool-card-image-results.md) | 中文

## 问题

已结算的 `read_image` 调用在工具卡片里把原始附件对象当字面文本渲染出来——`{"type":"image","attachment":{"attachmentId":"sha256:…","mediaType":"image/png","bytes":24588,"width":1496,…}}`——而不是显示图像本身。

这由两个彼此独立的缺口造成。`read_image` 没有声明 `output.presentationMeta`，因此没有任何呈现元数据告诉客户端卡片如何展示引用——工具卡片把原始结果内容当作文本打了出来。另一方面，工具卡片层完全没有图像概念：`packages/client/ui-tool/src` 中 `image` 和 `attachment` 一次都没出现，而 `ToolRow` 的卡片槽只有 terminal、diff、read、search、web。

渲染能力其实已经存在，但只接在消息路径上。`MessageImages` 通过 `conversation.message.images` 槽位为用户与助手历史绘制持久图像组。这个不对称解释了一个容易困惑的现象：**嵌套的** `read_image` 能正确显示，因为嵌套调用时 `execute` 会 defer 一条真正的用户消息；而顶层调用只把图像作为工具结果内容返回，就不显示。

## 决定

**宿主侧。** `read_image` 获得只持久化 `{ path }` 的 `output.presentationMeta`——仅路径一项。

附件引用有意不写在那里。已结算的 `content` 本身就带着含完整引用的 image 块，而当 `tools/post-execute` 钩子合法重写结果时，被替换的正是那个块。因此在 `meta` 里再存一份就是同一事实的重复记录，且恰恰在内容变化时变成过期副本——卡片会继续显示结果已不再返回的图像。路径是 content 唯一不作为结构化字段携带的事实：面向模型的信封把后端解析出的路径写成文本，而客户端从不解析那段文本。

不加 `presentResult`，也不给封闭的 `ToolResultView` 联合新增成员。客户端卡片从原始 event 字段派生，宿主的 `presentCall`／`presentResult` 值永不进入客户端（见 [ui-tool README](../../../../packages/client/ui-tool/README.zh.md)），因此新增一个 result-view 分支等于扩展一个无人读取的封闭公共联合。

**客户端侧。** `imageCardModel` 按其他所有第一方卡片的方式派生：`parsedToolCall` 校验调用头与其 `file_path`，`block.meta` 提供路径——嵌套调用（从 `run_code` 内部派发的 `read_image`）不持久化 `meta`，于是用调用自身的 `file_path` 参数补足标签——附件引用从结果自己的 image 块中防御式 narrow 出来，信封在同一内容中定位。它按形状匹配自己的信封而不用 `singleResultText`，因为那个 helper 只接受单个文本块，而图像读取返回 `[text envelope, image block]`——按形状匹配同时意味着其他层前置的内容永远不会被误认为信封。

该 narrowing 只检查附件 id 是否存在。id 是不透明且由提供方拥有的：本地存储铸造内容地址，但消费者既不得解析该表示、也不得假定其形状，且提供方可以不经通知改变它。按本地形式做模式匹配会拒绝替代存储铸造的合法 id，并让该部署中每个图像卡片静默降级。

`ToolRow` 获得 `image` 卡片槽，`read_image` 获得按 key 注册的 toolview，并在其 registration 上把 Tool 自有的 `tool.call.images` 槽位声明为子槽，通过它渲染图库。工具层自己既不加载也不授权：这一行只提供从结果派生出的引用，以及聊天节点新下传的 `loadImage` loader（`ChatNodeOwnerProps.loadImage`），附件呈现插件用与消息图像相同的图库填充该槽位。因此携带图像的工具需要注册按 key 的 toolview（`read_image` 是行装配与 card model 的模板；`tool.call.images` 子槽声明不能逐字复用，因为一个槽位只能由一个 entry 声明）；generic fallback 保留压平文本。

卡片在图库下方保留派生出的信封文本。这不是冗余：在未组合附件呈现插件的部署里 `tool.call.images` 什么都不渲染，而空图库不能留下空白卡片——这是实测而非假设：用一个返回 `null` 的槽位探测，渲染出的是空容器，没有任何可见文本。

`read_image` 归入 `read` variant 并获得自己的 locale 标题 key。不分类时它落到 `others`，标题变成通用文案且不派生 `filePath`（只有 read/write/edit variant 会派生），于是该行声称可点击打开的路径永远不可点击。

`read` 与 `read_image` 是同一种单文件卡片行、只是卡片材料不同，因此它们共享的装配放在 `read-family-row.tsx` 而不是复制一份。

## 考虑过的备选方案

- **给 `ToolResultView` 加 `card: 'image'` 分支并实现 `presentResult`。** 第一版就是这么做的。客户端卡片从原始 event 派生、宿主呈现值不进入客户端，因此该分支没有消费方——等于扩展一个无人读取的封闭公共联合。改为只用 `presentationMeta`。
- **向下传递渲染闭包（`renderMessageImages` 模式）。** 下一版复用了 `ChatNodeOwnerProps.renderMessageImages` 作为 `renderImages` owner prop，与 `AssistantMarkdown` 和消息行的做法一致。review 拒绝了它：客户端规则禁止新增 ReactNode-valued owner props，合规形态是工具层自己声明的槽位。把 `loadImage` 从聊天节点下传后，这一行直接渲染 `tool.call.images`，不再有任何渲染能力穿过 owner 边界。
- **在 generic fallback 上也渲染图像。** 槽位设计做不到：一个槽位只能由一个 entry 声明，而 fallback 组件不是已注册 entry，没有为未声明的子槽提供 dispatch 席位。按 key 的行是唯一图像渲染点；将来的图像工具注册自己的行。
- **像 read 卡片那样用 `singleResultText`。** 它按设计只接受单个文本块，而图像读取返回两块，因此卡片改为按自己的信封形状匹配。
- **在 `meta` 里也持久化引用。** 第一版就是这么做的，卡片也从那里读取。review 指出了这处重复，实录日志也证实了：`meta.image` 与 content 中 image 块的 `attachment` 逐字节相同。改从 content 读取后只剩一份记录，并且会跟随 post-execute 的替换。
- **按 `sha256:<hex>` 校验附件 id。** 试过后撤回：它与 `AttachmentId` 文档化的不透明性相矛盾，并会让任何采用其他 id 形状的部署失效。
- **在 `ui-primitives` 里给图像卡片做专属 primitive。** 作为重复实现否决——消息图库的适配规则、裁剪锚点和灯箱正是卡片需要的行为。

## 验证

`read-image.spec.ts` 覆盖元数据投影、省略显示名，以及一次真实执行——其持久化的引用与附件存储实际提交的一致。`image-card.client.spec.tsx` 覆盖从元数据与信封的派生、路径相对化、来自替代存储的不透明 id、防御式 narrowing 的每个拒绝分支、running／error 两种拒绝、嵌套调用派生及其参数路径回退、按 key 的行渲染点（携带 loader 分发 `tool.call.images`）、带子槽声明的按 key 注册，以及空槽位降级。

每组断言在保留之前都跑过负例：移除 variant 分类、让图像渲染分支失效、把 registrant 的 key 打错、恢复 `sha256:` id 模式、把卡片文本指回行的压平输出——每一项都让目标断言变红。

## 后果

`read_image` 的结果现在在工具卡片上渲染为图像，顶层调用与嵌套调用（从 `run_code` 内部派发的调用）皆然；工具卡片获得一种图像种类。嵌套调用此前已在消息路径上显示图像——`execute` 会为它 defer 一条真正的用户消息——但它自己的工具行仍是 generic；现在卡片派生也覆盖它，用调用自身的 `file_path` 参数替代持久化路径。图像种类并不由元数据单独自动产生：卡片还要求 `tool.call.images` 槽位被填充（附件呈现插件），并且工具注册按 key 的 toolview——因为模型把调用头收窄到 `read_image`，槽位只能从声明的子 entry 渲染。

持久化的呈现元数据为每次图像读取在会话日志中增加一条很小的 `{ path }` 记录。附件引用完全不在元数据里——它位于已结算结果 content 的 image 块中；图像字节本身从不进入日志，因为存储是内容寻址的，块里只携带附件 id。

由于卡片从 `block.meta` 派生，本次改动之前记录的会话没有图像元数据，会以通用文本卡片重放。这是每个从原始 event 派生的卡片都遵循的既有降级路径，不是这里的特例。
