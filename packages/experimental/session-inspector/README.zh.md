---
description: "原始 Session 日志与 Chat group/node 虚拟表格，支持流式分片子行、分页和更新高亮。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-session-inspector

[English](README.md) | 中文

## 概述

通过可选的[开发者工具组合包](../inspector-profile/README.zh.md)检查原始 Session 日志与 Chat 结构。从 Sidebar 的新建 tab 菜单或引导页打开**会话数据诊断**，再从左上角选择**原始数据**或**对话分组**。可以沿对象引用查看 Node、Turn 和 Step，也可以将选中 Node 定位到 Chat。流式分片显示为子行，Chat 更新时对应行短暂高亮。两种展示均支持更早历史和可调整高度的详情，不显示 composer。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

开发者工具组合包以 `session-inspector` 配置行挂载本插件。它为 Sidebar 当前 Session 注册 `session-inspector-log` 页面，不注册 Conversation View 或 header 标签。下拉框初始展示会话日志，旁边保留当前行数。切换展示形式会重置局部选中、类型筛选和滚动状态。本插件不需要调试参数，不接受配置，也不改变 Session 数据。

点击类型列表头的筛选图标，输入类型片段。候选从所有已加载记录中异步更新。Enter 或**确认筛选**确认输入的片段；点击候选，或用方向键选中候选后按 Enter，则确认该类型。匹配忽略大小写，默认包含匹配：`delta` 和 `*delta*` 都能匹配 reasoning 与 tool-call delta。仅编辑不会改变表格。Esc、取消或点击外部会放弃草稿；清空后确认恢复全部类型。

筛选后的表格保留匹配行及其父级上下文，初始展开折叠父级。仅作上下文的类型使用淡色，不计入匹配行数。新增和分页加载的行沿用已确认的筛选。确认后重置选中、手动折叠和尾部预留空白，并回到顶部。沿对象引用或从 Chat 选取元素时，若目标行被排除，会先清除筛选再定位该行。

会话日志按 `turn/start` 到 `turn/end` 分组，内部再按 `step/start`–`step/end` 分组。start 原始记录作为吸顶组头，end 保留为组尾的原始子行。Turn 和 Step 完成后仍保持展开，可手动折叠。两个 Step 之间的记录属于 Turn，已加载区间之外的记录不分组。不伪造缺失的 start：加载到更早的 start 后，再为现有行补上层级。Assistant stream 在 Step 内保留自身嵌套。

Assistant 日志将原始带时间分片放到对应的 `block-start` 下，包括文本、推理和工具调用参数 delta。未闭合 block 默认展开；`block-end` 自动收起对应 block，之后可手动重新展开。历史中已闭合的 block 默认收起。直播分片归入同一 attempt 行，结算后由持久化事件替换。对话分组将实际 group 成员放在 group 下方；隐藏或未列出的已物化 Node 仍作为根行，按事件锚点插在已有根行之间，不会统一追加到最后一个 Turn 后，也不由检查器虚构分组归属。新增与更新短暂高亮，但系统要求减少动画时不播放。

使用展开箭头折叠子行，选择行的类型或数据查看原始详情。横向数据摘要省略 `type`、`seq`、`sequence` 和顶层 `time`。聊天节点还省略已有独立列展示的顶层 `key` 和 `kind`。过滤后只剩一个字段时只显示值。Tool-call delta 摘要只显示参数片段；reasoning delta 摘要只显示文本。摘要过滤不移除原始详情中的字段。拖动详情面板上边缘的分隔条，或使用其上下方向键，可以调整高度；切换记录会保留高度。

折叠的 reasoning `block-start` 省略 `index`，在 `blockType: reasoning` 后显示拼接的 reasoning delta，沿用普通摘要长度限制。交错到达的 block 分别维护摘要。展开后恢复普通字段及原始子行；原始详情保留原来的 block-start，不加入合成文本。

