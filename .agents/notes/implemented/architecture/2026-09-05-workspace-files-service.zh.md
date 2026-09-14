# Agent Note: 工作区文件服务

Status: implemented

[English](2026-09-05-workspace-files-service.md) | 中文

## Problem

Web 客户端需要从一个未必在 Host 机器上的浏览器查看会话工作区里的文件：agent 产出的文件、`read` 工具行点名的路径，之后还有文件树，以及既不小也不是文本的文件预览。唯一一个经线路读取工作区文件的端点以 `workspace-file.ts` 住在 Session Controller 上，与它毫无关系的会话生命周期为邻。它在一个总字节上限之下返回整个文件，因此大日志连一部分都看不了、二进制根本看不了；它没有 `stat`、没有列举、没有变更信号，预览不重读就无法得知 agent 已改写文件；其结果还以 Host 的 `url` 命名文件，而 Client 上没有任何东西把这种拼法当地址用。

两个约束框定了这项服务。经 `ctx.fs` 的文件读取使用 Session 组合后的文件系统后端，其读取权限可能延伸到工作区外，而目录树与变更流消费方以工作区为根。服务为普通文件保留后端的读取决策，同时执行文件类型与有界缓冲检查；`list` 与 `changes` 保留工作区包含限制。另外 `dsh-fs` 只暴露一种原始字节读取 `readBytes(target, signal, maxBytes)`，它拒绝任何比上限更长的文件：对模型整体摄入的图片是正确的，对大文件的一个窗口则毫无用处。

## Decision

`packages/api/workspace-files`（`@deepseek-ai/dsh-api-workspace-files`）同时拥有 Host 服务 `ctx.workspaceFiles`、`workspaceFiles` Remote 命名空间，以及将 `stat` 与 `changes` 转成[资源模型](2026-09-05-client-resource-model.zh.md)实时元数据的 Client `file` 提供者；包组织方式由[双面包组织](2026-09-07-workspace-files-dual-face-package.zh.md)规定。文件方法从工作区根解析相对路径，但继承 Session 文件系统后端的读取权限；`list` 与 `changes` 仍限于工作区。[工作区文件读取权限](2026-09-09-workspace-file-read-authority.zh.md)拥有这一分层及其安全后果。结果以文件在文件系统执行环境中的绝对路径命名文件，内容则受页、字节窗口或整文件上限约束。字节窗口依托 `dsh-fs` 新增的 seam `FileSystem.readByteRange`，由每个提供者实现。Session Controller 不再携带任何工作区文件代码。

### 包拓扑

[双面包组织](2026-09-07-workspace-files-dual-face-package.zh.md)取代本记录中把 Host 与 Client 分成两个包的组织选择；这里的文件服务、分页和变更流约定保持不变。[工作区文件读取权限](2026-09-09-workspace-file-read-authority.zh.md)取代文件方法原有的工作区包含选择。Host 与 Client 分别编译在两个叶配置中，共享线路类型，Client 不导入 Host 运行时入口。

| 面 | 包 | 文件 | 依赖 |
|---|---|---|---|
| Host | `api/workspace-files/tsconfig.host.json` | `src/index.ts`（`WorkspaceFiles`、`Config`、围栏、切页器）、`src/changes.ts`（`WorkspaceChangeFeed`）、`src/types.ts`（线路类型、错误码） | `dsh-fs`、`dsh-sandbox-policy`、`dsh-typert-protocol`、`dsh-session`、`dsh-session-persistence` |
| Client | `api/workspace-files/tsconfig.client.json` | `src/client/index.ts`（插件体）、`provider.ts`、`change-feed.ts`、`remote.ts`、`types.ts`，以及共享的 `src/types.ts` | `dsh-api-gateway/client`、`dsh-session/types`、`dsh-client-resources`、`dsh-client-ui-slots`、`dsh-util-workspace-path`、`dsh-typert-protocol`，以及本包生成的 `./remote` |

`api/remotes` 和两个根聚合分别引用匹配的 Host/Client 叶子。包导出 `.`、`./client`、`./types`、`./typert` 和 `./remote`，web-app 中单个 `workspace-files` 条目供应两面。Client 插件注入 `['resources', 'remote', 'remote.workspaceFiles']`；资源模型直接从协议包取结果类型，Sidebar 参数声明归文本预览，因此 Client 编译图不再反向依赖 Remote 装配或右栏 UI。

