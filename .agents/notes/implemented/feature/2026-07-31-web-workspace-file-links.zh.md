# Agent Note: 从 web UI 打开产出的文件

Status: implemented

[English](2026-07-31-web-workspace-file-links.md) | 中文

> 范围：完成的轮次以其产出文件收尾的那一行、读得出是链接的文件路径链接，以及 Host 打开器对浏览器可渲染文档优先选用默认浏览器。经决定不在范围内：以 HTTP 提供工作区文件，以及为不在 Host 机器上的客户端提供预览。

## 问题

一个产出了文件的 web 会话，没有办法看到那个文件。agent（智能体）写出了 `deepseek-homepage.html` 并如实告知，而用户唯一的办法是把 `/private/tmp/dsh-client-hotplug.ygPvsm/workspaces/plugin-hotplug/deepseek-homepage.html` 这样的绝对路径复制进终端。

这背后是两个不同的缺陷。transcript（文本记录）从不说明一个轮次产出了什么：`ToolCallView.locations`——文件工具早已填好的跟随文件词汇——在客户端没有任何消费方，因此读者对产出的唯一交代，就是收尾消息恰好拼出来的那点内容。而已经存在的那个交互是隐形的：`ToolRow` 早已把改写行或读取行的路径渲染成一个接到 `session/openWorkspacePath` 的真按钮，但它的样式与周围正文一模一样、只有悬停才有下划线，于是没人发现。所报告的「做完了打不开」，是一个可发现性失败叠在一项本就可用的能力之上。

## 决策

**完成的一轮以它产出的文件收尾。** 该行是独立插件 `@deepseek-ai/dsh-client-ui-deliverables`，注册进 chat 视图在收尾消息正文与其 IconActions 之间渲染的 `conversation.chat.turnTail` 空位——ui-conversation 拥有空位与 owner 通货（节点、收尾 seq、`openFile`），插件拥有全部策略。`producedForClosing` 从改写工具自身的跟随文件 `locations` 中读出路径——diff 卡片，或 `kind` 为 `edit` 的 generic 卡片（即 `str_replace_editor` 的 insert 所呈现的形状）——因此无论收尾消息是否点名，这一轮的产出都会被列出；新的改写工具靠声明自己做了什么加入，而不是靠被加进某张名单。read、删除与失败的调用不贡献任何条目；同一路径在一轮内按首见顺序只出现一次；累积在 turn 边界重置，因此一轮若先改写文件、随后没有正文内容就结束，不会溢进下一轮的行里。CSS 容器宽度档位会选择前六条路径中的一个前缀及其匹配的 `+ N 个文件` 标签，flexbox 则收缩可见的 basename 并用 ellipsis 省略；组件不执行 JavaScript 布局观察（[决策](../../archived/simplification/2026-09-01-css-produced-file-layout.md)）。cordis.yml 中的一行即可把该交互面组合进来或去掉；未注册的空位什么也不渲染。

**路径链接读得出是链接。** 静止状态下就带下划线，而不只在悬停时。这是本次改动中更小的那一半，却是修复中更大的那一半。

**打开仍然是 Host 的职责，并且优先选用默认浏览器。** `session/openWorkspacePath` 把路径交给操作系统，得到的是真实浏览器里的一份 `file://` 文档：页面能力完整，且够不到 `/api`——因为 `file://` 文档与它并不同源。在所报告的那份产物上实测：`localStorage` 可用、主题切换生效、tabs 可切换，而对 API 的 `fetch` 失败。对浏览器能渲染的文档——`.html`、`.htm`、`.xhtml`、`.svg`——平台能够确定默认浏览器时，打开器解析的是默认**浏览器**而非该类型的默认应用，因为把 `.html` 绑给编辑器的开发者，否则点开一个产出的页面得到的会是源码。macOS 读取 LaunchServices 的 `https` 处理程序，桌面 Linux 读取 `$BROWSER`；无法确定浏览器时，两者都会回退到默认应用。Windows 使用其注册的文件关联，WSL 则先转换路径，再使用同一 Windows 交接。存在隐藏文件时，**在文件夹中显示**会把 `.` 经由同一 owner `openFile` 传递；它只在 loopback 页面的当前 `host.describe.canOpenPath` 允许原生打开时出现。其他部署会省略它；桌面探测误报时可配置 `nativeOpen: false`。

