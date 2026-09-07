# Agent Note: 独立的 Events 兜底扫描补上 Cordis 表面完备性缺口

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-cordis-event-walk-backstop.md) | 中文

## 问题

`gen-cordis-catalog` 渲染 Typert host face 投影发现的每个服务与事件，fail-closed 的页面映射（`SERVICE_PAGE`、`EVENT_SCOPE_PAGE`）保证每个被发现的 key 或 scope 恰好落在一个 `docs/subsystems/` 页面上（页面区块机制归[按子系统区块决定](../process/2026-07-28-per-subsystem-cordis-surface-regions.zh.md)所有）。但"发现"本身此前只对服务有兜底：一条独立的 AST 扫描读取每个 `declare module 'cordis'` Context merge，要求每个声明的 key 要么被渲染、要么在 `SERVICE_WALK_EXEMPTIONS` 中给出具名理由。

事件没有这样的兜底。投影只遍历从 host face 包导出可达的文件，因此 client face 代码——或 host 分析器无法触及的任何文件——里的 `interface Events` merge 会无声消失：12 个已声明事件（`slash/input-*`、`theme/change`、`locale/change`，以及 client runtime 的 `*/changed` 失效信号）不出现在任何生成文档中，而且再多一个也不会有任何机制察觉。服务扫描的 glob 也只有 `packages/*/*/src/*.ts`，于是声明在嵌套文件（`src/client/**`）中的 13 个 client face Context key 恰恰对这条为防止无声消失而存在的扫描不可见。

## 决策

事件获得与服务兜底完全对称的机制，且两条扫描都读取完整的包源码树。

`scripts/cordis-walk.ts` 新增 `eventNameList`（`interface Events` merge 的每个成员名，方法与属性成员一并读取，使投影器会拒绝的形状也进入扫描）；扫描产出文件中每一个 `declare module 'cordis'` 块（Typert 分析器读取全部块，止步于第一个会藏起第二个块的表面），其对引号风格不敏感的预过滤匹配 `declare module` 头部而非字面文本 `interface Context`，从而不再跳过只含 Events 或使用双引号的 merge 文件。`gen-cordis-catalog` 的扫描 glob 从 `packages/*/*/src/*.ts` 加深为 `packages/*/*/src/**/*.{ts,tsx}`（两个 pattern）。分区新增第三个方向守住扫描自身：投影渲染的每个服务 key 与事件名也必须对扫描可见，使扫描回归（glob、预过滤、块遍历）成为硬错误而非兜底的无声退化。

新的人工维护映射 `EVENT_WALK_EXEMPTIONS` 为投影看不到的每个已声明事件命名，附理由与拥有其表面的包 README。键是完整事件名而非 scope：client face 事件与已渲染的 host 事件共享 scope（`commands/changed` 与 host 的 `commands/*` 家族并存），scope 级豁免会无声吞掉未来的 host face 回归。分区检查与服务映射一样双向 fail-closed：未豁免的不可见事件、已渲染事件的豁免、无任何 merge 声明的豁免，皆为硬错误。

分区判定从 `computeOutputs` 中提取为纯函数 `walkPartitionProblems(input, maps)`，使每条验收路径都能以单元测试证明而无需运行 Typert 投影；`computeOutputs` 向它馈送渲染模型加独立扫描结果，页面拼接错误的聚合方式保持不变。

促成本决定的审计发现 host face 本已完备：48 个渲染服务 + 10 条 walk 豁免覆盖全部 58 个 host 可见 Context key，49 个 host 事件全部渲染，且每个渲染签名中的每个类型名都已被既有的 fail-closed `LINK_MAP`/`FOUNDATION_TYPE_NAMES`/`TYPE_LINK_EXEMPTIONS` 检查分类。25 条发现（12 事件、13 key）全部在 client face；现在每条都带指向其所属 README 的具名豁免，与既有的 `uiRenderer`/`connection` 先例一致。

## 验证

`scripts/gen-cordis-catalog-partition.spec.ts` 证明每条验收路径：绿色分区、不可见且未豁免的事件（报出声明文件）、已渲染事件的陈旧豁免、从未声明的陈旧豁免、服务侧的对称路径、两个页面映射中未映射的已渲染表面、扫描看不到的已渲染表面（第三方向），以及扫描触达嵌套的仅含 Events 的 merge、多块文件的每个块、双引号头部与 `.tsx` 源文件。在真实源码树上删除一条现役豁免会让 `gen-cordis-catalog` 以事件名与声明文件显式报错；恢复后生成器回到字节相同的 no-op 再生成（85 个产物，写入 0 个），这同时证明新豁免恰好覆盖扫描到的表面。doc-sync 中的 `verify-cordis-catalog` 每次运行都会执行该分区检查。

## 考虑过的替代方案

- **渲染 client face 而非豁免。** 以 `faces: ['host', 'client']` 分析并给 client 服务/事件生成区块才是对盲区的根治，但它改变子系统目录的定位（host 层参考），并要求为纯浏览器表面做页面归属决策；既有的 `TODO(cordis-catalog-interface-services)` 已跟踪拓宽投影。兜底是保证，渲染是其上的升级。
- **scope 级事件豁免。** 映射更小，但 `commands/changed`（client）与已渲染的 host 事件共享 `commands` scope，豁免整个 scope 会无声吞掉未来的 host face 事件——正是本决定要消除的失败模式。
- **用 Typert 推导完备性而非原始 AST 扫描。** 投影与兜底必须独立失败：Typert 的可达性 bug 恰是兜底要捕获的对象，因此扫描刻意保持为不共享机制的朴素 `ts.createSourceFile` 遍历。
- **对渲染签名的传递类型闭包设门。** 决定前先测量：渲染签名中可达的每个类型名都已分类，更深的字段套字段类型由页面手工维护的 `type-equiv` 粘贴与包 README 拥有；闭包门会在没有读者需求的情况下强迫内部类型认领页面。

## 后果

新的 cordis 事件——host 或 client、任意文件深度——必须渲染到某个子系统页面，或在 `EVENT_WALK_EXEMPTIONS` 中以其文档所有者具名；删除事件时必须一并退役其豁免。声明在 `src/` 下任意位置的 Context key 现在同样如此。人工维护映射增加了 25 条 client face 条目，理由全部指向包 README，使子系统目录保持 host 层参考的定位。`walkPartitionProblems` 是分区判定的唯一居所；未来的兜底维度（如渲染 client face、schema 表面）应扩展它及其 spec，而非把检查重新内联进 `computeOutputs`。
