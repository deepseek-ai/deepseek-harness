# Agent Note: The shipped preset root is the plugin's own

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-plugin-owned-shipped-preset-root.md) | 中文

## 问题

`composeProfile` 交付内置 agent-preset 根目录的方式，是在启动时推入一个 overlay：其 `config` 展开已组合的 roster 行后，把 `roots` 硬设为仅含内置根。由于 id 定向补丁整体替换 `config` 值，这个 overlay 压掉了 profile 的 `cordis.patch.yml`（以及 home 层、`--patch` overlay）配置的全部根目录：把 `agent-presets` 指向共享 preset 目录的部署，启动后只剩内置根加 roster 的可写 home 根，所有自定义 preset 从 Web 选择器中消失。`dsh --dump-config` 只组合文件承载的层，dump 显示配置的根目录完好而启动却丢弃了它们。该 overlay 还把行的启动时 `config` 冻结在所有热重载之上，重启前对该行的任何 `cordis.patch.yml` 编辑都不生效。外部报告 discussion #3636 给出了准确根因。

在"补丁整体替换 `config`"的语义下，任何"必须在用户层之后存活"的值都需要组合后的强制注入——而评审否决了把这份强制留在启动器里：`apps/cli` 对某一个插件的行 id、config 键与优先级做特判，是组合机器不应携带的耦合。

## 决定

内置 preset 归插件自有。四套内置组合从 `apps/cli/config/agent-presets/` 搬入 `packages/preset/agent-presets/presets/`，列入包的 `files`；`dsh-agent-presets` 相对自己的模块解析 `SHIPPED_PRESET_ROOT`——Loader 在运行时按包名导入插件，目录在源码与安装两种布局中都真实存在于磁盘上，与 `cordis` preset 目录内随行携带 skill 依赖的是同一机制。`resolvedRoots` 变为：除非 `includeShippedRoot` 为 false，先是内置根（`system` 信任），再按序 `config.roots`，最后除非 `includeUserRoot` 为 false 追加推导的可写 home 根——前置，因此内置集合始终挂载并赢得重复 id。

这补全了 #2278 为可写根开启的[会话级 preset roster](../architecture/2026-08-03-per-session-agent-presets.zh.md) 方向：两个非配置根现在都属于本包，启动器不带任何插件知识地组合补丁层，压掉、重载冻结与 dump 分叉从"被修复"变为"不再可能发生"。"一定加载"的保证不再依赖补丁顺序：`includeShippedRoot` 在 schema 中默认 true，用户层整体替换该行 `config` 后内置集合依然保留，只有显式 `false`——与整行 disable 同级的故意行为——才会去掉它。组合绑定的是宿主的 agent-plane 服务而非 Web 表面：没有任何 preset 行引用 client 或 web 插件；宿主缺少被注入的服务时，该行保持等待，与任何其他根目录下的 preset 无异。

## 测试

`shipped-root.spec.ts` 直接覆盖插件所有权：裸 roster 列出四套内置 preset 为 `system` 信任、且除未解析行外不携带其他原因（证明搬移后的文件能从包内解析）。健康检查此后新增了一趟模块解析——见[预设健康解析它能证明会启动的行](../architecture/2026-08-26-preset-health-resolves-rows.zh.md)——而 fixture 基准并不是内置行所引用的包所在的那个安装，因此该断言点名它容忍的原因，而不是要求一个都没有；内置根前置于配置根与推导用户根之前，fixture 目录占用内置 id 时被遮蔽；`includeShippedRoot: false` 挂载不含内置集合的 roster。钉住确切 roster 的既有套件选择关闭，这正是该选项文档命名的第二用途。Web 组合 e2e 以 config 中零 roots 启动真实 bundle，断言内置四套加配置共享根的 preset、内置 id 遮蔽、以及配置根 preset 组合出 agent；对 built `lib/` 运行验证打包布局同样解析得到目录。门禁脚本（`verify-cordis-config`、`verify-runtime-closure`）扫描新位置。

## 曾考虑的替代方案

**保留启动器补丁但按组合派生、前置而非替换。** 本修复未曾合入的第一版：对压掉、重载冻结与 dump（曾以带标签层渲染派生补丁）判断均正确，核心即报告者的 overlay 前置形状。在评审中被替代，因为每个变体都让 `apps/cli` 对 roster 行做特判；被否决的是耦合而非机制。

**由 bundle 自己声明内置根（`!!js` 包相对路径）。** 去掉启动器耦合，但把"一定加载"的保证重新挂回补丁顺序：用户层整体替换该行 `config` 时 bundle 的条目被丢弃——又回到所报 bug 的形状。

**带外提供根目录（启动器提供的上下文值，由插件前置）。** 启动器仍需知道"要为 preset 提供一个事实"；特判换了通道继续存在。

## 后果

`config.roots` 纯粹是部署追加的目录；dump 展示的正是它，内置根成为文档化的插件行为，运行时经 `agentPresets.roots` 呈现。`apps/cli` 不再携带 `config/` 目录，其 `files` 条目移除。任何挂载 roster 的组合——以及任何嵌入本包的使用方——默认获得内置集合，一行配置即可关闭；只要纯机制的嵌入方设 `includeShippedRoot: false`。preset 里的裸插件名仍经启动的扁平安装后备解析，搬移不改变这一点。