**以 HTTP 提供工作区文件不在范围内，非本机客户端亦然。** 由 harness 自己提供文件——与 `/api` 同源、置于 `CSP: sandbox` 之后、或交给一个以自身端口给所服务文档独立源的第二监听器——随产品范围一并否决：不为「浏览器不在 Host 机器上」的场景提供预览，因此 Host 打开器完整回答受支持的场景，而那套 HTTP 机制只会回答不受支持的那个。

## 考虑过的替代方案

- **由 harness 提供 `/f/<sessionId>/<segments…>`**——已经实现并可用，包含双 `realpath` 路径约束、浏览器信任 fence、流式读取，以及一个以自身端口给所服务文档独立源的监听器。它是唯一能把预览呈现给另一台机器上客户端的设计，而那恰恰是被判出范围的场景。因此退役，而不是因为它失败了；它的代价是一个带自身生命周期的第二 socket、一个注入页面的端口，以及一份跨两个包共享的 URL 形状约定。
- **同源 HTTP 提供且不加隔离**——经实测不安全，记录在此以免有人重试：与 `/api` 并排提供的文档把 `settings.describe` 打到 `200` 并拿到完整数据，把 `session.list` 打到包含所有会话 transcript 的 35 KB，而这个页面根本不必由 agent 撰写（一条 read 行就让 clone 下来的仓库里任何文件变得可打开）。
- **在那套同源提供之上加 `Content-Security-Policy: sandbox`**——它以剥夺文档的源来堵住这个洞，而这经实测会破坏本功能存在的意义所在的那类页面：所报告的产物在加载时抛 `SecurityError`，又因为未捕获异常会中止其 `<script>` 的其余部分，该行之后声明的所有监听器——主题切换、移动端菜单、模型 tabs——统统不会绑定。报告者工作区里四份产物有两份在它之下是死页面，而且它们渲染得完美无缺，所以这种破坏是看不见的。
- **把路径在助手的收尾消息里链接化**——这是用户开口要的形状（「在结尾附上链接」），但它让渲染取决于模型是否把路径拼写得可识别。工具调用已经把 `locations` 作为结构化事实携带，产出文件行消费的正是它。
- **让文件 chip 横向滚动**——这样会把每个文件都留在 DOM 中，却使隐藏的尾部难以发现，在 transcript 内增加一层横向手势，也无法精确说明视口外还有什么。不滚动的 CSS 单行与按宽度选择的可见前缀既保留回答的纵向节奏，也明确呈现省略量。
- **桌面端外壳中的内嵌 WebView**——可得到的最强隔离，因为那时预览跑在产品自己拥有的容器里，而不是用户的浏览器里。它属于桌面端外壳自身的设计，而非本交互面，记录在此作为未来预览能力应走的方向。

## 后果

现有的每一处文件交互都同时改变了：write、edit、read 与通用单文件卡片都汇到 `openFile`，因此链接修复与浏览器优先策略无需逐行改动。组装层 Web 测试覆盖单行 CSS 溢出和单次点击的 Host 交接，且不会启动原生应用。产出的 `file://` 文档无法 `fetch` 同级文件（但 `<script src>`、`<img>` 和 CSS `@import` 可用），这是 HTTP 提供曾有、而此处没有的能力。远程客户端保留 chip，但省略文件夹操作；每个 chip 的 `title` 仍保留完整路径。Markdown 仍由平台的 `.md` 应用打开；产品内渲染属于另一项工作。
