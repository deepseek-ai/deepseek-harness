# Agent Note: Sidebar 文件预览与目录树按需监听并自动刷新

Status: implemented

[English](2026-09-17-sidebar-file-and-directory-auto-refresh.md) | 中文

## 问题

Sidebar 的 Document Preview 和 Files 面板都需要反映磁盘上的最新状态。变化来源包括 Harness 文件工具、Shell 命令、用户编辑器，以及其他进程；只监听 Harness 自己的文件操作不够。

起始实现已有两条读取路径，但缺少完整的自动刷新链路。

| 对象 | 起点行为 | 缺口 |
|---|---|---|
| 文件 Resource | `ResourceProvider.open()` 提供初始元数据和后续变化，`ResourceRegistry` 管理订阅及持有期，组件通过 `useResource` 读取 | 文件变化源不是系统级 watch |
| Document Preview | `TextPreview` 已比较 Resource 版本与正文版本，并提供三种加载模式的 reload | 检测到变化后仅提示用户点击重新加载 |
| Workspace 文件事件 | `WorkspaceFiles.changes()` 转发当前 Session 的 `fs/observed`，客户端按文件过滤 | Host 不知道具体关注哪些路径；外部编辑器和 Shell 修改不会产生这类事件 |
| Files 面板 | `filesFace` 读取目录，`createFilesStore` 保存已加载层级及展开状态 | 新增、删除、重命名后需要手动刷新；展开过的目录再次打开可能直接展示旧缓存 |

`Resource` 当前承载文件元数据，不持有预览正文。正文由 Document Preview 或它选择的渲染器读取。因此，“元数据更新”和“重新加载正文”应保持各自的职责，不把正文缓存搬进通用 Resource，也不要求每个渲染器直接接触文件系统监听。

## 决策

按需监听连接现有 FS、Workspace 文件流、Resource 和 Sidebar 组件。文件与目录共用系统监听能力和现有 Remote 流传输，但消费方式不同。

- Document Preview：监听当前文件，Resource 发布新元数据，预览自动调用已有 reload。HTML 的根文件和引用的 CSS／JS 都加入同一个 `ResourceGroup`，任一成员变化都使整个 HTML 预览失效。
- Files 面板：以目录节点树管理读取和监听。每个已打开的目录节点只加载并监听自己的直接子项；Client 打开多少层子树，就逐层加载并订阅多少层，不提前遍历未打开的后代。
- 折叠目录时释放该目录及其不可见后代的监听；再次展开时重新订阅并读取，不能把折叠前缓存当作最新结果。
- 监听只传元数据或失效通知；正文仍走现有文件读取接口，目录内容仍走 `list()`。
- 使用本地 Chokidar 系统监听，不定时轮询整个 Workspace，不默认递归扫描所有后代。
- 保留两个面板的手动刷新入口和自动刷新开关功能，但暂时隐藏开关的 icon 按钮。开关状态及切换逻辑不变，新 Tab 默认开启；隐藏入口不关闭监控或自动刷新。

变化通知触发现有 reload／list；刷新失败后不保留旧预览内容。下面说明实现对象的职责、数据流及验证。

## 实现对象与职责

### FS 与 Host

