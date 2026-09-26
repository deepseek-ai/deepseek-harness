# 通过提示词配置持久化插件

[English](dynamic-cordis.md) | 中文

创造模式提供 [Plugin Manager](../../../../packages/boot/plugin-manager/README.zh.md) 和只读[运行时检查](../../../../packages/extensions/tool-cordis/README.zh.md)。插件配置属于当前 profile，影响其会话，并在进程重启后保留。

## 连接 MCP 服务器

启动 Web profile 并选择创造模式。准备一个可访问且提供 `ping` 的 Streamable HTTP MCP 服务器，将其实际端点填入以下提示词：

> 将 `<endpoint>` 处的 MCP 服务器配置到当前 profile，命名为 `demo`。立即启用它的工具，然后调用它的 ping 工具并告诉我结果。

agent 编写纯配置组合包，在 patch 中插入 `@deepseek-ai/dsh-mcp-client`，再通过 `plugin_manager install_bundle` 安装。启用 HMR 时，工具会出现在同一个运行中的会话里。同时检查管理结果（`application: applied`）和成功的 `mcp__demo__ping` 调用。返回 `restart-required` 的已保存条目尚未激活；失败条目需要修复配置。

修改配置前先读取组合包 patch。使用 Plugin Manager 停用条目或移除组合包。可接受的配置及连接失败行为见 [MCP client 参考](../../../../packages/mcp/mcp-client/README.zh.md)。