### `workspaceFiles` Remote 命名空间

每个 Host 方法首参都是 `WorkspaceFileScope`。Gateway 从线路上的 Session 身份解析它：优先读取 live Session header，cold Session 则只调用 `SessionPersistence.stat`；不会激活 Agent、读取事件正文或回退到父 Session。scope 携带所选 Session id 及其 `cwd`，仅当该 header 没有 `cwd` 时才使用沙箱策略的部署根。Client 传入 Session id，从不自行命名根。七个签名照 `src/index.ts` 的声明：

```ts ignore-check
@Remote async read(workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText>
@Remote async readBytes(workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceByteRange, signal: AbortSignal): Promise<WorkspaceFileBytes>
@Remote async readAll(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileBytes>
@Remote async readRelated(workspaceFileScope: WorkspaceFileScope, path: string, relativePath: string, signal: AbortSignal): Promise<WorkspaceFileBytes>
@Remote async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>
@Remote async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
@Remote({ mode: 'stream' }) changes(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
```

- **`stat`** 返回 `WorkspaceFileStat { absolutePath, version, bytes? }`：文件身份、不透明的新鲜度令牌，以及后端报得出时的大小。它只接受普通文件。
- **`read`** 返回一个行窗口 `WorkspaceFileText = WorkspaceFileStat & { offset, text, lines, eof }`；`lines` 计页内行数，使只含一个空行的页（`text: ''`、`lines: 1`）与越过文件末尾的页（`lines: 0`）可区分。`range.offset` 是 1 起算的首行，缺省 1；`range.limit` 是最多行数，缺省 `maxLines` 且不得超过。行以 `\n` 结束，末尾的 `\n` 终止最后一行而不是开启一空行；`text` 以 `\n` 连接本页各行且不带终止符；页含最后一行时 `eof` 为 true，越过末尾的 offset 返回 `eof` 为 true 的空页。切页器沿 `streamText` 前进，数过窗口前的行而不保留，把每个窗内片段先按 `maxBytes` 核准再缓冲，并在越过窗口的第一个字符处返回，因此任意大小的文件只花一页内存。页上的 `version` 与 `bytes` 来自流之前的那次 stat。
- **`readBytes`** 返回一个原始字节窗口 `WorkspaceFileBytes = WorkspaceFileStat & { offset, data, eof }`。`range.offset` 是 0 起算的首字节，缺省 0；`range.length` 是最多字节数，缺省 `maxBytes` 且不得超过。`data` 为 base64，文件在窗内结束则短于 `length`，位于或越过末尾则为空；窗口含最后一个字节时 `eof` 为 true。不做任何解码，也不按二进制拒绝。`read` 按行分页、绝不按字节；字节窗口走 `readBytes`。
- **`readAll` 与 `readRelated`** 在 `maxFileBytes` 上限内返回完整的 `WorkspaceFileBytes`。`readRelated` 从基准文件所在目录解析相对文件系统路径；Host 对两个文件执行相同的普通文件检查和后端读取权限。[Document Preview](2026-09-08-document-preview-operations.zh.md) 负责其加载与地址语义。
- **`list`** 返回 `WorkspaceDirectoryListing { path, entries, truncated }`：被列目录相对根的工作区路径（根为空串）、其直接子项按后端的稳定名序以 `{ name, type, size? }` 给出，以及 `maxEntries` 是否截断了列表。`type` 为 `file`、`directory` 或 `other`；符号链接子项报告其指向目标的类型，悬空者为 `other`，而打开这样的子项仍会在下文的链接关被拒。dotfile 照常列出，不做任何过滤。
- **`changes`** 产出 `WorkspaceFileWatchFrame`：在观察队列注册且工作区根解析完成后先发 `{ kind: 'ready' }`，随后为 `{ kind: 'change', change }`。载荷 `WorkspaceFileChange` 对存在的文件为 `{ absolutePath, version }`，对消失的文件为 `{ absolutePath, absent: true }`。来源是工作区根内的 `fs/observed`，不监视操作系统。首次拉取后的观察都会排队，包括根解析期间的观察；取消或插件释放会结束该代流。