| 类或类型 | 所在文件 | 职责 |
|---|---|---|
| `FileSystem` | [fs/src/index.ts](../../../../packages/fs/fs/src/index.ts) | 声明单目标 `watch(target, changed, signal)` 方法；文件观察自身，目录观察直接子项；就绪后返回异步关闭函数，基类以 `FS_IO_ERROR` 拒绝，不支持监听的提供方无需覆写，也不新增 FS 错误码 |
| `FsTarget` | [fs/src/types.ts](../../../../packages/fs/fs/src/types.ts) | 沿用现有目标类型，不单独增加 FS 监听事件体系，也不让上层解析 `targetKey` |
| `LocalFileSystem` | [fs-local/src/index.ts](../../../../packages/fs/fs-local/src/index.ts) | 文件监听其父目录并过滤到目标，目录监听自身；等待 Chokidar 就绪和关闭；依赖声明在 `fs-local` |
| `SandboxedFileSystem` | [fs-sandbox/src/index.ts](../../../../packages/fs/fs-sandbox/src/index.ts) | 继承本地只读监听能力，不复制 watcher 实现；保留自身对写入、编辑的策略检查 |
| `SshFileSystem` | [fs-ssh/src/index.ts](../../../../packages/ssh/fs-ssh/src/index.ts) | 继承基类的 `FS_IO_ERROR` 拒绝；Host 将其转换为 `workspace-file/watch-unsupported` 的 `RemoteError`，不跨包导入或判断 `FsError` 实体，也不把远端 `processPath()` 传给本机 Chokidar |
| `WorkspaceFiles` | [workspace-files/src/index.ts](../../../../packages/api/workspace-files/src/index.ts) | 使用仅携带目标路径的 `changes(scope, path, signal)`；Host stat 决定是否执行目录包含检查，目标类型变化后也检查，普通文件沿用文件读取权限 |
| `WorkspaceChangeFeed` | [workspace-files/src/changes.ts](../../../../packages/api/workspace-files/src/changes.ts) | 在现有 follow 中建立目标 watch，发送就绪和变化；保留原队列与操作观察入口，出流前过滤目标，不重写整套分发逻辑 |
| `ChangeFollower` | [workspace-files/src/changes.ts](../../../../packages/api/workspace-files/src/changes.ts) | 接收操作观察与 OS 通知，处理监听错误；关闭独立于生成器拉取进度，并等待 watcher 关闭完成 |
| `WorkspaceFileWatchFrame` | [workspace-files/src/types.ts](../../../../packages/api/workspace-files/src/types.ts) | 仅传路径的请求沿用 `ready`／`change` 帧，不增加请求 kind 或独立目录帧格式 |

### Client 与 Sidebar

| 类、函数或类型 | 所在文件 | 职责 |
|---|---|---|
| `ChangeFeed`、`SessionFeed`、`Follower` | [workspace-files/src/client/change-feed.ts](../../../../packages/api/workspace-files/src/client/change-feed.ts) | 将流的键改为 Session 加目标路径，继续复用既有就绪、路径绑定、取消和重连逻辑；此版不为了命名重排类结构 |
| `createFileResourceProvider` | [workspace-files/src/client/provider.ts](../../../../packages/api/workspace-files/src/client/provider.ts) | 将文件地址中的 Session 与路径传给目标流；首次读取及后续通知都发布完整元数据，不能只换 `version` 而继续沿用旧 `bytes` |
| `ResourceRegistry`、`ResourceProvider`、`UseResource` | [Resource 定义](../../../../packages/client/resources/src/client/contract.ts)、[ResourceRegistry](../../../../packages/client/resources/src/client/resources.ts) | 保持现有流、持有计数和订阅模型；不新增第二套 `onChange`，不为此增加通用正文 reload API |
| `TextPreview` | [TextPreview.tsx](../../../../packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx) | Resource 或 group 变化且开关开启时自动触发现有 reload；保留错误状态与手动刷新，独立自动刷新按钮暂时隐藏 |
| `textFace`、`TabReads`、`createTextStore` | [预览 face](../../../../packages/client/ui-sidebar-documentpreview/src/client/face.ts)、[预览存储](../../../../packages/client/ui-sidebar-documentpreview/src/client/store.ts) | 每个 Tab 持有一个 group，补充默认开启的 `autoRefresh` 和表示待刷新的 `resourcesDirty`；复用正文读取代次与 `loadRevision` |
| 包内 `ResourceGroup` | [resource-group.ts](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/resource-group.ts) | 通过现有 `resources.source(address)` 观察成员；`add` 加入资源，`set` 更新完整成员列表，`close` 释放全部成员，不改变通用 Resource 服务 |
| `DocumentBodyOwner`、`HtmlBody`、`createReadHtmlRelative` | [渲染器输入](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts)、[HTML body](../../../../packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx)、[关联文件读取](../../../../packages/client/ui-sidebar-documentpreview/src/client/html/read-relative.ts) | 渲染器通过 `addResource` 声明读取到的成员，通过 `setResources` 提交本次依赖列表；HTML 在每次读取返回后按 Host 报告的路径加入 CSS／JS 资源，解析结束后释放不再引用的成员 |
| 各文档渲染器 | [DocumentContent](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts) 及同包各渲染器目录 | 不接 watch；继续消费文本、字节或 renderer revision；`failed()` 结束渲染器加载但不记录成功版本。检查刷新时取消旧任务、释放旧对象及保留现有视图偏好 |
| `filesFace`、`FilesInjected` | [Files face](../../../../packages/client/ui-sidebar-files/src/client/face.ts) | 继续作为已有业务入口，直接持有各 Tab 根节点；绑定目录读取和变化流，转发展开、折叠、刷新及自动刷新开关，不新增 `FilesController` |
| 包内 `DirectoryNode` | [directory-node.ts](../../../../packages/client/ui-sidebar-files/src/client/directory-node.ts) | 表示一个已打开的目录，拥有本目录变化流、读取状态和已打开子节点；负责局部刷新、展开、递归关闭，以及向子节点传递自动刷新状态；`setExpanded` 按最新展开偏好更新待恢复节点 |
| `createFilesStore`、`FilesTabState`、`LevelState` | [Files store](../../../../packages/client/ui-sidebar-files/src/client/store.ts) | 保留展开、滚动和目录显示数据；区分首次加载与已有内容上的刷新，避免每次后台重读都把子树卸载；不保存 watcher 或 AbortController |
| `FilesBody`、`Level`、`Entry` | [FilesBody.tsx](../../../../packages/client/ui-sidebar-files/src/client/FilesBody.tsx) | 将展开、折叠、刷新和面板卸载交给注入回调；按节点展示结果渲染，不扫描整棵树生成监听集合，展示仍只读已有框架钩子与存储 |
| Files 注册入口 | [Files client/index.ts](../../../../packages/client/ui-sidebar-files/src/client/index.ts) | 给现有 `filesFace` 增加目录变化流回调；异步副作用留在注入实现，不引入另一个功能插件的运行时导出 |