聊天节点详情使用按需展开的对象树，不转换为 JSON。Map 保留对象 key 与 value，Set 和数组展示成员，类实例保留类型名及自身字段。集合分批展开；getter 只显示标记，不执行；WeakMap/WeakSet 不展开内部内容。正在检查的根对象直接展开；未登记的循环引用显示祖先路径。展开字段缓存到 Conversation 下一次发布，使可变 Turn/Step Data 刷新时保留展开状态，纯 UI 重渲染不重复枚举。

数组和 TypedArray 只读取已展开的索引前缀；稀疏数组的空槽会单独标记，与显式 `undefined` 区分。**其他属性**提供非索引字段和 symbol 字段，不执行 getter。初始数字索引页不会枚举整个集合；显式展开其他属性时才扫描全部自身键。

嵌套 Node、Group、Turn、Step 和 Data 对象提供引用按钮。点击引用后打开其当前已加载值，并增加一级面包屑；点击前面的面包屑可返回该级，同时移除后续路径。即使引用导航选中了另一个表格行，第一级仍保留最初的行。引用有对应行时，会展开其 Inspector 父级 group、滚动定位并闪烁该行。Node Data 另外提供原地展开箭头：展开时留在当前树内，点击标题才跳转。重复出现的 Node Data 祖先保留为链接，不递归展开。选择表格行或从 Chat 选取元素会开始新路径；会话日志保留 JSON 详情，不提供引用导航。

选择聊天节点行或沿引用跳转时，Inspector 的 [DOM 匹配函数](src/client/views/chat-node/dom.ts)在同一 Session 已显示的主 Chat 中查找现有 Node、call、Group 或 Turn 属性。Inspector 对可搜索的折叠祖先触发现有 `beforematch` 行为，再执行原生滚动并在 body 层绘制高亮，不向 Chat 内容添加元素。可见目标只闪烁，不可见目标先平滑滚动再闪烁；减少动画时立即滚动且不闪烁。ID 列保持窄宽度；悬停或聚焦 ID 时，提示框显示完整值。

缺失、空内容或展开后仍隐藏的展示位置不会阻止定位。事件坐标可用时，Inspector 按事件距离依次尝试同一 Step、同一 Turn、其他已加载 Turn 中的附近内容。现有 Group 和 Turn 展示位置也可作为回退位置。没有可呈现的候选时，Inspector 高亮当前可见的 Chat 列，不移动它。

选择会话日志行时，将[原始日志坐标](src/client/views/session-log/chat-target.ts)交给同一 DOM 查找流程，保留日志展示形式和 JSON 详情。Inspector 读取现有 Chat 快照，优先匹配工具调用身份、精确事件锚点和所属 Assistant step，再使用同一套回退选择。流式子行沿用所属事件，并在可用时优先匹配推理或回复分片。目标缺失时不加载历史，也不切换当前 View；Chat 为空时没有可高亮区域。

展示形式下拉框旁的瞄准按钮在已显示的主 Chat 上覆盖透明的点击拦截蒙层。Inspector 使用 `elementsFromPoint()` 排除自身蒙层和预览层，再匹配底下元素的现有 data 属性。点击后选中当前 Inspector 展示形式中的对应记录，展开表格祖先并打开详情，不会激活底下的 Chat 控件。滚轮操作转发给下方 Chat 滚动区域。Esc、再次点击瞄准按钮、切换展示形式或 Session、隐藏或关闭 Inspector，以及窗口失焦都会取消选取。每个插件实例同一时刻只有一个选取器有效，不同实例不会互相取消。插件卸载会释放自己的选取器，不调用面板回调，并阻止旧面板重新启动选取。

