# Agent Note: Workspace 完全限定路径

Status: implemented

[English](2026-09-03-fully-qualified-workspace-paths.md) | 中文

## 问题

Workspace 路径身份必须在不依赖进程状态的情况下指向唯一目录。POSIX 相对路径、`C:work` 等 Windows 驱动器相对路径，以及 `\\work` 等 Windows 当前驱动器根相对路径，可能依据宿主 cwd 或驱动器保留的当前目录完成解析。把这些拼写传给 `realpath`，会在宿主状态变化时注册不同目录。文件系统根目录的 basename 也为空，可能产生空的默认 Workspace 标题。

浏览器安全的相对路径连接还需要单独处理 Windows 驱动器根。移除 `C:\\` 的尾部分隔符会得到 `C:`，从而把绝对路径变成驱动器相对路径。

## 决策

`WorkspaceRegistry.create()` 和 `resolveByPath()` 会在调用 `realpath` 前拒绝不是完全限定形式的路径。POSIX 要求绝对路径。Windows 要求 `win32.isAbsolute(path)`，且解析出的根既不是 `\\` 也不是 `/`；该规则接受驱动器限定路径与 UNC 路径，同时无需维护第二套路径语法即可拒绝当前驱动器根拼写和驱动器相对拼写。

规范路径继续作为注册表身份。默认标题使用最终路径段；该路径段为空时，则使用 `node:path` 解析出的根。该规则细化了[接纳 basename 相同 Workspace](2026-07-31-same-basename-workspace-adoption.zh.md)拥有的显示规则，但不会要求标题唯一。

浏览器安全的 `resolveWorkspacePath()` 会先根据 Workspace 拼写选择分隔符，再移除尾部分隔符。使用反斜杠的驱动器与 UNC 路径保留 `\\`，使用正斜杠的驱动器路径保留 `/`，与驱动器根连接时始终保留冒号后的分隔符。

## 考虑过的替代方案

**依据宿主 cwd 解析相对路径。** 不予采纳，因为 Workspace 身份将依赖调用方未提供、远程客户端无法观察的进程状态。

**依据另一个已存储 Workspace 解析相对路径。** 不予采纳，因为 create 和 lookup 请求没有指定这种锚点，猜测锚点会让同一路径拼写指向不同记录。

**维护用于驱动器和 UNC 语法的正则表达式。** 不予采纳，因为 `node:path.win32` 已经解析根和绝对路径；第二套语法可能在分隔符变体和 UNC 根上发生偏差。

**为文件系统根目录使用空标题。** 不予采纳，因为标题是 Workspace 的主要标签。根路径拼写简短、稳定，并且已经可以区分驱动器与 UNC 根。

## 后果

调用方必须提交完全限定的 Workspace 路径。无效路径拼写会在文件系统访问前失败，而不存在的完全限定路径仍返回原始文件系统错误。Windows 驱动器根与 UNC 根继续作为有效身份，并具有非空默认标题；UNC share 根使用 share 名称作为最终路径段。

Workspace 相对路径连接会保留 Workspace 根中已有的分隔符风格。单元测试覆盖 POSIX 根、驱动器根、UNC 根、被拒绝的驱动器相对路径与当前驱动器根路径，以及两种 Windows 分隔符风格。