## 监听接口与事件内容

### 一条流对应一个明确目标

每个请求指定一个目标路径；Host 通过 `stat` 确定当前实际类型，Client 不传文件／目录 kind。

```text
changes(sessionId, path, signal)
changes(scope, path, signal)
```

Host 方法仍通过 `WorkspaceFileScope` 接收解析后的 Session 上下文。Client 传 Session id，不能自行伪造 Host 的工作目录或权限。

当前目标是目录时，Host 就检查 Workspace 包含关系；原本缺失或为普通文件的目标变成目录后也执行检查。Workspace 外的普通文件仍可通过所选 FS 读取与监听。

| 通知 | 内容 | 消费方动作 |
|---|---|---|
| 就绪 | 当前一代目标监听已经建立 | 执行首次或重连后的 `stat()`／`list()`，接收读取期间排队的变化 |
| 文件存在或更新 | 沿用路径和版本通知；Client 收到后重新 stat | 用完整结果更新 Resource 的路径、版本和大小；自动刷新开启时重新读取正文 |
| 文件缺失 | 目标路径和缺失状态 | Resource 报告不可用，预览保留已加载内容并显示错误 |
| 目录失效 | 目录目标流中的 `change` 帧 | 只重新调用这个目录的 `list()`，不按目录版本去重，也不刷新整棵树 |
| 监听失败 | 初始化失败报告 `workspace-file/watch-unsupported`；运行期错误结束监听 | 客户端在监听接入处处理失败，普通读取与手动刷新仍可用；不伪装成文件删除 |

不用把文件正文、完整目录列表或每个变化的补丁塞进通知。文件名由路径表达；文件大小来自当前 stat；修改时间若只为判断变化，继续由后端版本 token 表达，不要求 UI 解析 token 或另外引入时间戳比较。

Resource 发布的路径、版本和大小来自同一次 stat。先沿用现有小通知，再由 Client stat，避免为了减少一次请求扩大事件协议。目录变化不应只比较目录自身 mtime：直接子文件的大小或类型变化也可能影响 `list()` 返回值，应按相关子项事件使目录列表失效。

### 系统监听与访问范围

