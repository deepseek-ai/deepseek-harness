# XLSX 模糊测试诊断

[English](README.md) | 中文

使用 Openpyxl 和 XlsxWriter 生成表格文件，再将源码 XLSX 适配器的结果与独立记录的单元格值、公式和不支持内容类别比较。此诊断任务需要显式运行，会保留失败结果并以非零状态退出；它不属于默认单元测试集。

## 运行测试

安装工作区依赖，并准备装有 Openpyxl、XlsxWriter 和 Pillow 的 Python 解释器。在 PowerShell 中，将 `$excelFuzzPython` 设置为该解释器的可执行文件路径。从仓库根目录运行，并使用新的输出目录：

```powershell
& $excelFuzzPython packages/client/ui-sidebar-documentpreview/tests/fuzz/generate.py .artifacts/excel-fuzz-new --seed 4863 --random-cases 400
pnpm exec tsx packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts .artifacts/excel-fuzz-new
```

种子控制功能组合、数值和字节变异。ZIP 元数据保持固定；复现还依赖 `manifest.json` 记录的写入器版本。生成器先验证内部关系目标，并用 Openpyxl 重新读取预期单元格，再将工作簿归类为合法文件。被排除的候选保留在 `generatorErrors` 中；随机字节变异单独分类。

从已有样本集重跑选定用例：

```sh
pnpm exec tsx packages/client/ui-sidebar-documentpreview/tests/fuzz/run.client.ts .artifacts/excel-fuzz-new --only openpyxl-table --report table.json
```

执行器为每个输入设置 10 秒的可终止 Worker 截止时间，并检查输入不变性、单元格值、公式缓存，以及提示顺序和唯一性。`--timeout-ms` 可修改该诊断时限。报告保留全部结果；`repros/` 包含功能组合较少的代表性失败文件，不声称输入已达到全局最小。被接受的损坏 ZIP 仅作为观察结果，需要单独检查。

## 对比旧适配器

`--baseline-ref <commit-or-ref> --report baseline.json` 从 Git 读取该版本的 `xlsx.ts`，并禁用提示比较。它仍使用当前依赖版本和共用转换辅助函数，安装补丁后无法复现未修补 ExcelJS 的基线。须保留原依赖状态下的报告，或在独立检出目录中运行旧版本。Worker 退出后会删除临时基线模块。此对比检查源码解析，不覆盖 FortuneSheet 浏览器渲染或发布的 Web 配置。

## 保留的回归用例

[OPC fixture](../fixtures/excel-opc/) 包含从 seed 4863 语料复制的五类独立失败文件，以及一个组合 Openpyxl 工作簿。Openpyxl 3.1.5 生成批注、Table、命名空间前缀和部件名用例，XlsxWriter 3.2.9 生成相对目标用例。组合工作簿加入图表、条件格式、冻结表头、隐藏行／列／工作表、合并、样式、超链接、类似 XML 的字面文本和公式，再应用 `sheet-prefix` 与 `sheet-filename` 变异。Openpyxl 独立校验保存的输入。单元测试和浏览器测试读取已提交的字节，无需 Python。

[XML fixture](../fixtures/excel-xml/) 保留一个 XlsxWriter 3.2.9 工作簿及七种等价编码：UTF-16 工作表或元数据 XML、移动工作簿/样式/共享字符串部件、CDATA 文本，以及移动工作表/绘图目录。每个文件都保留公式缓存、Unicode 和类似 XML 的文本、批注、Table、样式、合并、冻结标题、隐藏内容和全部四类提示。升级 ExcelJS 时，应通过 Node 与浏览器入口比较完整预览及批注/Table 元数据，再对构建后的 Worker 运行 `apps/web/tests/excel-opc.e2e.ts`。保留原始语料报告；重放时使用新的 `--report` 文件名，并在独立读取器验证之外单独检查 ZIP 目录完整性。

[打开回归样例](../excel-opening-fixture.ts)基于 Openpyxl 组合文件派生 Strict URI 别名、根目标与部件名大小写变体，以及孤立 DrawingML。变换保留单元格数据，并通过两个解析入口、完整预览比较和实际发布的浏览器 Worker 验证。ASCII 大小写等价的歧义条目会被拒绝；非 ASCII 名称保持区分。

运行 Node 和浏览器 bundle 解析器回归测试：

```sh
pnpm exec vitest run packages/client/ui-sidebar-documentpreview/tests/excel-opening.client.spec.ts packages/client/ui-sidebar-documentpreview/tests/excel-opc.client.spec.ts packages/client/ui-sidebar-documentpreview/tests/excel-xml.client.spec.ts
```

fuzz 报告记录每个输入的 SHA-256、能否打开以及工作区状态。`validOpened` 和 `validRejected` 将打开失败与值差异分开，严格退出状态仍会拒绝这两类缺陷。已知的 1904 时间／累计时长偏移和空字符串公式缓存差异仍作为诊断失败。解析器接受的损坏输入继续作为观察结果单列。

通过 `pnpm patch` 和 `pnpm patch-commit` 对发布包维护 ExcelJS 补丁。已安装的依赖树包含生成的启动脚本，不得混入补丁。在依赖缓存安装上的测试结果之前，先用 `pnpm patch --edit-dir <new-directory>` 全新解包，验证补丁能够应用。
