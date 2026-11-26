# Agent Note: 包内分片之间的依赖

Status: implemented

[English](2026-11-26-package-local-chunk-dependencies.md) | 中文

## Problem

动态 Client 预设用 Rolldown 构建包的浏览器半侧，每个源码 `import()` 都会拆成一个 `client.<name>.js` 分片。Rolldown 还会把多个分片共用的代码，包括它的 CommonJS 辅助模块 `\0rolldown/runtime.js`，移进公共分片，用到这些代码的分片会同步 require 这些公共分片。[加载模型](2026-07-23-client-plugin-loading-model.zh.md)原先要求产物自包含：factory 的 `require` 只解析模块表请求，`require.async` 只加载一个分片。懒加载模块互相导入的包，例如嵌入其他语法的语法高亮模块，因此无法按 `import()` 拆分；入口只要和某个懒加载分片共用一个模块，运行时就会在同步的 `require("./client.<name>.js")` 上失败。

## Decision

同一个包的分片之间可以同步 require。分片依赖图通过两个 `deps` 列表交给[模块系统](../../../../packages/client/modules/README.zh.md)，两者承担的义务不同：

- **登记信息里的 `deps`**（`__ModuleLoader__.load({ id, chunk, deps, factory })`）是前提条件：列出 factory 同步 require 的同包分片（`./client.<name>.js`）。模块系统先下载并登记其中每个分片，以及它们各自 `deps` 的传递闭包，再运行这个 factory。[预设](../../../../packages/client/tsdown.client.ts)从 Rolldown 的 `RenderedChunk.imports` 写入该分片直接导入的分片，没有时省略该字段。
- **`require.async(spec, { deps })`** 是预取提示：列出与所请求分片并行下载的其他同包分片。预设按 `renderChunk` 的 `meta.chunks` 分片图算出所请求分片的同步传递闭包，去掉入口文件已携带的分片后写入；结果为空时保留单参数调用。缺少提示只会多花请求轮次，因为登记信息里的 `deps` 仍会逐层加载整组分片。请求其他包时忽略该选项。

预设把入口同步 require 的所有分片（传递闭包，依赖在前）移进入口文件，放在入口自己的登记之前，并删除它们各自的文件和 map。一个脚本本来就可以登记多个 factory，combo 批次就是这样，因此入口除了自己的脚本不需要别的请求。移动发生在 `generateBundle` 阶段、输入隔离检查完每个分片之后；入口 map 按插入的行数补上同样数量的空行，输出的 map 资源和内存中的分片 map 都会更新。静态或动态导入包入口的分片会让构建失败：模块系统以包 id 作为入口的键，没有相对路径能指向它。对入口文件携带的分片的动态导入保留 Rolldown 生成的、包在已完成 Promise 里的同步 `require`，因为入口文件在该包任何代码运行之前就登记了这个分片，也没有文件可下载。

在模块系统里，同步的 `require("./client.<name>.js")` 会物化已登记的同包分片，对未登记的分片抛错。图行到达时先登记入口脚本，再处理入口登记信息里的 `deps`；批次脚本可能在这一行自己的下载之前就登记了入口，所以已经登记过的入口也会执行这一步；这些分片下载期间所属包被失效时，到达过程从入口脚本重新开始。包内 `require.async` 会把提示中的分片与分片本身并行下载，并等这些下载结束后才运行分片或重试请求，因此旧代次的提示下载不会删掉重试登记的分片；分片本身只需要自己登记信息里的 `deps`（递归、并行），提示中的分片下载失败，只有被某个登记信息依赖时才会让请求失败。依赖失败时，要等同一批的其余到达全部结束才拒绝，无论是否带提示，拒绝信息都会带出要求该分片的登记链；到达过程中所属包被失效时，请求在新 revision 下重新开始；有环时每个分片只下载一次，在 factory 运行时失败，与模块表的环相同。不指向包内分片的 `deps` 项在登记和请求时都会被拒绝。