- `FileSystem.watch()` 接受本提供方解析出的目标；本机或远端路径的含义由 FS 提供方负责。
- 文件监听保持文件读取的访问规则。现有预览允许通过所选 FS 读取部分 Workspace 外的路径，不能把目录树的范围限制顺手强加给这些文件。
- 目录监听保持 `list()` 的 Workspace 范围及路径检查，目标类型变化后也执行检查，不因新增 watch 扩大目录浏览权限。
- 父目录保持存在时，文件监听覆盖原地写入、临时文件替换、删除和同一路径重建。本地提供方直接监听父目录，将条目和事件过滤到目标文件，等待父目录 watcher 就绪后才报告就绪，目标文件尚不存在时也适用。
- 目录监听只关注该目录自身和直接子项，不递归打开尚未展开的子目录；直接子项的创建、删除、重命名、类型或可见元数据变化都使这一层失效。
- 本地实现采用系统事件模式；若需要调整写入稳定时间、事件合并窗口等部署参数，应由拥有它们的配置声明，不散落在组件里。
- 系统 watch 只驱动 UI 刷新，不把外部磁盘变化伪装成某个 agent 已读取文件的 `fs/observed`，不改变文件编辑的已观察版本策略。

## 文件预览的完整数据流

```text
Files.openResource / file.link
  → Sidebar.openTab
  → TabDomain → Resource.pin
  → ResourceRegistry → createFileResourceProvider.open
  → changes(sessionId, path)
  → WorkspaceFiles → FsTarget
  → WorkspaceChangeFeed → FileSystem.watch
  → LocalFileSystem → Chokidar
  → ready → Client.stat → ResourceSnapshot

Editor / Shell / file tool → disk
  → Chokidar → LocalFileSystem
  → WorkspaceChangeFeed → FileSystem.stat
  → Remote.change
  → Client.stat → ResourceSnapshot
  → ResourceGroup → TextPreview
  → reloadPages / reloadAll / prepareRenderer
  → DocumentContent / renderer revision
  → renderer
```

预览正文可以与元数据初始化并行读取。ResourceGroup 以各成员首次元数据为基线，只转发后续变化，不做首读版本对账。

| 加载模式 | 已有刷新入口 | 刷新结果 |
|---|---|---|
| `text-pages` | `reloadPages()` | 废弃旧正文代次，重新读取文本页；不能混合不同版本的页 |
| `bytes-complete` | `reloadAll()` | 重新读取完整字节，PDF、HTML、图片等消费新字节 |
| `renderer` | `prepareRenderer(..., reload = true)` | 增加 `loadRevision`，渲染器取消旧加载并重新请求；Office 失败通过 `failed()` 结束加载，后续文件变化可重试 |

普通渲染器不需要添加 `watch()` 或新的 reload 接口。已有 `DocumentContent` 中的文本、字节和 revision 变化已经能驱动重新加载。

## HTML 的 ResourceGroup

一个 HTML 预览的 group 包含 HTML 根文件，以及现有 HTML 打包器实际读取的 CSS／JS 文件。成员都是普通文件 Resource，不为依赖另建 watcher 或额外文件类型。group 是预览包内对象，复用 Resource 已有的订阅和持有计数。

```text
index.html Resource ─┐
theme.css Resource ──┼→ ResourceGroup → resourcesDirty → autoRefresh → HTML reload
page.js Resource ───┘
```

- `addResource(address)` 在 `readRelated` 返回 Host 解析的 `absolutePath` 后将依赖加入 group；已有成员不重复订阅，不传递或保存正文读取版本。
- `setResources(addresses)` 提交本次解析出的依赖列表；预览拥有者始终保留根文件，其余未再出现的成员释放订阅。
- CSS／JS 引用使用 HTML 所属 Session，由 Host 解析路径。读取失败时也保留 Host 提供的字符串 `error.details.path`；没有该路径时，Client 不自行猜测。
- HTML 本身没有改变，但 CSS 或 JS 改变时，也重新加载整个 HTML，生成新的 iframe 内容。
- 缺失依赖有 Host 报告的路径时仍保留为成员；解析失败时保留已经发现的依赖，后续成员变化可以再次触发加载。
- 新成员的首次元数据仅建立基线，不使预览失效；只有后续元数据变化才通知，首次读取不另做版本对账。
- group 变化只把 `resourcesDirty` 置为 `true`；开始刷新时清除，读取期间再次变化则重新置位。不累计次数，也不增加另一套读取代次。
- 关闭预览 Tab 时释放整个 group。关闭自动刷新仅停止自动重读，group 继续观察并记录陈旧状态。