### 线路上的路径

离开服务的路径词汇有两套，每个方法只用其中一套。`read`、`readBytes`、`readAll`、`readRelated`、`stat` 与 `changes` 以 `absolutePath` 命名文件：它在文件系统执行环境中、符号链接已解析的绝对路径（`ctx.fs.processPath(target)`），因此 Client 提供者按绝对路径把变更帧匹配到已打开的地址：Client 把地址路径原样交给 Host，并只按成功的 `stat.absolutePath` 绑定跟随者，不读取会话摘要的 cwd。`list` 说工作区路径——与其 `path` 参数相同的语法，绝对或相对根——因为其消费方是一棵以根为起点的树。该字段叫 `absolutePath` 而不叫 `url`，因为它不是资源地址；地址语法归 `dsh-util-workspace-path` 所有，与资源模型一并描述。`read`、`readBytes`、`readAll`、`readRelated`、`stat` 与 `list` 的输入路径是绝对路径或相对会话工作区根的路径，从不相对后端自己的 cwd。

`version` 是消费者只比较是否相等、从不解析的不透明字符串：本地后端由设备、inode、大小及纳秒级 mtime 与 ctime 导出，因此内容不变的重写也会改变它。`offset` 在 `read` 上指行、在 `readBytes` 上指字节；两套单位从不混用，二者的 `eof` 都表示窗口到达了文件末尾。

### 文件检查与工作区包含

`read`、`readBytes`、`readAll`、`readRelated` 与 `stat` 共享普通文件检查，之后依赖文件系统后端的读取权限。`list` 共享路径检查，但还会检查工作区包含关系；`changes` 则把观察过滤到工作区根内。服务执行以下检查：

1. **路径本身。** `lstat` 在跟随任何东西之前检查路径：缺失路径为 `not-found`；符号链接——不论指向哪里，包括指回工作区内——对文件方法为 `not-regular-file`（kind 为 `symlink`），对 `list` 为 `not-directory`。空路径是 `gateway/bad-request`。
2. **`list` 的工作区包含。** 目录解析为目标，由 `ctx.fs.contains(root, target)` 判定，其中 `root` 是从所选 Session header 解析出的 `WorkspaceFileScope.workspaceRoot`。`..` 爬出或根外绝对目录为 `outside-workspace`。`changes` 对观察到的目标使用相同的后端包含判定。
3. **上限。** 超过 `maxBytes` 的页或窗口，或 `read` 索要超过 `maxLines` 的行数，一律拒绝、绝不截短，因为悄悄截短的页读起来就像整页；超过 `maxEntries` 的列表被截断并如实报告。全文及关联文件读取超过 `maxFileBytes` 时被拒绝。
4. **文本。** 仅限 `read`：到页末为止不是 UTF-8 的内容、后端 8 KiB 开头样本里的 NUL 字节，或页内任何位置的 NUL 字节，都是 `not-text`；页之后的字节不检查。

路径检查之后，文件方法再对解析出的目标 `stat` 一次，因为文件可能在读取前已消失或换了种类：消失者为 `not-found`，被替换者为带新种类的 `not-regular-file`。对 `list` 而言，根外条目若类型本身已不合格，会先报告其种类而不是位置。

### 失败

每种失败都是一个带类型化 details 的 `RemoteError` 代码，声明在抛出它的代码旁，按代码而非消息区分。

| 代码 | 何时 | Details |
|---|---|---|
| `workspace-file/not-found` | 路径处无条目，或文件在过关后消失 | `{ path }` |
| `workspace-file/outside-workspace` | `list` 的目标不在工作区根内 | `{ path }` |
| `workspace-file/too-large` | 一页文本或字节窗口超过 `maxBytes`，或全文读取超过 `maxFileBytes` | `{ path, limit }` |
| `workspace-file/not-text` | 到页末为止的非法 UTF-8，或样本或页内的 NUL 字节（仅 `read`） | `{ path }` |
| `workspace-file/not-regular-file` | 对非普通文件执行 `read`、`readBytes`、`readAll`、`readRelated` 或 `stat` | `{ path, kind: 'directory' \| 'symlink' \| 'other' }` |
| `workspace-file/not-directory` | 对非目录执行 `list` | `{ path, kind: 'file' \| 'symlink' \| 'other' }` |
| `workspace-file/unsupported-address` | Client 铸出：本提供者无法服务的资源地址 | `{ address }` |
| `workspace-file/unknown-workspace` | Client 铸出：不携带 Session 的 `absolute` 地址 | `{ address }` |
| `gateway/bad-request` | 空路径，或不是范围内整数的 `offset`、`limit`、`length` | `{}` |

