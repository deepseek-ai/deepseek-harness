# Agent Note: Web 壳产物的分片拆分与目录布局

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-web-shell-dist-chunk-layout.md) | 中文

## Problem

apps/web 的壳此前打成单一约 1.2 MB（minified）的 index 分片，其中约八成是 vendor 字节——KaTeX、boot 语法与 shiki 引擎、react-dom、markdown 流水线——与全部 workspace 壳代码（约五分之一）熔在一起。任何一行壳代码改动都让整个 chunk 换哈希，再次访问的客户端全量重新下载；`dist/assets/` 是 100 多个文件的单层平铺（主分片、23 个懒加载语法 chunk、59 个 KaTeX 字体面、sourcemap 混居），无从导航。

## Decision

`apps/web/vite.config.ts` 以 `manualChunks` 把壳切成两个初始分片，并以输出命名函数归类目录；整套配置零正则——精确包名 Set、文件名清单、扩展名清单。

**成员归属**（`VENDOR_PACKAGES`，按精确 npm 包名）：

- `vendor` = 三个重渲染家族：math（katex）、highlight（shiki）、markdown（micromark/mdast 解析流水线——其上的增量 React 渲染器是 workspace 代码，不在此列）。成员以 `VENDOR_PACKAGES` 为活口径，清单 = workspace 代码**直接 import** 的包：其余私有传递依赖（oniguruma 系、@shikijs/core、字符表等数十个）只被清单成员引用，rollup 的分片着色自动将其并入 vendor；与 index 侧共享的依赖回落 index，只稀释几 KB，不构成正确性问题。
- **vendor 全员必须 react-free（边界不变量）**：rollup 会把入口与 manual chunk 共享的模块并入 manual chunk——清单里出现任何 import react/jsx-runtime 的包，唯一一份 react 副本就会被拽进 vendor、脱离 index。markdown/math 的 React 渲染侧是 workspace 代码，天然住 index，react 族因此全部钉在 index。
- `index`（默认分片）= react 族（react、react-dom、scheduler、use-sync-external-store）、vendored cordis、全部 workspace 代码及未列入的小件（anser、clsx）。
- `@shikijs/langs` 特判：boot 语法（`BOOT_GRAMMAR_FILES`：typescript、shellscript、json——highlight.ts 静态 import 的三件，均为零内部 import 的自含数据模块）进 vendor；其余 23 个懒加载语法不做指派，各自保持按需 chunk。
- `index.html` 由 vite 自动接线：index 走 `<script>`、vendor 走 `<link rel="modulepreload">`，两个分片并行拉取，无串行加载瀑布。

**目录布局**（`chunkFileNames` + `assetFileNames`）：

- `assets/` 根只留 index 与 vendor 的 js（含随行 sourcemap）与 css。
- 语法 chunk 归 `assets/langs/`。判据是 chunk 的 `moduleIds` 含 `@shikijs/langs` 成员，而非 facade：内嵌语法共享 chunk（php/ruby/mdx 内嵌 html+javascript，被 rollup 拆出共享）**没有 facade**，facade 判据会漏；index/vendor 按名排除，因 vendor 合法携带 boot 三语法。
- 字体归 `assets/fonts/`（`FONT_EXTENSIONS`：woff2/woff/ttf；所有已交付文件都是 vendor.css 引用的 KaTeX 字体面——katex.min.css 虽由 index 侧组件 import，css 模块同样经 manualChunks 归属、随 `katex` 落入 vendor.css；浏览器按需只拉 woff2，且仅在公式渲染时）。
- sourcemap 无需安排：rollup 把 `.map` 写在各自 js 旁并以裸相对文件名引用，分片挪目录时 map 自动跟随。

跨目录引用（index 的动态 import 指向 `langs/`、语法 chunk 间同目录相对引用、vendor.css 相对引用 `fonts/`）均由构建器生成，运行时零配套改动；host 侧 webserver 按静态前缀原样服务嵌套路径。

## Alternatives considered

- **react 等 vendor 走 CDN**：dsh web 面向本机/内网主机（常无外网），CDN 直接不可用；react 是全部插件 bundle 的 platform seed external（壳是唯一供给方），改 CDN 全局变量形态需牵动 platform 清单/seed/模块表三处；缓存收益由 vendor 切分即可取得。
- **反向兜底规则（node_modules 除 react 族全归 vendor）**：成员从配置上读不出来，且把 anser/clsx 类小件错归 vendor；被正向精确包名清单取代。
- **正则家族匹配**：可读性差；精确包名 + rollup 对传递依赖的自动着色使模式匹配没有必要。
- **以 facadeModuleId 识别语法 chunk**：无 facade 的内嵌语法共享 chunk 会漏检落回根目录；`moduleIds` 成员判据覆盖两种形态。
- **在 vendor 里收留带 react 边的渲染门面**（历史上的 react-markdown 属此类）：会经 rollup 的共享模块归并把唯一 react 副本拽进 vendor，破坏「react 归 index」的边界；该约束已成文为清单的边界不变量。
- **KaTeX 整体懒加载、boot TypeScript 语法转懒**：会改变首帧渲染行为（公式/首个代码块的回退），是独立于产物布局的取舍，另行决策。

## Verification

审计工具随库：`node scripts/attribute-chunk-bytes.mjs <chunk.js>`（零依赖 sourcemap VLQ 字节归属，按 npm 包/workspace 目录聚合）。以其复核：vendor 不含任何 workspace 字节、react 族（含 react/jsx-runtime）全量位于 index、index 的 npm 侧仅剩 react 族与 anser/clsx；懒语法 chunk 数量与 `LAZY_GRAMMARS` 表一一对应；浏览器 keyless replay 用例与改动前基线逐字一致（特定于本机环境的报红除外），双分片壳装载渲染无回归。

## Consequences

- 壳代码改动只重哈希 index（约为产物三分之一）；vendor（约三分之二）跨壳版本缓存稳定，仅依赖升级时失效。
- `dist/assets/` 可导航：根两对 js/css，`langs/` 按需语法，`fonts/` 字体。
- 维护成本：workspace 代码新增对某渲染家族门面包的直接 import 时需同步 `VENDOR_PACKAGES`（漏列仅稀释 index，不致坏）；在 highlight.ts 扩 boot 语法集而未同步 `BOOT_GRAMMAR_FILES` 时，该语法静默落入 index，仅产物审计可见。
- webserver 静态面尚无压缩，gzip 体积收益仍有待实现；传输层压缩是另一项独立决策。