此版覆盖交互式 HTML 打包器现有支持的直接 stylesheet 链接和普通 JS 脚本，不顺手增加 CSS `@import`、ES module 图或运行时网络请求的依赖发现。新打开的静态安全预览不读取关联文件，只观察根文件。从交互式 HTML 切换到静态预览时释放依赖监听，只保留根 Resource。

## 自动刷新开关

Document Preview 和 Files 各自保留原 reload 按钮。独立自动刷新开关的 icon 入口暂时隐藏，状态、切换逻辑、文案和样式保留；新 Tab 仍默认 `autoRefresh: true`。隐藏不改变开关状态，也不停止观察。

| 状态或操作 | 行为 |
|---|---|
| 自动刷新开启 | 开关高亮，使用已有暂停图标，提示“关闭自动刷新”；变化自动刷新对应预览或目录节点 |
| 点击关闭 | 开关显示播放图标，提示“开启自动刷新”；继续观察变化，但不自动替换当前内容 |
| 点击重新开启 | 若暂停期间已有变化，立即补一次刷新；之后继续自动刷新 |
| 点击原 reload | 无论开关状态如何，都主动读取一次，不改变开关状态 |
| 自动刷新关闭时展开新目录 | 新目录仍正常首次加载并订阅；开关只控制后续变化引起的自动重读 |

暂停／播放使用现有图标，手动 reload 保留环形箭头，不新增图标系统。按钮通过 `aria-pressed` 表达状态，名称和提示走现有 locale 字典。

## Files 面板的完整数据流

```text
Files.open
  → FilesBody → Session.cwd + Tab
  → filesFace.start → DirectoryNode.open
  → changes(sessionId, path)
  → Host.watch(depth: 0) → ready
  → DirectoryNode → list(sessionId, path)
  → createFilesStore.levels[path]
  → Level / Entry

Entry.expand
  → filesFace.toggle
  → DirectoryNode.expand → child.open
  → child.watch → ready → child.list
  → createFilesStore.expanded + levels[path]

Process → create / remove / rename
  → Host.change(directory)
  → DirectoryNode.refresh → list(path)
  → createFilesStore.levels[path]
  → DirectoryNode.children ↔ list.entries
  → DirectoryNode.collapse → child.close
```

文件预览和目录树是两条独立的消费路径。预览文件可以在 Files 面板没有打开时自动刷新；Files 也可以在没有任何文件预览时自动更新目录项。无需把整棵目录树包装为一个 Resource，也不为此新增目录 Resource 协议。

目录面板直接通过注入的 Remote 业务回调取得失效通知和列表结果，显示值统一写回自己的存储；不绕过组件现有的读取方式，不让组件直接持有 Chokidar、Remote 迭代器或底层观察对象。

## 目录节点树与生命周期

Files 的运行时对象本身就是一棵按需打开的目录树，不先建立整棵 Workspace 树，也不另算一个扁平的 watcher 集合。现有 `filesFace` 持有各 Tab 根节点，读取、监听和释放逐层交给 `DirectoryNode`，不另抽控制器类。

| 节点职责 | 具体行为 |
|---|---|
| 本目录身份 | 持有该目录路径和所属 Session／Tab，文件系统根与 Windows 盘根均可作为树根，列表只包含直接子项 |
| 本目录监听 | 一个打开的节点持有一个目标变化流；收到通知只使本节点列表失效 |
| 本目录读取 | 持有有效 list 请求的代次，待补读状态持续到读取收尾后，结果通过存储 actions 发布 |
| 已打开子目录 | 按直接子目录路径持有子 `DirectoryNode`；未展开目录只是列表中的目录项，不创建活动子节点 |
| 展开 | 目录行触发展开时创建或复用对应子节点，再由子节点建立自己的监听与读取；恢复展开偏好时只打开列表中仍存在的目录 |
| 折叠 | 关闭并移除对应活动子节点；子节点递归关闭后代，然后释放自己的监听和请求 |
| 列表更新 | 保留仍存在的已打开子节点，关闭已删除、重命名或变为文件的分支；不重新打开所有节点 |
| 整树关闭 | 对根节点执行关闭，自然递归释放整棵活动子树，不另遍历全局监听注册表 |