这个集合只增不改不删：可以新增代码，但不重命名、不移除任何一个，因为消费方跨线路按这些字符串分支。

### 配置

四个字段，都是可在 `cordis.yml` 中修改、经校验的正整数，此外没有其他可调项：`maxBytes`（默认 2,097,152，即 2 MiB）是单页文本与单个字节窗口的含上限；`maxLines`（默认 5,000）是页的缺省与最大行数；`maxEntries`（默认 2,000）是返回目录条目数的上限；`maxFileBytes`（默认 33,554,432，即 32 MiB）限制全文及关联文件读取。分页和开窗读取不限制整个文件的大小。

### `dsh-fs` 中的 `readByteRange` seam

大文件的字节窗口需要一种以窗口为界的文件系统读取，而 `FileSystem` 只有以整文件为界的 `readBytes(target, signal, maxBytes)`。因此 `dsh-fs` 新增第二个原始字节原语：

```ts ignore-check
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
```

它返回 `[offset, offset + length)` 处的字节，文件在窗内结束则变短，`offset` 位于或越过末尾则为空。窗口即界：后端最多传输为到达 `offset` 而跳过的前缀之外的 `length` 字节，从不缓冲整个文件，因此调用方对 `length` 的上限就是防无界缓冲的守卫，与 `readBytes` 的界并列而非取代它。参数顺序遵循 `readText`、`streamText` 与 `listDir`——先目标，再操作自己的参数，最后可选 signal——而不是 `readBytes` 把 signal 放中间的形式，那是该类中唯一的例外。`offset` 与 `length` 按前置条件都是非负整数；seam 是类型化的同进程边界，不做任何校验，由 Remote 方法在线路处校验。

`fs-local` 在与其他读取相同的普通文件 stat 之后打开 `createReadStream(targetKey, { start: offset, end: offset + length - 1 })`，对 `length` 为 0 直接返回空数组而不开流；`fs-sandbox` 继承 `LocalFileSystem`，随之继承该方法。继承 `FileSystem` 的四个测试替身也实现了该方法。

### Client `file` 提供者

Client 导出向 `ctx.resources` 注册一个 `ResourceProvider<'file'>`，存活期与插件相同，并声明 `ResourceProtocolMap.file`。Document Preview 包把本包导出的 `WorkspaceFileParams` 注册为 `SidebarRightResourceParamsMap.file`。

- **值是元数据**，`WorkspaceFileStat { absolutePath, version, bytes? }`；内容从不进入流，因为内容可以任意大，而流是用来推送变更而不是载荷的。消费者用 `read` 读页（或用 `readBytes` 开窗），并比较版本判断它们是否过时；新鲜度判断和刷新属于各消费方，不属于共享观察。
- **地址命名文件，作用域决定读取会话。** `session` 地址携带的相对或绝对路径原样交给 Host；工作区根为相对路径提供基准，Session 文件系统后端决定读取权限。Client 不需要持有 cwd。`absolute` 地址不带 Session，以 `workspace-file/unknown-workspace` 失败，不借用当前或 tab 所属 Session。不支持的语法产生 `workspace-file/unsupported-address`。这两种 Client 错误会结束流。
- **帧。** 第一帧是 `stat`或其失败的 `ok: false` 帧；提供者不抛也不接，因为 Remote 面从不 reject，而提供者流里的抛错只可能是编程错误，任其浮出。携带值尚未持有的版本的 Host 写入产生该版本、保留字节数、不做 stat；携带已持有版本的帧被丢弃。报告的消失会再 stat 一次——仍在则是新元数据，不在则是保留上一个值供展示的 `not-found` 帧。跟随的是地址而不是文件：stat 失败后流继续，因此 agent 创建该文件会让资源恢复正常。中止 signal 则流静默结束。
- **每会话一条 `changes` 订阅。** 首位跟随者打开 `remote.$stream`，最后一位离开时释放，后继流和插件拆除等待关闭完成。Client 接受 Host 的 `ready` 后才开始首次 `stat`；本地发出 WebSocket 请求不是 Host 确认。跟随者先按地址注册，缓冲路径未知期间的变更，成功 stat 后按返回的 `absolutePath` 过滤排队与实时帧，反斜杠归一为斜杠。尚未成功绑定时，Session 内任何写入均可触发重新 stat。载体掉线由 Gateway 监督器重连；Host 结束或终态失败会结束跟随者，并保留最近元数据，直到重新打开。
- **导航参数。** `SidebarRightResourceParamsMap.file` 是 `WorkspaceFileParams { line?: number }`，即要显露的 1 起算行号。行号作为导航参数而不是地址的一部分传递，因为不论从顶部还是第 400 行打开，文件都是同一份内容。

