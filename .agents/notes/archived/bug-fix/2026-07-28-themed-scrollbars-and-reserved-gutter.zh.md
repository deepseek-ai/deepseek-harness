# Agent Note: 滚动条 token 有了消费方，工作区列表预留出滚动条空位

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-themed-scrollbars-and-reserved-gutter.md) | 中文

## 问题

`design-platform.css` 在亮色与暗色两套调色板中都声明了四个 `--dsw-alias-scrollbar-*` token（`bg-l1`、`bg-l2`、`hover-l1`、`hover-l2`），而客户端里没有任何一条规则读取它们。定义了却无人消费的 token 构不成主题：所有滚动区域渲染的都是浏览器自带的滚动条，它对调色板一无所知，因此暗色主题下暗色表面上出现的是一条亮色的原生滚动条。

暴露这一缺口的可见症状出在别处。工作区浏览器的会话列表（`WorkspaceBrowser.module.css` 中的 `.list`）是侧边栏里唯一的滚动区域，而每一行的尾部内容都紧贴该行 8px 的右内边距——`rows/Rows.module.css` 中的 `.time` 取 `flex: none`，hover 时取代它的操作按钮也是如此。于是覆盖式滚动条会画在相对时间戳之上。只在这一个列表里预留空间，滚动条本身仍然没有主题，因此两部分合为一次变更。

## 决策

`packages/client/ui-theme/src/styles/scrollbar.css` 是这四个 token 的唯一消费方，也是 ui-theme 动态客户端 entry 导入的第三张全局样式表。它排在 `design-platform.css` 之后，因为它读取那张样式表的 token；两者都会编译进 ui-theme 持有的客户端 bundle。

规则挂在 `body` 上，而非 `html`。`design-platform.css` 在 `body` 上声明 `--dsw-alias-*` token，暗色覆盖挂在 `body[data-ds-dark-theme]` 上，而自定义属性只向下继承；挂在 `html` 上的规则会把它们解析为 guaranteed-invalid 值，此时 `scrollbar-color` 计算为 `auto`，主题完全不起作用。

`scrollbar-width` 与 `scrollbar-color` 声明在 `body, body *` 上，而不是只在顶层声明一次。继承传下去的是已经在 `body` 处代入完成的颜色值，因此后代元素重新绑定这层间接变量也无法改变自己的滚动条；逐元素重新声明使每个元素按它自己看到的取值代入变量。`scrollbar-width` 本身就不是可继承属性，无论如何都需要逐元素声明。`::-webkit-scrollbar*` 伪元素同样不继承，因此以不加限定的选择器匹配。

两种渲染互斥，而这种互斥是被强制的，不是假定的。`scrollbar-width` 或 `scrollbar-color` 只要取非 `auto` 值，Chromium 与 Safari 就会丢弃该元素上的全部 `::-webkit-scrollbar*` 规则，`::-webkit-scrollbar-thumb:hover` 也在其中。因此无条件地同时声明会让 hover token 在任何地方都得不到渲染：实现了 hover 伪元素的引擎，恰恰就是被标准属性静音的那些，而 Firefox 没有 hover 伪元素可作退路。于是标准属性写在 `@supports not selector(::-webkit-scrollbar)` 之内，该条件只在伪元素未被实现处为真，因此 Firefox 走标准属性路径，WebKit 系引擎走伪元素路径。WebKit 规则不再反向加门禁：不实现这些伪元素的引擎会把它们当作未知选择器丢弃，因此加门禁只是重述选择器匹配本身已经做的事。对于旧到不支持 `selector()` 函数的引擎，该条件无效，从而求值为假并选中伪元素路径——对于这条判断下现实存在的 16.4 之前的 Safari，这正是正确的一侧。