`createFilesStore.expanded` 保存用户的展开偏好，但不是另一份监听注册表。父目录关闭后，即使存储保留了后代展开偏好，也不能继续持有这些后代的活动节点。重新打开时先读取父目录，再对仍存在且需要恢复的子目录逐层建立节点。即使父节点尚未创建，展开和折叠也会更新存储与待恢复状态；后代恢复时遵循最新偏好，不会重新打开已折叠的分支。

```text
workspace/                  watch
├── src/          open      watch
│   ├── components/ open    watch
│   └── internal/ closed    -
└── assets/       closed    -

collapse(src/):
workspace/                  watch
├── src/                    close(src/, components/)
└── assets/                 -
```

父目录的监听仍能发现折叠目录自身被删除、重命名或替换，但不负责发现其深层内容变化。再次展开时重新 list，补上未监听期间的变化。

| 用户操作或生命周期事件 | 文件预览 | Files 面板 |
|---|---|---|
| 首次打开 | 打开文件 Resource 监听并读取正文 | 打开根节点，由根节点建立监听并读取列表 |
| 展开子目录 | 无影响 | 父节点打开对应子节点；子节点监听并读取直接子项，按偏好逐层恢复仍存在的后代 |
| 折叠子目录 | 已打开的文件预览继续监听 | 释放该目录及其当前不可见后代的监听；可保留展开偏好和显示缓存 |
| 切走 Tab 或面板卸载 | Tab pin 继续持有文件元数据流；正文组件不在时不主动重读，切回来按待处理 Resource 变化与开关状态补刷新 | 此版沿用 Tab 生命周期，保留已展开目录节点和监听；不另外引入面板显隐生命周期 |
| 手动刷新 | 重用当前预览 reload，不重建整套 Resource | 从根节点递归刷新已打开子节点，不进入折叠目录，也不重建全部 watcher |
| 关闭最后一个持有者 | Resource abort，文件流结束，Host 等待 watcher 关闭 | Tab 关闭时终止全部目录流、取消读取并删除 Tab 状态 |
| 连接恢复 | 新流 ready 后重新 stat，即使断线期间没有可回放事件也能发现变化 | 新流 ready 后重新 list 所有仍需观察的目录 |

Files 监听跟随 Tab 生命周期；折叠关闭对应子树，关闭 Tab 则释放根节点与整棵活动树。暂时隐藏面板不额外拆除和重建节点，这使改动集中在现有入口和目录对象。存储保留展开偏好，节点只在重新展开时用这份偏好逐层恢复，不维护第二份全局展开集合。

同一个完整文件 Resource 地址的共享继续由 `ResourceRegistry` 完成。目录节点的父子所有权保证一个 Tab 内同一分支不会重复打开；第一版不增加跨 Session、跨窗口或路径别名的全局 watcher 去重系统。目录下的普通文件项不各自订阅文件 watch，只有真正打开为预览 Resource 的文件才取得独立文件监听。

## 用户可见动线

### 编辑已预览的文件

1. 用户从 Files 打开 Markdown、代码、图片、PDF、HTML 或 Office 文件。
2. 用户在外部编辑器保存，或 Shell 命令改写该文件。
3. 自动刷新默认开启，Document Preview 自动显示新内容；用户关闭开关后可保持当前内容，手动 reload 或重新开启时再读取。
4. 当前渲染器选择和换行偏好保留；文本滚动位置按现有机制恢复，内容缩短时只能落在新内容允许的位置。
5. PDF、HTML 和图片的精确阅读位置恢复不是本方案额外承诺；沿用各渲染器现有能力，避免为自动刷新加入一套跨格式定位系统。

### 浏览正在变化的目录

1. 用户打开 Files，根目录列表加载并开始监听。
2. 用户展开 `src` 和 `src/components`，两个子目录分别开始监听。
3. 外部工具在 `src/components` 创建文件，只有这一层列表刷新，其他目录不折叠、不重新加载。
4. 用户折叠 `src`，其自身和 `components` 的监听关闭，根目录继续监听。
5. 折叠期间外部工具继续修改内容；用户再次展开 `src` 时重新读取，依次恢复仍有效的子目录展开状态，不停留在旧缓存。

### 删除、重命名和失败

