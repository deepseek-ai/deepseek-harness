# Agent Note: Preset health resolves the rows it can prove will start

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-preset-health-resolves-rows.md) | 中文

## Problem

名单列为健康的 preset，仍可能根本无法组装。发现过程的健康检查只证明组装能以加载器方言解析、由具名行组成，并刻意止步于此——它不解析任何插件名，也不应用任何配置。

本 note 部分取代了[损坏的 preset 是名单行](../bug-fix/2026-08-09-broken-preset-roster-rows.zh.md)：那份 note 在 Alternatives 中否决的「深度校验」正是这里落地的做法，而且原因也已移出卡片正面；它同时放宽了[插件自带内置 preset 根](../bug-fix/2026-08-20-plugin-owned-shipped-preset-root.zh.md)记录的随附名单断言。两份都已就地更新。

但 `broken` 是承重的，不是卡片上的装饰。`presetOptions` 会把损坏的行从会话选择器里滤掉，好让选择的人不必等到会话启动失败才发现；`resolveMountable` 会在花费一次挂载之前拒绝它。因此下游一切都把「不是 broken」读作「能组装」。

这个缺口在[仓库命名契约](2026-08-11-repository-naming-contract-and-rename-ledger.zh.md)按预发布立场重命名包时暴露出来。仓库内的引用随之更新；写在 `<dshHome>/.agent-presets` 下的 preset 没有，于是引用 `@deepseek-ai/dsh-workspace-context` 的那一个保住了健康的卡片、保住了在选择器里的位置，直到有人切换过去才失败。引用了被后续版本改名或卸载的包，正是手写 preset 真正的腐化方式，而它恰好是这项检查排除掉的那一类。

而它真正产出的失败，说得比它知道的还少。加载器的逐行包装构造一个普通 `Error`，其 message 以 `cause.message` 结尾，cause 只留在 `error.cause` 上。于是一个有两行失败的 group，抵达时是一行被包装的行，message 为 `failed to apply loader entry <group> (cordis:group): loader entries failed to apply`，两条真正的原因只能经由 `cause.errors` 取得。挂载诊断只展平 `AggregateError.errors`，从不跟随 `cause`，因此它停在那一行，一行都没点名。

## Decision

**发现过程解析每一行它能证明会启动的行，且不 import 任何东西。** 解析这一趟跑在 `packages/preset/agent-presets/src/discovery.ts` 的形状检查之后，因此格式错误的组装仍然回答形状原因。包名先在磁盘上查——就是 Node 自己那套向上走 `node_modules`、停在 `<包>/package.json` 的做法。preset 相对路径与绝对路径改用 stat，因为对这两类 `import.meta.resolve` 只做 URL 拼接，否则一个丢失了自带文件的 preset 会蒙混过关。两条路都不求值。

用磁盘查找而不是 `import.meta.resolve`，有两个理由。它便宜：只要注册了 ESM loader hook，每一次解析器调用就变成一次到 hooks 线程的同步往返，在源码启动所用的 `tsx` hook 下实测命中 2ms、未命中 5ms，而裸 Node 分别是 0.055ms 与 0.032ms——每次名单读取要背上 238ms 的解析器时间，而同样这 135 行磁盘走法只要 0.7ms。它也是唯一问得到「宿主」的：`import.meta.resolve` 的 `parentURL` 参数只在 `--experimental-import-meta-resolve` 下生效，而没有任何启动方式传它，因此它是相对调用方模块解析的，回答的是关于本包而不是关于部署的问题。真正认显式 parent 的是 Loader 的内部解析器，而它的 `resolveSync` 在 Node 22 与 24 上签名不同。Node 内建模块在磁盘查找之前直接短路。

磁盘走法放弃了什么：只有经由 loader hook 才能解析的包——import map，或根本没有 `node_modules` 的目录树——会被报为损坏。任何受支持的安装都不会产出这种情况，因为 `dsh plugin install` 会把每个插件装在名单旁边。

**只有一个分类器决定一行在哪里解析。** `src/specifier.ts` 拥有这个划分——`cordis:` 内建、preset 相对、绝对文件、包名——挂载的 import 覆写与发现过程的检查都读它。若发现过程按一个基准解析、而挂载按另一个基准 import，那一行会被报告为健康，然后加载失败。

