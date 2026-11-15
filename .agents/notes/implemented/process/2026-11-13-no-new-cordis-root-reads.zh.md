# Agent Note: 禁止新增对 Cordis 根上下文的读取

Status: implemented

[English](2026-11-13-no-new-cordis-root-reads.md) | 中文

## 问题

`ctx[Context.root]` 返回应用的根上下文。通过它读取属性会跳过 `inject` 检查，因为根 fiber 没有 runtime；在它上面注册的监听器会跳过 scope 过滤；它读取的是根 realm，而不是调用方所在的 isolate realm。DSH 代码用它读取未声明的服务、监听所有 Agent 的事件、作为应用级状态的键，以及调用要求根上下文的启动 API。这些用法都已有或需要一个显式声明的替代方式：`inject` 条目、监听器上的 `{ global: true }`，或负责根级操作的服务。

仓库中的此类读取分布在 boot、host、preset、protocol、experimental 和测试等多个所有者中。在一次变更中全部替换，会把执行规则的决定与多个服务设计混在一起。

## 决定

第一方 JavaScript 和 TypeScript（包括测试、fixture 和脚本）禁止新增对 Cordis 根上下文的读取。[检查器](../../../../scripts/verify-cordis-root.ts)通过 `pnpm run verify-cordis-root` 运行，使用 TypeScript 语法树，并对每个文件单独建立类型检查器。读取指通过 `Context` 或 `symbols` 的 Cordis 值绑定访问根符号：`.root`、`['root']`，或在声明、参数默认值或赋值中解构出的 `root`。绑定来自 `@deepseek-ai/cordis` 或其子路径，可以是静态导入（包括重命名、默认、命名空间和 `import =` 形式），也可以是解构或整体接收的 `import()` 或 `require()` 结果；遮蔽导入的局部变量不是绑定。值恰为 `cordis.root` 的任何字符串字面量也算读取，即 `Symbol.for('cordis.root')` 背后的键。类型位置、接口、类型别名、ambient 声明、注释、其他字符串以及嵌入模板中的源码文本不算读取。

现有读取使用 `scripts/cordis-root.baseline.json` 中的精确基线记录，由[共享清单模块](../../../../scripts/baseline-inventory.ts)按 [unknown 类型断言清单](2026-09-19-no-unknown-casts.zh.md)的规则维护：基线修改只能删除条目或减少次数，`--prune` 删除已失效的条目并在存在新读取时拒绝写入，且没有任何命令可以添加放行。读取的指纹覆盖以根符号为键的元素访问的 token，因此把已记录的读取换到另一个接收者上会产生新的检查发现。

测试根上下文约定本身的文件在检查器内的 `CORDIS_ROOT_EXEMPTIONS` 中逐个列出并注明原因，不参与扫描：Cordis rc.12 规范测试和检查器本身。若豁免文件不再读取根上下文，门禁失败。vendored 源码和已冻结的归档 Agent Notes 保留清单的排除规则。检查器参与[门禁运行器](../../../../scripts/run-gates.ts)中的 CI static 和 primary 模式以及本地 `hygiene` 和 `check-all` 配置。[防御性模式](../../../../docs/defensive-patterns/general.zh.md#plugins-do-not-read-the-cordis-root-context)为作者写明该规则及替代方式，门禁的拒绝信息链接到这一节。

## 考虑过的替代方案

**在执行规则前替换所有现有读取。** 已否决，因为部分替换需要新的服务，例如供启动 API 使用的 profile 组合服务和应用生命周期信号；先执行规则可以阻止新增读取，同时单独评审这些设计。

**使用 `no-restricted-properties` lint 规则。** 已否决，因为它按名称匹配标识符 `Context`，重命名导入（如 `CordisContext`）可以绕过，而且无法匹配 `Symbol.for('cordis.root')`。

**把豁免文件记入基线。** 已否决，因为基线只会缩小，而豁免文件预期会保留其读取；分开维护可以让基线最终清空。

## 影响

所有者在更换已记录读取的接收者或将其移入未登记的文件之前，必须先移除该读取，并在移除后裁剪其条目。通过此检查表明不存在未登记的语法层面的根读取。它无法检测通过其他值获得的根上下文，例如保存的引用、`Context` 的别名、返回根上下文的服务，或运行时由字符串拼装的代码。