- 文件删除后，已有预览内容保留并显示不可用提示；父目录保持存在时，原路径重建后自动恢复读取。重命名视为旧路径消失和新路径出现，不根据 inode 自动改写预览地址。
- 目录删除或重命名后，父目录刷新移除旧行，并释放旧子树监听。新目录按新名称显示，不擅自转移旧路径的展开偏好。
- 自动刷新和手动刷新调用同一套已有 reload，沿用清空旧结果、加载及错误展示行为；不增加保留旧字节或旧 iframe 的分支。目录刷新保留现有列表缓存，避免重建活动子树。
- 后端不支持 watch 时，Host 把初始化异常转成 `workspace-file/watch-unsupported` 的 `RemoteError`；客户端结束监听，继续普通读取与手动刷新，不增加轮询。SSH 的外部磁盘变化不会自动更新预览。

## 就绪、竞态与刷新合并

监听、读取与展示只需要处理少数明确的顺序问题，不扩展成磁盘事务或操作日志。

- 先建立 watch，再发送 ready，然后取得初始 stat／list。读取过程中到达的变化不能丢弃；必要时再读一次，使最终结果收敛到最新状态。
- 事件表示“目标可能变化”，不是一次用户操作的精确回放。Chokidar 的重复通知和连续写入可以合并；文件按版本去重，目录按待刷新状态合并。
- 同一目录最多有一次有效 list 在途；在途或读取收尾期间再次失效，只记录需要补读，随后读取最新状态，不累计任意长度的刷新任务队列。
- 文件自动刷新复用读取代次和 renderer revision。连续通知不能让旧请求覆盖新内容，也不能因同一已处理版本而无限 reload。
- 目录后台刷新保留当前列表，不另存没有显示用途的 `refreshing` 标记；只有没有可显示列表时才进入 `loading`，避免子树闪烁和监听反复重建。
- 目录折叠、删除或 Tab 关闭后，已取消读取的晚到结果不得重新创建状态或恢复监听。即使生成器停在已产出的帧上，取消也会关闭 Host watcher；流与插件拆除等待关闭完成。
- 父目录保持存在时，文件短暂消失不结束监听；正常文件变化与监听自身失败分别处理。同路径文件监听覆盖原子保存与删除重建。
- 原有文件读取并非事务快照，stat 与正文读取之间仍可能发生写入；后续通知触发刷新，自动刷新不保证每次读取都获得原子快照。

## 不采用的替代方案

**在 Resource 上再加一套 `onChange` 和正文 reload。** 现有 `open()`、`source()`、`useResource` 已经表达变化，正文又不归通用 Resource 所有。重复接口会使元数据、正文和渲染器分别维护刷新状态。

**整个 Workspace 递归 watch。** 打开一个文件或一个根目录不应导致监听所有深层目录。按当前文件和展开目录取得监听，资源使用量与用户实际打开的内容相关。

**保留 Session 广播流，再增加路径注册／退订协议。** Host 需要知道具体目标，但不必再维护一个由额外命令修改的路径集合。一目标一流可以直接复用现有取消、重连和结束语义。

**直接下发正文或完整目录列表。** 这会混合监听与内容读取，还要重复分页、字节限制、文件格式和目录条目限制。小通知配合现有 `read()`／`list()` 更直接。

**根据变化事件在客户端增删目录行。** 文件系统通知可能合并或重复，目录列表还有排序、类型和条目上限。重新 list 受影响的一层即可保持现有语义，不需要维护目录增量合并算法。

**在 Workspace API 中直接调用 Chokidar。** API 不拥有执行世界，SSH 路径可能只在远端存在。watch 必须由实际 FS 提供方实现。

## 验证

FS、Workspace API、预览和 Files 各自的测试覆盖监听生命周期、元数据更新和自动刷新。[Web 文档预览测试](../../../../apps/web/tests/document-preview.e2e.ts) 从正式 Web 组合验证文件预览。会话事件日志、持久化格式和模型输入均不变。