**可能永远不会启动的行被跳过。** `disabled` 是[加载器唯一会插值](2026-08-11-loader-entry-disabled-interpolation.zh.md)的条目字段：`!!js` 表达式在挂载时对加载器上下文求值，而发现过程无法仅凭文件做到。凡该字段不是缺失、null 或 `false` 的行都不做检查，被禁用的 group 连同其子行一起跳过。每个随附 preset 都用这种方式为 shell 行设门，所以这是常见形状，不是边角。

**harness base 是必填参数。** `discoverPresets(roots, harnessBase)` 与 `scanRoot(root, harnessBase)` 都接收它；`AgentPresets` 在构造函数里读一次 `ctx.baseUrl`，缺失就抛。基准正是让这个问题可回答的前提——同一个包名从 preset 自己的目录解析会失败、从已安装的 harness 解析会成功——所以做成可选就等于悄悄恢复这项检查要终结的那个状态。

**挂载诊断跟随携带信息多于自身 message 的 cause。** `mountDetail` 从 `AggregateError.errors` 取分支，或在 cause 是 `AggregateError` 时从 `error.cause.errors` 取；普通的 cause 链已被展平进 message，不再跟随，否则每一行都会打印两遍。嵌套分支在拥有它的那一行下缩进。

**客户端把原因放到徽标上。** 卡片正面保留 preset 自己的描述，因为在那里一个包说明符不足以让选择的人采取行动。宿主给出的原因在悬停徽标或聚焦卡片时展开，另有一个视觉隐藏的 `role="alert"` 节点负责朗读。损坏的卡片用 `aria-disabled` 而非 `disabled` 表达这件事，并在自己的处理函数里拒绝这次选择：`disabled` 会把它移出 tab 序列，而原因已不在正面，那等于让不用指针的人完全够不到它。

**被拒绝的切换要在被拒绝的地方说明原因。** chip 的标签会弹回会话仍在运行的那个 preset，因此不说话的话，这次选择看起来就像根本没发生。它经由共享的 `Toast` 在 composer 列上方自报，与旁边的模型选择器报告被拒绝的选择方式一致。只有人刚做出的选择会被自报——应用器在会话成为当前会话时也会运行，为那种情况弹横幅等于报告一个没人问过的拒绝。横幅停留八秒而非 primitive 默认的三秒，因为它承载的原因要点名包与行；`Toast` 为此获得了 `holdMs`，顺带也消除了「停留常量必须由人手与样式表保持同步」这一隐患。

线上本来就把这需要的两段文本分开了：`message` 把原因裹进名单自己的「preset X failed to mount」框架，而 `details.reason` 只保留原因本身。自己会点名 preset 的表面取后者，否则会把 preset 说两遍。

## Alternatives considered

**在选中 preset 时检查，而不是在列出名单时。** 否决。选择器在任何人选中之前就按 `broken` 过滤，因此只在选中时检查的 preset 仍会被摆出来，报出的失败仍在点击之后到达——原本的抱怨只是换了个位置。名单行才是每个消费者已经在读判定的地方。

**让 base 可选，没有它就跳过检查。** 否决。它的失败模式正是要修的这个 bug，而且不带任何信号：无法组装的 preset 顶着健康卡片。`ctx.baseUrl` 在任何作用域上下文派生之前就设在根上，因此这个抛出是对「不会发生的事」的断言，而不是一条有运行时代价的分支。

**import 每一行而不是解析它。** 否决。import 会在每次读取名单时执行模块顶层代码，这是选择器不该有的副作用，而且那是挂载的职责——在 apply 时抛错、或永远等待某个服务的插件仍按设计在第一个会话处失败。

**每一行都交给 `import.meta.resolve` 解析。** 先这样发出去，实测后回退：它是对的，但每次名单读取要 445ms，而客户端并发的三次读取把它放大成每次 2.45 秒——设置分区肉眼可见地卡住。解析器确实是「什么能 import」的权威，但为明摆着装好的行去问它，等于为每一行付一次 hooks 线程往返。

