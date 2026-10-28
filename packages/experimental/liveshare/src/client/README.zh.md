# Liveshare viewer 访问

[English](README.md) | 中文

viewer 页面只提供调用方 Peer 访问快照（`remoteAccess/follow`）包含的写操作；该快照由 owner 的 Gateway 经 Liveshare share-viewer policy 回答。各界面读取各自的访问钩子。Session 的快照不含 `session/prompt` 与 `session/cancel` 时，composer 隐藏发送与停止。轮次末尾的分支操作与 viewer 自己的分支行只在快照含 `session/fork` 时出现。会话与工作区管理条目对快照不含的端点自行隐藏。附件接收跟随 `fileUploads/upload`；分享向读者提供的每条会话都会授予它，档位与分叉开关都不决定它。Host 仍对每次调用强制鉴权。

分享自身的回答（`/__liveshare/context`）给出页面的 mode 与原因。快照不允许向本页展示、创建或切换到的 Session 发送提示时，该 Session 的 composer 带一个 block，说明页面级原因：无法确认的分享，已停止、过期或被撤销的分享，分支上的只读 mode，或通用只读说明。快照不带每个 Session 的拒绝码，因此不说明某个 Session 自己的拒绝原因。`forkLineage` 描述该行，不授权发送提示或停止。

下发的 index 携带读者自己的起始访问快照，因此页面从首次渲染起只提供该读者可调用的入口。快照流失败之后，所有访问答案均为 false，页面不提供任何写入入口；Host 无论如何都会拒绝每个调用。Connection 失去载体时，页面显示离线，直到重新连上一个 generation。

持久化的 `user/message` source 带 `share-viewer` principal 时，会在 Chat 官方 user 气泡上方显示读者由 Relay 断言的主体，文案来自 `liveshare` 字典的 `inputOrigin.sharedSession`。客户端在两种页面上都向 Chat 的 `conversation.chat.user.before` chain seat 注册一个条目；条目的 selector 只选中 source 带合法 `share-viewer` principal 的 `user` 行，owner 发起、结构非法与 steering 行都保持官方行未改动。主体过长时标签省略，不撑宽气泡。