| 场景 | 已验证行为 |
|---|---|
| 外部原地写入、原子替换、Shell 写入 | 打开的文件预览自动更新，不依赖 `fs/observed` |
| 文本、完整字节、自主加载渲染器 | 三种模式都刷新，旧请求不能覆盖新结果，Office 失败后允许后续文件变化重试 |
| 成员首次元数据 | 仅建立基线，不额外 reload，也不做首读版本对账 |
| HTML 根文件不变，仅 CSS／JS 改变 | group 触发整个 HTML 重新加载 |
| HTML 删除一条依赖引用 | 本次 group 更新后释放不再引用的成员 |
| 关闭自动刷新后修改，再手动刷新或重新开启 | 暂停期间保持内容，手动操作或重新开启后补刷新；按钮职责独立 |
| 根目录直接子项新增、删除、重命名 | Files 根层自动更新，工作区为文件系统根或 Windows 盘根时也适用 |
| 已展开子目录变化 | 只刷新对应目录层，保留其他层与展开偏好 |
| 未展开的深层目录 | 不创建深层 watcher，不递归遍历 |
| 折叠父目录 | 释放它和不可见后代的监听；文件预览若仍打开则独立继续监听 |
| 祖先恢复期间折叠或重新展开深层后代 | 立即记录最新偏好，恢复时只打开仍需展开的分支 |
| 重新展开、切回 Files、连接恢复 | 重新读取当前列表，不依赖错过事件的回放 |
| 文件删除后重建，或子目录替换为文件 | 父目录保持存在时，文件监听在同一路径恢复；目录列表释放失效子树 |
| 快速写入、重复通知、读取中或收尾时再修改 | 有限次补读并收敛到最新状态，不无限刷新 |
| 关闭 Tab、卸载插件、取消初始化 | 即使不再拉取下一帧，所属监听也完全关闭；晚到通知和读取不再写入状态 |
| 不支持监听的提供方、越界目录请求 | 明确报告支持状态或访问错误，不观察错误执行世界或扩大目录权限 |

可控事件源和延迟读取验证就绪、取消及恢复期间的展开操作。真实本地 watch 测试使用临时目录，等待 watcher 就绪后再操作，通过观察到的状态结束，不靠固定 sleep 猜测事件时机。Web 预览测试和包内 UI 测试覆盖用户可见行为；命令执行结果记录在 PR 中。

## 影响

- Linux 上父目录删除并重建后的自动监听恢复仍延期；父目录保持存在时，同路径文件重建仍受支持。
- OS 文件事件不是持久消息，断线或进程重启可能丢通知，因此每一代流就绪后都要重新取得当前状态。
- 多个已打开文件和展开目录会增加 watcher 与流数量；第一版用按需生命周期控制数量，不提前加入复杂的跨消费者去重服务。
- 自动刷新可能打断阅读，尤其是 HTML 内部交互和 Office 转换。保留视图偏好、合并连续变化，但不承诺保存任意嵌入文档的运行状态。
- HTML 的 CSS／JS 通过现有解析器进入 group；更深依赖、图片依赖和运行时动态加载不作为这次修改的额外解析工程。
- SSH 远端系统监听需要独立的远端实现策略；这里要求接口如实表达不支持，不使用本机 watcher 或隐式轮询冒充远端能力。

## 与已有 Agent Note 的关系

自动刷新和系统监听保留已有 Resource 模型、文件读取授权和渲染器职责。以下记录仍有独立的设计理由；本文负责目标级监听、自动 reload 和目录监听生命周期。

- [Client Resource 模型](../../implemented/architecture/2026-09-05-client-resource-model.zh.md)：保留地址、提供方、订阅和持有期；新增行为由已有流承载。
- [Workspace 文件服务](../../implemented/architecture/2026-09-05-workspace-files-service.zh.md)：读取与列表接口职责不变；目标级系统监听替代仅转发操作观察的 Session 流。
- [文档预览操作](../../implemented/architecture/2026-09-08-document-preview-operations.zh.md)：正文加载所有权和三种加载方式不变；自动刷新使用其现有 reload 路径。
- [Workspace 文件读取授权](../../implemented/architecture/2026-09-09-workspace-file-read-authority.zh.md)：保留文件读取与目录浏览的不同访问范围；目标 watch 分别遵循对应规则。
- [Sidebar 文本预览与文件树](../../implemented/feature/2026-09-05-sidebar-text-preview-and-file-tree.zh.md)：按 Tab 的展开、导航和滚动状态不变；已打开节点负责目录自动失效与监听。