### 相关记录

[资源模型](2026-09-05-client-resource-model.zh.md)拥有 `ctx.resources`、`useResource`、`dsh-resource://<type>/…` 地址语法以及"每个地址一份资源"的推理；[文本预览与文件树](../feature/2026-09-05-sidebar-text-preview-and-file-tree.zh.md)是 `read`、`list` 与 `file` 提供者随包交付的消费方；[右侧 Sidebar 停靠基础设施](../feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md)是它们打开进去的界面；[工作区文件链接](../feature/2026-07-31-web-workspace-file-links.zh.md)是经 HTTP 供文件被否决之处。任何在这套体系上扩展的人都经 `remote.workspaceFiles` 触达同样的七个方法、经 `useResource<'file'>` 触达同样的 `file` 资源；线路类型以 `@deepseek-ai/dsh-api-workspace-files/types` 发布。[工作区文件读取权限](2026-09-09-workspace-file-read-authority.zh.md)负责 Host 读取权限与 HTML 安全取舍；[Document Preview](2026-09-08-document-preview-operations.zh.md)负责内容加载和逐 tab 新鲜度。

## Alternatives considered

**把工作区文件端点留在 Session Controller 上。** 最初形态：总字节上限之下的一个 `read`，作为 Session Controller 的子插件注册，因为线路入口本来就在那里。被否，因为 Workspace File 服务是自己的能力——读取和 stat 文件，并列举和观察工作区——这些查询应归于一处，而 Session Controller 关心的是会话生命周期。搬出也让服务长到五个方法而不给 Controller 的文件添第二重目的。

**带有反向 UI 依赖的双面包。** 拆包选择源于 `api/remotes` 引用 Client 叶子后形成的两条工程引用环：资源模型为了结果类型引用 Remote 装配，文件提供者为了 Sidebar 参数表引用右栏 UI。TypeScript 以 `TS6202` 拒绝这些环。[双面包组织](2026-09-07-workspace-files-dual-face-package.zh.md)取代拆包选择：结果类型直接取自协议包，Sidebar 参数注册移至文本预览；保留两个根聚合中的显式编译入口。

**经 HTTP 供工作区文件。** 已被[工作区文件链接](../feature/2026-07-31-web-workspace-file-links.zh.md)以 origin 理由否决且未重议：`read` 与 `readBytes` 经认证的 Remote 载体传送纯文本与 base64，因此不供文档、不铸 URL，也不产生 origin 问题。

**文件读取采用“日志可达”或工作区包含授权。** 唯一把文件内容送过线路的先例——命令附件——只授权出现在会话日志里的文件，这会排除手输路径；工作区包含则会排除 Session 后端其他位置的可读文件。[工作区文件读取权限](2026-09-09-workspace-file-read-authority.zh.md)改为以后端读取决策为准，只对工作区形态的操作保留包含限制。

**为字节窗口整文件读取再切片。** `readBytes` 的临时形态经 `readBytes(target, signal, offset + length)` 从文件开头读到窗口末端再切片。它读不了比该末端更长的文件的窗口——seam 会以过大拒绝这样的文件——因此没有任何窗口能报告 `eof: false`，与该方法存在的理由相悖。被否，改为以窗口为界的 `readByteRange` seam。

