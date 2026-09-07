# Agent Note: 仅复制的 preset 创作，与通往 preset 文件的入口

Status: implemented

[English](2026-08-08-copy-only-preset-authoring.md) | 中文

## 问题

agent-preset 设置页带着一个网页 YAML 编辑器：`agentPreset.write` 接收任意组装文本，页面是一个没有补全、高亮或 diff 的文本域，形状检查依赖 Loader 自己的 `entryListSchema`——其方言含 `!!js`，所以「过了形状检查的文本」在下一次挂载时仍是任意代码。作为编辑器很弱，作为能力很宽，还是该分区不得不防御的「编辑器 vs 名单」竞态的来源。

## 决策

创作改为宿主端复制，文件就是编辑器。`agentPreset.write` 变为 `agentPreset.copy { from, agentPreset, name? }`：两个由宿主对照自身根目录解析的 id 加一个可选显示名，整目录 `cp`（符号链接解引用，权限收紧为仅属主并保留属主执行位），元数据重写为保留来源描述、但绝不保留其名称或 `order`。页面包含随附组装的只读查看器、作为唯一创建入口的复制对话框（不提供空白「新建预设」）、自定义行的删除，以及通向文件的位置操作。`settings/openAgentPresetDirectory { agentPreset }` 在 Host 侧解析目录并原生打开，部署没有桌面时回答 `{ opened: false, path }` 供该行以文本形式展示；`settings/canOpenAgentPresetDirectory` 控制该行是否显示，Settings Controller 的 `nativeOpen` 则在平台探测可能误判时固定服务端行为。

## 后果

- 创作两个方向都没有组装文本或路径跨越浏览器传输层；`entryListSchema`/`!!js` 的顾虑随 `assertComposition` 本身（已删除）一并消解。创作操作是 `read`/`copy`/`openDocument`/`remove`——没有一个接收文件系统目标，且 Connection 用完整 Host API 的同一会话认证它们。
- 编辑器移除后，手改 `agent.cordis.yml` 成为唯一的组装编辑方式，因此常驻挂载层增加了以 stamp 为键的代际：`ensureStanding` 比对文件的 mtime+大小，为后续会话开启下一代际（[常驻挂载 note](../../archived/architecture/2026-08-08-per-preset-standing-mounts.md)，已就地更新）。没有它，改过的文件要等进程重启才生效。
- 副本是完整快照，会随随附来源升级而漂移——接受；preset 层没有 patch 语义（那是 bundle 层 `cordis.patch.yml` 的能力），随附集合自己也为「一个文件读完整份组装」付了同样的代价（`cordis`/`code` 就是 `standard` 的完整副本）。
- `read` 去掉了 `writable`（没有编辑器可门控），内置目录绝不被打开（`openDocument` 与 `remove` 一样拒绝非 `user` 信任）：安装目录会被升级覆盖，把编辑器指向它等于招揽会被升级悄悄丢弃的编辑。

## 关键实现细节

- **复制目标的拒绝刻意分两道检查。** roster 检查拒绝任一根目录提供的 id——与随附 preset 同名的用户目录会被遮蔽，「创建」只会落下一个永远不被列出的文件；磁盘检查（`cp` 之前的 `PresetExistsError`，`errorOnExist` 作竞态兜底）拒绝占着名字却不是 preset 的目录，那是 discovery 看不见的。
- **展示的路径是响应方向的披露，且经过浏览器认证。**「没有任何浏览器载荷能选中任意文件系统目标」这条不变量说的是请求方向；把解析出的目录展示给已认证浏览器正是方案要求的降级。它绝不搭乘 `list`。
- **e2e lane 钉死 `nativeOpen: false`**（`agent-preset-authoring.overlay.yml`）——既让 golden 在 macOS 开发机与无头 Linux CI 上渲染同一分支，也让测试运行永不弹出真实文件管理器。揭示的目录由 lane 自己 token 化为 `{{presetRoot}}`，因为 `normalizeAria` 只认识 workspace cwd。

## 考虑过的替代方案

保留 write 换个更好的编辑器（CodeMirror 等）：传输层上仍是任意能力，仍是竞态来源，而且仍不如用户自己的编辑器。带 patch 语义的副本（「standard 加这点 diff」）：bundle 面之下没有这样的层，仓库自己的随附 preset 也刻意选了完整副本。浏览器端拿返回路径调 `session/openWorkspacePath`：路径一旦成为请求参数，就打破了 README 的「不可选中任意目标」不变量。