**把整个 `compositionProblem` 缓存在已有的 `CompositionStamp` 上。** 作为省开销的手段被否决：它只能让重复读取免费，每个被编辑过的组装的第一次读取仍是全价；而且它把解析结果挂在组装文件上，可安装状态变化时组装文件并不会变。改用磁盘查找直接消掉了开销，于是没有什么还需要这个 stamp。

**把切换失败送到名单卡片上，而不是弹横幅。** 否决：卡片恰恰是那些能走到挂载的失败看不见的地方。所有行都能解析的组装会被报告为健康，于是「去设置页看原因」指向的是一张写着「这个 preset 没问题」的卡片。

**只报第一个无法解析的行，与形状检查保持一致。** 否决。解析失败会连锁，所以在那里只点名一个是诚实的；无法解析的名字是彼此独立、一次即可全部知晓的事实，而一次重载只修一个才是可以避免的部分。

**在 `mountDetail` 里无条件跟随 `error.cause`。** 否决。加载器的包装已经把 `cause.message` 追加进它构造的 message，因此普通链会把每一行渲染两遍。`AggregateError` 类型的 cause 是唯一被 message 丢掉细节的形状。

**继续把原因渲染在卡片正面。** 否决。原因里是包说明符和路径，把它们摆在 preset 描述的位置，等于用选择者需要的东西换取修复者需要的东西——而修复者需要的那份，无论如何都只隔一次悬停。

**复用图标行的 `data-tip` 伪元素来做提示条。** 实测后否决：生成内容会并入元素的可访问文本，因此卡片的 aria 快照多出一份 alert 已经携带的原因的逐字副本。改用真实的 `aria-hidden` 元素后，可访问副本恰好只有一份——而且既有那条提示条是为图标标签准备的单行 `nowrap`，这一条要逐行列出包说明符。

**把徽标本身做成可聚焦控件。** 否决：徽标位于卡片自身的 `<button>` 内部，在那里放可聚焦触发器意味着改造卡片头部结构。用 `aria-disabled` 让卡片保持可聚焦，同一次按键就能展开同一条提示条，且不改动任何布局。「原因只用指针可达」同样被否决——这次改动之前它无需任何交互就可见，因此把它藏到悬停之后，对用键盘阅读的人是退化，而不是一条本就不存在的路径。

## Consequences

引用了被改名或卸载掉的包的 preset，会在名单上被标出、在花费挂载之前被拒绝、并从选择器里剔除——与幽灵目录早已得到的待遇一致。原因会点名每一个出问题的行；而活到挂载阶段的失败，会点名 group 内的每一行，而不只是 group 本身。

健康依据的是「装没装」，而不是「能不能 import」：包在、但导出指向的文件不在，仍会报告健康并仍在挂载时失败。这是安全的方向——漏报只是退回先前的行为，而误报会让一个可用的 preset 变得不可选——而且它让答案不依赖于任何单个包的构建状态。不过源码检出仍不是已安装宿主，因为随附行引用的是部署与名单装在一起的包：`shipped-root.spec.ts` 断言随附 preset 除未解析行之外不携带其他原因，而不是不携带任何原因。挂载夹具改为引用一个能加载、随后拒绝的模块，因为引用不存在文件的夹具已经到不了挂载。

挂载失败现在在它发生的地方就可读，这对健康永远抓不到的那类失败最要紧：能解析、随后拒绝的行在名单上永远显示健康，因此这条横幅不是卡片之外的一份便利——它是那类失败在任何地方唯一的交代。

在 web 应用中对十一个 preset 的名单实测：`agentPreset.list` 冷启动 14ms、之后 6–8ms，客户端开场并发的三次读取合计 9ms wall。在每一行都过解析器的版本里，同样这三次读取各要 2.45 秒。

`@deepseek-ai/cordis-plugin-group` 成为 `dsh-agent-presets` 的 devDependency：挂载夹具现在像真实 preset 那样经由 `cordis:group` 组装，而工作区之外的 preset 无法按名解析该包，所以应用把它注册为内建，夹具 harness 也照做。