两条路径都读取同一组间接变量 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover`，它们在 `body` 上绑定到 l1（基础表面）token。**这就是重新绑定约定，也是单看 CSS 无法得知的部分**：抬升表面在自己的容器上设置 `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` 与 `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)`，这一次重新绑定同时作用于标准属性和 WebKit 伪元素。这组变量必须成对重新绑定；只改静止态滑块会让 hover 状态仍留在基础表面的 token 上。这组变量另一个合法的目标是 `transparent`，它随侧边栏滚动条[改为跟随指针](../feature/2026-08-04-pointer-revealed-sidebar-scrollbars.zh.md)一并引入；下文的门禁只接受这两种目标。可由机械检查发现的子集归 `packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts` 所有：任何既滚动又绘制抬升表面的样式表都必须重新绑定，因此本 note 不再维护完整的表面清单。多数把这组变量声明在抬升卡片上而非滚动的后代元素上，因为抬升层级属于这个表面，而自定义属性会继承到真正滚动的那个子元素。

`Menu`、`InputBar`、`QuestionComposer` 与 `TodoPanel` 这四个表面最初被漏掉，因此逐样式表的重新绑定约定由机械检查而非人工审阅把关。

抬升表面集合是从调色板自身的暗色抬升阶梯解析出来的——暗色取值落在 `bg-layer-2` 或 `bg-layer-3` 上的那些表面 token，而这一档正是 l1/l2 之分所编码的层级差。最初的做法是从已经做了重新绑定的样式表反向推导，那是不成立的：这样得到的集合只能确认别人已经记得的部分，而尚无人重新绑定的表面——恰恰就是这项检查存在的理由——会把自己定义成「非抬升」。`--dsw-specific-tip` 证明了这一点：它解析到与菜单表面相同的那一档，待办面板在它上面滚动却没有重新绑定，而推导式的检查依然是绿的。

判定范围依据 token 家族而非几何形状：只有 `--dsw-alias-bg-*` 与 `--dsw-specific-*` 表述的是表面。`--dsw-alias-button-*`、`--dsw-alias-interactive-*` 与 `--dsw-alias-markdown-*` 会落到相同档位，但它们表述的是控件或行内片段，没有任何滚动容器会把滚动条画在它们之上。形状无法做这个判断，因为悬浮按钮本来就会带圆角、阴影和固定尺寸。这项检查以样式表为粒度而非以规则为粒度，因为卡片与真正滚动的后代元素是两条不同的规则。这种近似检查无法检测嵌在由另一个包的样式表绘制的抬升卡片中的滚动组件，`Modal` 内的 `DirectoryBrowser` 就证明了这一点；跨样式表的组合仍需在评审和组装后 UI 层面把关。

轨道与两条滚动条相交的角落保持透明，因此滑块是以其下滚动的任何表面为背景被看到；只有滑块及其 hover 状态带 token 颜色。

`.list` 声明 `scrollbar-gutter: stable`，使滚动条位于行的旁边而非行的上方。取 `stable` 而非 `auto`，因为 `auto` 只在列表确实溢出时才预留空位：那样展开一个工作区分组时，所有行会在列表开始滚动的那一刻发生水平位移。`stable` 的预留是无条件的，行不会移动。

面对覆盖式滚动条——也就是这个症状唯一存在的那种形态——空位声明与样式表里的 `::-webkit-scrollbar` 宽度是共同必要的。在运行中的应用上实测：保留其中一条、从活的层叠中删掉另一条，任意一次单独删除都会让列表的条带从 8 降到 0。空位声明表述的是「要预留空间」，而伪元素宽度才是让 chromium 把滚动条视为占据布局空间、而不是浮在内容之上的原因。因此对这个 bug 而言，本次变更的两半都不是可选项，这也是两半必须一起交付的第二个理由。

## 曾考虑的替代方案

**在每个滚动组件的样式表里各写一份 `::-webkit-scrollbar` 规则。** 之所以否决：客户端共有分布在九个包中的十三个滚动容器，每一个都要带上同一段规则，而第十四个会在没有任何门禁报错的情况下漏掉主题。由设计 token 驱动的皮肤应当归属于拥有这些 token 的包。

**提供一个工具类，由各滚动容器自行加上。** 重复同样被消除，但失败方式依旧存在：新的滚动容器只有在作者记得加类名时才有主题，而遗漏在评审中看不出来。`body, body *` 这种写法没有需要记住的启用步骤；确实想要不同滚动条的容器可以覆盖间接变量，这与抬升表面使用的机制相同。

**把这两个属性绑定在 `html` 上。** 这是文档级皮肤最自然的落点，而它的失败是可测量的：规则挂在 `html` 上时，chromium 中滚动容器计算出的 `scrollbar-color` 为 `auto`，因为别名 token 在那个作用域内不存在。

**只声明一次，靠继承下传。** 匹配的元素更少，但它破坏重新绑定约定——继承携带的是代入后的颜色，而不是变量引用，因此抬升表面无法给自己的滚动条换色。它本身也不完整，因为 `scrollbar-width` 不继承。

**不加 `@supports` 门禁，无条件同时声明标准属性与伪元素。** 在 chromium 中于带 `scrollbar-gutter: stable`（使条带可观测）的探针元素上实测：单独一条 8px 的 `::-webkit-scrollbar` 预留出 30px 条带（样式表指定的宽度加上浏览器自带的按钮），而给同一元素加上 `scrollbar-width: thin` 后降到 `thin` 所预留的 10px——说明伪元素规则是被丢弃，而不是被合并。全部 `::-webkit-scrollbar-thumb:hover` 规则随之失效，因此两个 hover token 与四处抬升表面的 hover 重新绑定，在多数用户实际使用的引擎上都是死代码。

**给 WebKit 规则也加门禁，写成 `@supports selector(::-webkit-scrollbar)`。** 读起来对称，但在一个方向上是错的：它会对「实现了伪元素但不支持 `selector()`」的引擎隐藏这些规则，而那正是不加门禁时能被正确服务的 16.4 之前的 Safari。未知选择器本就会被丢弃，因此这道门禁不提供任何能抵偿该代价的保护。

**改用内边距而不是预留空位（给 `.list` 加右内边距，或把 `.time` 向内移）。** 之所以否决：内边距无论滚动条是否存在都生效，因此在常见的短列表情形下白白占用横向空间；而且它只修好一个容器，其余每个滚动区域的内容仍然压在滚动条之下。

**给 `.list` 用 `scrollbar-gutter: auto`。** 空位在列表溢出时出现，也就是滚动条存在的时候。之所以否决：侧边栏的列表会随分组展开与收起而伸缩，因此空位会在用户光标之下出现又消失，并带动行一起位移。

## 后果

- 客户端的每个滚动容器都绘制带主题的滑块：亮色基础表面为 `rgb(229, 229, 229)`，暗色基础表面为 `rgb(60, 60, 61)`，重新绑定到 l2 的暗色抬升表面为 `rgb(84, 85, 87)`。侧边栏内的滚动区域经由同一组间接变量，只在指针到达时才绘制滑块。
- 两种渲染分别指定，因此改动滑块的几何或 hover 行为需要改两处：一处在 `scrollbar-width`／`scrollbar-color`，一处在伪元素。让两者都经由这组间接变量，把这份重复限制在 Firefox 与 WebKit 不共用的那些属性上。
- hover token（`--dsw-alias-scrollbar-hover-l1`／`-l2`）只在伪元素路径上渲染。Firefox 通过 `scrollbar-color` 只表述一个滑块颜色，其 hover 表现由引擎自行推导，因此对 hover 颜色的设计改动在 Chromium 与 Safari 上可见，在 Firefox 上不可见。这是 `scrollbar-color` 本身的限制，不是这张样式表的限制。
- `body *` 匹配所有元素，涉及的两个属性其效果本就被浏览器限制在实际会滚动的元素上。代价是一个覆盖面很宽的选择器；另一种选择是一个不生效的重新绑定约定。
- 工作区列表在任何列表长度下都永久少了预留空位那一条宽度。这正是该修复换来的代价：以稳定的行几何，换掉只在列表较短时才可读的时间戳。
- 调色板中没有轨道 token，因此日后若设计需要不透明轨道，要新增一个别名 token，而不是在这张样式表里写字面颜色。

## 测试

三份单元测试读取磁盘上的 CSS 文本。`ui-theme/tests/scrollbar-styles.spec.ts` 从 `design-platform.css` 中扫描出滚动条 token 集合，而不是把它写死，因此新增、重命名或删除 token 时断言会随之变化；它检查每个 token 都有消费方，且每处抬升表面重新绑定的都是完整的一对。它还以源码偏移量锁定两条路径的划分：标准属性在门禁块之内，`::-webkit-scrollbar*` 规则与每一处对 hover 间接变量的读取都在门禁块之外。这个划分必须用偏移量断言，因为该测试文件的规则解析器会把 at-rule 拉平，所以删掉门禁或把某条声明移到门禁另一侧，文件里其余全部断言仍然是绿的。

`apps/web/tests/sidebar-scrollbar.e2e.ts` 覆盖只有真实渲染引擎才能报告的事实：预留条带的宽度，以及引擎实际走的是哪条渲染路径。它不需要任何模型调用——列表只要溢出即可——因此以只读方式复用一份既有的已提交 fixture（测试前置数据）来铺入冷会话。

这个场景还提交了一份 golden（期望产物）`snapshots/sidebar-scrollbar/geometry.expected.md`，记录两套调色板下解析后的滚动条样式与几何。其余 web 场景提交的 aria golden 承载不了纯 CSS 的改动：它不改变任何 DOM、也不改变任何无障碍名称，因此有无这次改动，它们规范化后的树都是逐字节相同的。改为记录解析后的取值，就让滑块颜色、条带宽度或渲染路径的意外变化成为可评审的 diff，而不是一条需要人去推敲的阈值断言。绝对坐标被特意排除——`timeRight` 与两条边缘取决于侧边栏排版后的宽度和字体度量，把它们提交进去会得到一份需要按平台重新录制的 fixture，那记录的是平台而不是这次改动。真正记录下来的是条带、重叠量与两个先后关系，每一项都是差值或比较，因此只要预留仍然成立，任何排版下都不变。

在构建产物客户端上于 headless chromium 中读取计算值确认，这正是区分「token 链真正生效」与「语法合法」的手段：滚动容器在两套调色板下分别计算出 l1 的滑块颜色，而重新绑定间接变量的容器计算出 l2 的颜色，证明重新绑定作用到了计算值，而不只是作用到自定义属性上。Firefox 的标准属性路径以同样方式做了验证，包含 `scrollbar-color` 上从 l1 到 l2 的重新绑定；headless Firefox 对任何元素（无论是否被样式命中）都报告 `scrollbar-width: none`，这是 headless 的产物，不是这张样式表造成的。

chromium 上有两处测量限制决定了 e2e 能断言什么。门禁使 chromium 报告的 `scrollbar-width` 与 `scrollbar-color` 都是 `auto`，因此代入后的 `scrollbar-color` 不再是可观测量——e2e 特意断言这个 `auto` 读数，因为此处出现具体值就意味着门禁泄漏、伪元素被静音。另外，`getComputedStyle(el, '::-webkit-scrollbar-thumb')` 会把 `::-webkit-scrollbar-thumb:hover` 规则一并折算进去，因此它在静止态就报告 hover 颜色，两种状态都锁不住；这一点由在运行中的页面里用 `CSSStyleSheet.deleteRule` 删掉 hover 规则得证——同一查询随之从 hover 颜色翻转为静止态颜色。因此 e2e 改为读取那组间接变量在列表上代入后的静止态与 hover 颜色（每个变量用一个一次性探针元素，因为 `getComputedStyle` 返回的是活的声明对象，复用探针只会报告最后一次读到的值），并把 hover 声明当作规则文本从层叠中读出。

门禁本身在它起作用的层面有反向对照：把样式表中的 `@supports` 包裹去掉、重新 `build:web`、再跑 e2e，`scrollbar-width: auto` 那条断言会以 `thin` 变红，而这正是门禁存在所要阻止的那种静音。

headless chromium 绘制的是覆盖式滚动条，而这恰好就是被报告症状存在的那种形态，因此这个 e2e 复现的是这个 bug 本身，而不是它的近似：在干净的 master 上，列表条带为 0，滚动条盖住相对时间 7px。其中预留空位不会缩小 `clientWidth`，因此把时间元素右边缘与内容区右边缘做比较的断言在有无预留的两种状态下都成立，它的通过或失败取决于平台的滚动条样式，而不是取决于被测的那条声明。真正能区分两种状态的两个量是 `offsetWidth - clientWidth` 条带，以及以滚动条自身宽度为基准量出的重叠量 `timeCoveredBy`。

两者都要断言，因为各自捕捉的是不同的回归；这一点通过每次只改动一条声明、并把同一个测试里的其余断言静音来确定。只删掉空位声明时 `timeCoveredBy` 仍为 0——此时滚动条是 8px，而行的右内边距也是 8px，于是它紧贴时间戳但并未盖住——失败的是条带那条断言。再把伪元素宽度也删掉（这才是 master 的真实状态）才会产生重叠，此时 `timeCoveredBy` 以 7 变红。在 xvfb 下的有头运行无论哪种状态都看不到这个症状，因为 chromium 在那里画的是经典占位滚动条，`clientWidth` 本来就已经把它排除了。

验证浏览器可见的插件 CSS 需要一次 `pnpm run build:web` 并不执行的重建。`WorkspaceBrowser.module.css` 从不进入 `apps/web/dist`：ui-workspace 以运行时插件方式加载，其 CSS 内联进 `packages/client/ui-workspace/lib/client.js`，由该包自己的 `bundle` 脚本构建。因此只重跑 `build:web` 的反向对照实际测的是旧产物，去掉声明后仍会通过，看起来像测试无效，实际是对照无效。正确做法是先 `pnpm --filter @deepseek-ai/dsh-client-ui-workspace run bundle`，用 grep 在 `lib/client.js` 中确认该声明确实存在或消失，然后再 `build:web`。

`test:web` 原先只运行 `build:web`，因此任何滚动区域或插件 CSS 的改动都会碰到这个陷阱；现在它先运行 `build`，而 `build` 覆盖 `packages/*/*`，从而会重建各插件产物。`check-all` 本来就把 `build` 排在 `build:web` 之前，所以 CI 从未受影响——受影响的只有本地脚本，而这恰恰是「产物过期却通过」最容易被当真的地方。
