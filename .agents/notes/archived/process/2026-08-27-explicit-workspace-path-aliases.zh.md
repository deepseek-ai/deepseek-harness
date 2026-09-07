# Agent Note: Explicit workspace path aliases replace per-group wildcards

Status: implemented
Archived: 2026-09-04

[English](2026-08-27-explicit-workspace-path-aliases.md) | 中文

## Problem

`tsconfig.base.json` 是整个仓库的解析门面：每个包的 project 都 extends 它，两个聚合配置都读它，每个 Vitest 配置都把 `vite-tsconfig-paths` 指向它。其中两条别名按包**分组**而不是按包各写一条候选——`@deepseek-ai/dsh-*` 列了 49 个候选 glob，`@deepseek-ai/dsh-*/invariant` 列了 45 个。

TypeScript 与 tsx 按顺序逐个尝试这些候选、取第一个存在的，因此一个位于列表靠后位置的包，其说明符要为前面每一次未命中买单。在 `dsh` 源码启动下，每次未命中都是一个 `ERR_MODULE_NOT_FOUND`，而 Node 会用 `decorateErrorWithCommonJSHints` 装饰它——每次失败都跑一遍完整的 CommonJS 解析走查。一次源码启动的 profile 把 **934.6 ms（占启动 35%）**单独归给了这条装饰路径，来源是 60,942 次失败解析。

代价最重的恰好落在被引用最多的包上：`packages/util/*` 排在 49 个候选里的第 44 位，却装着几乎每个插件都要引用的叶子工具，因此 `dsh-timeout` 每次解析约付 9 ms，而一个有显式别名的说明符只要 0.05 ms。

## Decision

`scripts/gen-tsconfig-paths.ts` 在 `paths` 末尾一个带标记的区域里，为每个 workspace 包写入一条显式别名，两条分组通配符随之删除。`pnpm run gen-tsconfig-paths` 重写该区域；`pnpm run verify-tsconfig-paths` 只报告漂移，并与其他生成物检查一起跑在 `ci-static` 车道上。

生成器只为**声明名恰好等于 `@deepseek-ai/dsh-<目录名>`** 的包发别名，因为那是通配符唯一可能解析出的形态：它把说明符的后缀代入 `packages/<group>/<后缀>/src`。名字与目录不一致的包——`packages/typert/protocol` 上的 `@deepseek-ai/dsh-typert-protocol`、以及 `dsh-client-*` 与 `dsh-host-*` 两族——本来就有手写别名，保持不动。若某个说明符被两个包目录同时认领，生成器**抛错**而不是任选其一，因为显式映射无法表达通配符依赖的分组顺序裁决；当前不存在这种冲突。

删除通配符也删掉了「没人写别名的包仍能解析」的兜底，因此生成器同时断言覆盖完备：每个含 `src` 的 workspace 包都必须被生成别名或手写别名映射，`--check` 会点名任何未被覆盖者。没有这条断言，一个名字与目录不一致的新包会被生成器跳过，继续经 workspace 软链解析到构建产物 `lib/`——正是显式别名要消除的产物层泄漏。

该区域用标记注释之间的**定点文本改写**生成，而不是重新序列化整个文件。`tsconfig.base.json` 是 JSONC，其手写别名带有解释非显然映射的注释，重新序列化会把它们丢掉。

本决策**部分取代**了[包清单自动发现提案](../../proposed/process/2026-06-20-discover-package-inventory.zh.md)——该提案把「合并为一个通配符」记为当前实现，而通配符已被删除；该提案剩余的主题（聚合配置里显式的 `references` 数组）不受本次改动影响。

保留四条通配符，每条只有一个候选：`dsh-host-*/invariant`、`dsh-client-*/invariant`、`dsh-client-*/client`，以及五条 `dsh-host-<name>/*` 子路径映射。一个候选只花一次探测，展开它们只会换来文件变大而无收益。

## Resolution differences this change makes

仓库源码中出现的每个 `@deepseek-ai/dsh-*` 说明符——共 1,023 个互不相同——解析目标与改动前完全一致，只有十一个例外：它们现在能解析，而此前不能。这十一个此前都是经 workspace 软链解析到构建产物 `lib/`，而不是源码。

其中七个是 `/invariant` 子路径：`dsh-invariants/invariant`、`dsh-lsp/invariant`、`dsh-lsp-stdio/invariant`、`dsh-tool-lsp/invariant`、`dsh-terminal/invariant`、`dsh-terminal-bash/invariant`、`dsh-tool-terminal/invariant`。