**把文件字段命名为 `url`（或 `hostUrl`）。** Session Controller 的 `WorkspaceFileText.url` 是 Host 侧文件的 `file:` URL。资源地址出现后即被否：线路上的 URL 读起来像地址，而这个不是——它只是地址所携同一路径的另一种编码拼法，Client 必须解码才能匹配变更帧。线路字段按其所是命名，因此字段为 `absolutePath`，`changes` 帧携带同一字段。

**在 `FileSystem` 基类里给 `readByteRange` 一个默认实现。** 基于 `readBytes` 的非抽象默认能免去测试替身一个方法，但只能靠把文件从头读到窗口末端来实现——正是上文否决的行为——或者传一个无界上限。改为抽象方法，由每个提供者与替身实现。

**工作区操作使用字符串前缀包含判定。** 把解析后的路径字符串与根比较比 `fs.contains` 简单，但 `resolve` 会取 realpath，离开根的符号链接解析到根外路径，而对未解析拼法的前缀测试会放行；对已解析拼法的前缀测试也仍需后端对"同一文件"的定义。`list` 与 `changes` 由文件系统判定包含关系。

## Consequences

- 工作区文件访问由 `api/workspace-files` 的 Host/Client 两面共同承担；Session Controller 不携带其中任何实现，两面的编译与运行时入口保持独立。header-only Session scope 让普通、subagent、live 与 cold Session 都能解析自己的相对路径，不需要 Agent 生命周期，也不回退父 Session。
- 任意大小的文件都能打开：文本按行页、任何文件按字节窗口，在 Host 上各自只花一页或一窗内存；全文读取则受 `maxFileBytes` 约束；代价是消费者自己拼装页面，且单行超过 `maxBytes` 的行没有任何页，因为页按行切。
- 每个文件系统提供者都提供开窗的原始读取；`fs-local` 直接定位到所请求的偏移量。
- 线路上的路径是规范的：`absolutePath` 与变更帧以符号链接已解析的拼法命名文件。跟随者绑定到成功的 `stat.absolutePath`，因此同一文件的另一种拼法——经符号链接到达的工作区根——也使用该规范变更键。
- 变更帧只报告 agent 自己的操作。用户编辑器、shell 或子进程改动的文件不产生帧；agent 仅仅读取一个被别处改动的文件却会产生帧，因为读取观察到了新版本。
- 文件类型检查先于后端读取，`list` 也先报种类再报根外位置。页的 `version` 可能落后内容一次写入，停滞的 `changes` 消费者会让 Host 内存增长，因为一代流的队列无界；每一条都是包 README 记录在册的已知取舍。
- `file` 资源推送变更而非内容，因此预览不靠载荷就得知文件已更新并读取它想要的页；失败的打开继续跟随地址，因此 agent 创建该文件时 tab 无需用户动作即恢复正常。
- `readBytes` 尚无随包交付的消费方；Document Preview 对整文件格式使用 `readAll`。

## Testing

`packages/api/workspace-files/tests` 中的 Host spec 覆盖 live 与 cold subagent Session 的 header-only scope 解析、部署 fallback、缺失身份与 lookup 释放；分页读取（整文件、嵌套路径、空文件、多字节 UTF-8、行窗口边界、缺省与拒绝的 limit、保留回车）；字节窗口（缺省、中段与尾窗、越界与空文件、base64 往返、版本、上限、坏范围以及无大小时的 `eof`）；`stat`；工作区外读取及后端拒绝；`list` 的包含、截断、符号链接与 `not-directory`；以及由 `fs/observed` 驱动并按根过滤的 `changes`。Client spec 覆盖提供者帧、变更流、不支持地址及注册与释放。`fs/fs` 与 `fs-local` spec 钉住 `readByteRange`；`dsh-util-workspace-path` spec 钉住文件地址语法。connection fixture 为 web e2e 套件提供 `stat`、分页 `read`、`list` 与一帧可选启用的 `changes`。

## Deferred

- 给 `changes` 一代流的队列加上限。
- `readBytes` 随包交付的消费方（图片与二进制预览）以及任何写入、搜索或媒体路由；本服务只读。
- 文件地址中 `session` 之外的作用域；语法留有余地，提供者只服务一个。