聊天节点反查优先匹配精确 Node 和 reasoning/response 分片，再退到所属 Group、Step 或 Turn。会话日志反查优先匹配 tool call 或 Node 日志锚点，再退到对应 Assistant、Step 或 Turn 记录；有推理分片时优先选中其第一个 reasoning block。已加载表格没有匹配项时显示提示，并继续等待选取。不使用文本相似度。[元素及 Chat 行匹配函数](src/client/views/chat-node/pick-match.ts)和[日志模型的选取函数](src/client/views/session-log/model.ts)负责这些可调整规则；嵌套工具调用可能定位到根 Node 或其日志锚点。

会话日志使用同一字段渲染器展示解析后的 JSON，所有嵌套对象和数组默认全部展开。可以单独收起各层，不提供引用按钮、面包屑、集合额外属性分组或集合分页。JSON 保留 `[Circular]` 标记和可读 bigint 字符串。检查错误只在局部显示，不禁用表格。摘要过滤不移除两种详情中的字段。

父级行按嵌套层次依次吸顶，位于表头下方，并使用不透底的主题底色；每一级依据未被表头及前面吸顶行遮挡的首行选择。block 自动闭合时，可见行或仍存在的父级保持原屏幕位置，空白只留在数据下方；新行先填入尾部空白，填满后恢复正常跟随末尾。手动调整折叠会保持被点击组头在视口中的实测位置并暂停跟随，只保留让它可见所需的尾部空白。**跟踪最新**清除预留空白并恢复跟随。向上滚动或点击**加载更早**也会暂停跟随。原始数据显示 UTC 时间戳，保留服务端的毫秒精度；对话分组不显示时间列。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 是不执行行为的 Host 发现入口。[Tab 注册](src/client/views/index.ts)贡献页面类型及 Session 作用域的正文，借用 Sidebar 已有的 Session 引用。[合并面板](src/client/views/View.tsx)在[日志模型](src/client/views/session-log/model.ts)和 [Chat 模型](src/client/views/chat-node/model.ts)之间切换，只有当前表格订阅来源。[对象索引](src/client/views/chat-node/objects.ts)通过弱引用身份标记 Node、Group 快照、各自 data 根对象，以及 Turn/Step 位置与 Data reader。具名引用读取当前值，不保留已替换的快照。节点枚举使用现有 `nodes.values()` reader。[定位器](src/client/views/chat-node/reveal.ts)和[选取器](src/client/views/chat-node/picker.ts)在本包内负责全部 DOM 交互，不增加 Chat 或 Conversation API。共享[表格](src/client/views/InspectorTable.tsx)使用 TanStack Virtualizer。

直播日志追加复用历史行对象与 Turn/Step 分组游标。每个分片只向对应 block 插入一行，按需替换闭合组头，并调整后续根行的偏移。分页、结算、替换或跳过版本时重建层级，同时保留按键缓存的原始记录来源。DOM 字符串先匹配当前 Group 引用，再访问注册表；未分组的 Chat key 沿用上游字符串类型，不使用品牌断言。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，因为此 Inspector 不增加模型可见输入。

#### KV Cache 影响

无；本包不修改模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **已加载历史** — 表格检查 Session 已加载窗口；更早记录需要分页。从实时流延续到持久化日志的行身份在窗口重建时保留，行离开窗口后释放。
- **Projection 控制帧** — 会话日志不展示 projection 控制流更新。
- **发布节奏** — 高亮跟随已发布的 Node 变化，不表示两次发布之间的每次内部修改。原始数据不脱敏。
- **大窗口成本** — 每次发布仍复制不可变的行引用数组，筛选和表格布局也会扫描已加载行。追加不会重新分组或创建历史行。展开普通对象字段或其他属性时会扫描全部自身键。
- **实时候选** — 类型候选刷新会重置键盘选中项，即使候选列表未改变；确认前需要重新选中或点击候选。
- **Chat DOM 依赖** — 定位和选取依赖现有 Slot/Chat 属性及可搜索折叠行为，要求被检查 Session 的 Chat 已显示在主区域；不会切换 View 或 Session、加载历史或渲染不存在的业务 Node。近似定位无法还原未渲染消息的精确位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
