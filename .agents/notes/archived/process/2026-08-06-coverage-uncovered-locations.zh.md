# Agent Note: 覆盖率未达标时输出精确未覆盖位置

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-coverage-uncovered-locations.md) | 中文

## 问题

per-file 100% 覆盖率门禁失败时，vitest 只输出文件级错误行（`ERROR: Coverage for lines (…) does not meet global threshold (100%) for <file>`）——知道哪个文件没达标，不知道差在哪几行。内置 `text` 报表虽有 Uncovered Line #s 列，但它是全仓几百个文件的大表：该列按表宽截断、只有行号没有列号、不区分语句/分支/函数，且达标文件同样占行。结果是 CI 上的覆盖率红报无法直接据此处理，定位具体缺口只能本地重跑一遍 html 报表。

## 决策

`scripts/coverage-uncovered-locations.cjs` 是一个自定义 istanbul reporter（`ReportBase` 子类）：对每个低于 100% 的文件，为每个未覆盖语句、每条未走的分支路径和每个未调用函数各输出一条自含的单行记录 `<path>:<line>:<col> uncovered <kind> …`——terminal 与 CI 日志中可直接点击跳转，也便于 grep。全部文件达标时零输出。istanbul 报表生成先于 threshold 校验，因此记录恰好落在既有 ERROR 行上方。

接线是单点的：根 `vitest.config.ts` 的 coverage 块是全仓唯一覆盖率配置，CI lane（`run-gates ci-coverage`）、本地 `test:coverage` 与聚焦跑（`--coverage.include`）共用它。该 reporter 以绝对路径（`fileURLToPath`）加入 CI 与本地两个 reporter 数组——istanbul-reports 的 `create()` 对非内置名回退为裸 `require(name)`，相对路径会按 istanbul 自己的包目录解析。

输出约定：

- istanbul 的 0 基列号转为 1 基（编辑器与终端链接的约定）。
- v8 对整行语句给出 `end.column = Infinity`：跨行时降级为只带行号的 `(to <line>)` 后缀，单行时省略后缀。
- 隐式分支臂（如缺少 else 的情况）可能不带位置，reporter 会回退到分支自身的 span，保证记录仍可点击；分支记录标注类型与 `path k/n`。
- 同文件内记录按行、列排序；不设条数上限。

根 `package.json` 将 `istanbul-lib-report` 声明为 devDependency，因为 pnpm 的严格布局使 `scripts/` 无法访问嵌套依赖。

CJS 是被迫的形态，也是 ESM-everywhere 纪律的一个有据例外：istanbul 在 tsx/Vite 流水线之外用裸 `require()` 装载自定义 reporter，TypeScript 无法参与；`require(esm)` 返回的命名空间对象也过不了它的 `new Cons(cfg)` 构造，CommonJS 是唯一可靠形态。

## 考虑过的替代方案

- **依赖内置 `text` 报表的 Uncovered Line #s 列。** 正是问题现状：全仓大表、列宽截断、只有行号、不分种类、达标文件同列——无法直接根据 CI 日志处理。
- **加 `json` reporter，另写包装脚本失败后读 `coverage-final.json` 后处理。** 纯 ESM/TS 可行，但包装脚本必须同时包住 `package.json` 的 `test:coverage` 与 run-gates 的 gate 两个入口，命令形状随之改变；自定义 reporter 路线只动一处配置，两个入口自动生效。
- **用 TypeScript/ESM 写 reporter。** istanbul 的装载机制（流水线外裸 `require`）决定了不可行，见上；为一个报表文件把装载机制换掉，代价不成比例。

## 验证

本地矩阵：故意制造未达标时三类记录齐全、位置与埋点一致；混合运行只输出未达标文件（同跑内 100% 的文件静默）；全绿跑零输出、退出码 0。CI 实证：临时在 `clampTimeout` 埋入一处不可达语句/分支/函数后，coverage lane 在全部测试通过（632 文件 / 10326 用例）、仅 threshold 失败的隔离条件下，把 4 条记录打印在 ERROR 行上方；埋入的失败并不在已提交的代码树中。

## 后果

- 覆盖率红报自足：日志直接给出精确行列号与缺口种类，不再需要本地重跑 html 报表定位。
- 代价是一个 CJS 文件的纪律例外与一个根 devDependency；全绿运行零输出，不增加日志噪音。
- 整文件零覆盖时输出条数与该文件语句数同阶（刻意不设上限）：门禁要求零缺口，全量列出即是行动清单，vitest 自身的 ERROR 行已按文件汇总兜底。