被删除的 `dsh-*/invariant` 通配符遗漏了 `lsp`、`terminal`、`client`、`host` 四个分组。其中 `client` 与 `host` 的遗漏是**刻意且有文档的**——这两族有专用通配符，因为它们的包名以分组目录名为前缀。而 `lsp` 与 `terminal` 的遗漏没有任何这类理由，`packages/runtime-diagnostics/invariants` 则两条列表都不在。于是这七个说明符此前是通过 workspace 软链与包的 `./invariant` 导出解析到构建产物 `lib/types/*.d.ts`，而不是解析到源码——这与「静态门禁通过 `paths` 把 workspace 导入解析到 `src`、并在干净树上通过」的规则相抵触。把别名统一之后，它们与所有同类一样解析到源码。

另外四个是被覆盖断言揪出来的**整包**：`dsh-client-ui-directory-picker-browse`、`dsh-client-ui-directory-picker-native`、`dsh-experimental-agent-team-profile`、`dsh-experimental-agent-team-web-profile`。它们都叫 `dsh-<分组>-<目录>`，任何通配符都代不出这种形态；而它们身旁的同族包都有手写别名——这四个只是漏了。现在补上。

## Testing

`scripts/gen-tsconfig-paths.spec.ts` 钉住：收集器把包映射到它自己的目录、跳过带手写别名的包、返回有序列表；渲染器让位于手写说明符，且区域收尾不带多余逗号；区域写入器只替换标记范围，并在缺少标记时拒绝；以及提交后的配置里两条分组通配符都不复存在。另有两条用例钉住覆盖断言：它会点名未被映射的包，且对提交后的配置报告为空。

门禁的拒绝路径被直接验证过：删掉一条生成的别名会让 `verify-tsconfig-paths` 以非零码退出，恢复后检查通过。

CLI 入口守卫采用仓库既有的比较方式 `import.meta.filename === resolve(process.argv[1])`，而不是拼接 `file://` URL。拼接形式在 `import.meta.url` 做了百分号编码而 `process.argv[1]` 没做时失效——仓库路径含空格、或任何 Windows 盘符路径——且失效是静默的：脚本什么也不做就以 0 退出，恰恰会让这道门在最需要它的环境里形同虚设。把脚本复制到一个名字含空格的目录下运行即可复现：拼接式守卫求值为 false，既有写法为 true。

## Alternatives considered

**给通配符的候选 glob 重新排序，把最热的分组放前面。** 这不需要生成器也不需要新门禁，把 `util`、`core`、`llm`、`session` 挪到前面大约能拿回一半收益。否决理由：收益随着包的增加而衰减，这个顺序没有任何读者可核验的不变量，而且第一个分组之后的每一组仍然要付钱。它还保留了最糟的性质——新增一个包分组会悄悄拖慢所有人的启动。

**把 `paths` 挪进一个生成的 `tsconfig.paths.json`，由 base 配置 `extends`。** 这能把生成内容彻底移出手写文件，diff 也更干净。本次否决的理由是：有若干消费者**直接读** `tsconfig.base.json`，而不是通过会跟随 `extends` 的解析器——六个 Vitest 配置，外加 `project-reference-faces.ts`、`verify-export-jsdoc.ts`、`doc-typecheck.ts`、`rescope-vendor.ts`——逐个审计它们比这次别名改造本身还大。标记区域用零消费者风险达成了同样的隔离。

**在显式别名下方保留通配符作为兜底。** 显式别名本来就优先于通配符，因此正确性不变，而且新增包忘了重新生成也仍能解析。否决理由：兜底恰恰是让陈旧配置隐形的原因——仓库的立场是「misconfiguration fails loud」，而 `--check` 门禁把缺失的别名变成一次具名失败，而不是一次没人归因的慢启动。

## Consequences

`headless` profile 的源码启动从 2,157 / 2,182 / 2,153 ms 的基线降到 1,069 / 1,052 / 1,055 ms——约 **1.1 秒，51%**，两个区间相距极远，且 `--help` 输出逐字节一致。

**收益仅限于 tsx 源码启动这一条路径。** Vitest 走 `vite-tsconfig-paths`，它在进程内做匹配与文件存在性检查，从不构造 Node 模块错误，因此从未付过那笔装饰代价：对某个包的整套用例做 A/B，实测 5,934 / 5,829 / 5,908 ms 对 5,878 / 5,851 / 5,905 ms，属于噪声。仓库的门禁脚本只 import 少数几个 `@deepseek-ai/dsh-*` 包，同样测不出可分离的差异。发布用户在裸 Node 下跑构建好的 `lib/`，本来就不受影响。

`paths` 从 188 个 key 增长到 523 个，新增包时必须运行生成器。`--check` 门禁把这件事变成一次具名失败而非静默失败，而生成区域让这类改动的 diff 只有一行。
