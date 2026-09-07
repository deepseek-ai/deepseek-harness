# Agent Note: web client 的语法高亮——同步细粒度的 shiki

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-web-syntax-highlighting-shiki.md) | 中文

> 范围：web client 唯一的一套语法高亮体系——依赖裁决、单例形态、token 表约定与各消费表面。本篇是 PTC mode UI 堆叠 PR（Pull Request）链的第五个 PR；[chat 子调用行 Agent Note](../feature/2026-07-26-ptc-chat-subcall-rows.zh.md)交付了 `run_code` 程序正文，而本体系存在的意义正是让它可读。样式的基本规则由 [Web 样式体系裁决](2026-07-19-web-styling-system.zh.md)规定。

## 问题

client 过去把每一处代码表面——assistant 正文里的 markdown 围栏代码块、`run_code` 程序正文、details 面板的参数——一律渲染成不带高亮的等宽纯文本。本堆叠 PR 链的主要载荷是模型撰写的 TypeScript；未经高亮的程序扫读起来明显更吃力，而仓库已经在自家 VitePress 站点上交付经 shiki 高亮的代码，于是 web 应用成了唯一不带语法高亮的代码渲染表面。

## 决策

**采用同步细粒度形态的 shiki，作为 `ui-primitives` 里的一个单例，主题化完全经由 CSS 自定义属性完成。**

- **依赖**：`shiki/core` + `@shikijs/langs`，经 `createHighlighterCoreSync` 搭配 `createJavaScriptRegexEngine({ forgiving: true })` 组装——不带 oniguruma WASM、没有异步初始化、对 bundle 友好。语法（grammar）白名单：`typescript`（内嵌 JS）、`shellscript`、`json`——即 harness 实际会渲染的那几种语言；其余一律回退到几何完全一致的纯文本块，绝不报错。先例：VitePress 站点已经通过 shiki 渲染全部文档代码；而在 TypeScript（正是此处要紧的载荷）上，TextMate 语法实质性优于正则高亮器。
- **单例**：`ui-primitives/src/markdown/highlight.ts` 为每个 document 创建一个 `HighlighterCore`，并公开 `highlightToHtml(code, lang)`（undefined 即渲染为纯文本）。引擎加语法的构建是一次约 120-175ms 的长任务，因此模块在插件启动时用延迟任务预热单例（惰性路径保留为正确性兜底），把这笔开销挪出渲染路径——否则流式 finalize 交换的那一刻会卡顿。别名表用 `Map` 而非对象：fence 信息字符串由 assistant 撰写，诸如 `constructor` 这样的标签必须落空，而不是解析到继承属性并让 shiki 崩溃。共享的 `CodeBlock` 组件同时拥有两条分支；其 shiki 分支经 `dangerouslySetInnerHTML` 注入生成的 span 树——此用法获准，因为 shiki 输出的是从代码文本计算出的静态 span 树（不流经任何用户 HTML，没有脚本或事件处理器），这正是 shiki 自身文档载明的消费路径。
- **主题化**：shiki 的 `createCssVariablesTheme` 让每一种 token 颜色都经由 `--shiki-*` 自定义属性路由；取值本身住在 `ui-theme/styles/shiki.css` token 表里（亮色在 `:root`、暗色在 `body[data-ds-dark-theme]`——层叠方式与其余每张样式表相同），由 ui-theme 的动态客户端 entry 导入并编译进该插件持有的全局 CSS。组件 CSS 保持只用 token；任何颜色字面量都不进入 JS 或组件样式表。背景/前景以别名指向既有的 markdown 代码块 token，使高亮块与纯文本块彼此一致。
- **表面**：markdown 围栏代码块（`MarkdownText` 的 `pre` 组件把单字符串围栏路由到 `CodeBlock`）、`run_code` 展开后的程序正文（ToolRow 的 code 变体，`lang="typescript"`），以及 details 面板的 Input 参数（`lang="json"`）。工具输出从不做语法高亮——它是任意文本，硬猜一种语法，带来的误高亮会多于帮助；bash 卡片的输出只承载其自身 ANSI 序列声明的颜色，经由[终端卡片](../feature/2026-07-28-web-terminal-card.zh.md)渲染。

## 曾考虑的替代方案

**`rehype-highlight`/lowlight。** 屈居次选：天然同步，bundle 体积约为三分之一，但基于正则的语法在 TypeScript 上的保真度肉眼可见地更差，而且仓库将从此同时运行两套高亮体系（站点用 shiki、应用用 highlight.js）、维护两套主题化词汇。

**完整的 `shiki` bundle，或 oniguruma WASM 引擎。** 否决：完整 bundle 会带上每一种语法和主题；WASM 需要异步加载，而这正是同步的 client 启动刻意规避的。细粒度 core 加三种语法，让成本与实际用量成正比。

**在 worker 中高亮/异步高亮。** 否决：载荷都很小（程序、围栏代码块、参数）；同步 JS 引擎微秒级就能把它们 token 化，而异步会引入一段未高亮代码的闪现，外加渲染机制的扰动，却没有任何实测得出的需要。

## 后果

所有消费方共用同一个代码表面——未来的新表面导入 `CodeBlock` 即继承高亮、主题化与纯文本回退。bundle 的增量是 shiki core 加三种语法（在 `ui-primitives` 中一次性支付）。token 颜色是第一张 `--shiki-*` 表；注册别名覆写的主题包扩展它们的方式与扩展任何其他 token 无异。jsdom spec 锁定 token span 结构、别名解析、两条回退分支与围栏路由；既有的已构建 bundle 快照和浏览器 e2e 覆盖组装后的路径。