[`src/chunks.ts`](../../../../packages/client/modules/src/chunks.ts) 持有分片文件名规则，预设、Host 分片路由、模块系统和 WebWorker 打包器都从这里读取。[`publint-all`](../../../../scripts/publint-all.ts) 的发布闭包检查遇到已登记模块 factory 里文件未发布的 `require("./client.<name>.js")` 时，若同一目录下有脚本登记了包入口和该分片，就视为满足，因为被移入的分片已经没有单独文件；ESM `import` 等其他相对请求仍要求对应文件已发布。WebWorker 打包器把提示中的分片当作被请求的分片，它们同样移出基础镜像。其他包的值仍是由 Host 图组合的模块表请求；`deps` 从不指向其他包。

## Alternatives considered

**用 Rolldown 的拆分选项保持分片自包含。** 把共用模块强行放进每个导入它的分片，会让每个分片都带上它能到达的每个模块的私有副本。语法模块之间是图结构，副本会成倍增加，有状态的模块也会在每个分片里各有一份。

**用 Rolldown 分组把入口共用的模块留在入口分片里。** 懒加载分片随后会 require `./client.js`，而模块系统无法定位它；分组规则还要重复 Rolldown 的可达性分析。把已渲染的分片拼接起来，Rolldown 的分片图和每个登记都保持不变，只需一次 source map 偏移。

**入口的分片保留为单独文件，靠登记信息里的 `deps` 加载。** 每个有共用代码的包都会在启动时、入口运行之前至少多一轮请求。

**一个 `deps` 列表兼具两种含义。** 加载器若信任提示，构建端算错闭包就会变成运行时缺分片；加载器若把前提条件当作提示，请求不带提示时（例如一个分片请求另一个分片）factory 就会在依赖未到达时运行。

**在 `require` 内部等待依赖。** factory 的 `require` 是同步的；factory 形式的 CommonJS 无法等待，所以 factory 会 require 的每个分片都必须在它运行前登记。

## Consequences

- 带提示的懒加载分组一轮下载完；只靠登记信息里的 `deps` 时，每层依赖一轮。
- 入口文件会增加被移入的分片。启动时只登记它们；它们的 factory 仍在首次 `require` 时运行。
- 被移入的分片在入口 map 中没有源码映射，浏览器工具只显示其生成代码。
- HMR 替换期间，包失效后旧代码请求分片时会加载新 revision 的分片。如果该分片 require 的分片由新的入口文件携带，在新入口登记之前该请求会失败；加载器不针对 HMR 特别处理分片。
- 在本仓库之外构建的包必须为每个同步分片 require 写出登记信息里的 `deps`；提示是可选的。

## Testing

- [chunk-deps.client.spec.ts](../../../../packages/client/modules/tests/chunk-deps.client.spec.ts) 覆盖逐层到达、带提示时一轮下载、由同一脚本登记或在预加载登记后补齐的入口依赖、分片下载期间失效导致的入口到达重启、共用与成环的依赖、带或不带提示时的失败链、提示中无登记依赖的分片下载失败、失效后重新开始、重试前等待旧代次的提示下载及失败依赖的同批到达全部结束、失效后重新执行入口脚本、被拒绝的 `deps` 项，以及同步请求未登记分片。
- [client-bundle-chunk-deps.client.spec.ts](../../../../scripts/client-bundle-chunk-deps.client.spec.ts) 构建一个入口与懒加载分片共用模块和 CommonJS 包的夹具，断言被移入的登记、被删除的文件、登记信息里的 `deps`、提示、对入口携带分片的动态导入保持同步形式以及偏移后的 map，拒绝静态或动态导入入口的分片，并用真实模块系统运行写出的产物。
- [lazy-chunks.spec.ts](../../../../packages/experimental/webworker-packer/tests/lazy-chunks.spec.ts) 把带提示的分片移出 WebWorker 基础镜像。
- [publint-all.spec.ts](../../../../scripts/publint-all.spec.ts) 接受 factory 中由入口文件登记过的分片请求，拒绝只有分片文件登记、无处提供、或来自 ESM import 及 factory 之外代码的请求。
