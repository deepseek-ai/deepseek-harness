# Agent Note: Web 应用自有路由相对文档寻址

Status: implemented

[English](2026-09-14-web-document-relative-app-routes.md) | 中文

## 问题

浏览器对外壳自有路由的每一处引用都以源站根绝对形式书写：`/api/...` RPC、`/plugins/??...` 插件 bundle、Remote 流 mux、HMR 事件流，以及启动入口清理 token 时重定向到的 `/`。当一个监听端口位于剥离前缀的代理之后（例如 `https://host/tools/dsh/` 这样的挂载，把 `/tools/dsh/...` 转发为 `/...`），这些请求会落在源站根，那里没有任何路由应答：外壳、插件 bundle、流全部落空。同一份 bundle 必须同时服务源站根与任一挂载，而不能为此再构建一次。

挂载点无法从传输层恢复。配置 base URL 会把它变成部署输入，转发前缀推断会让请求头对路由具有权威性，代理内改写在碎片里重复同一事实。唯一已经知道挂载点的地方，就是所服务的文档自身。

## 决策

所服务的 HTTP 外壳拥有自己的文档 base。其 index 携带唯一的 `<base href="./">`，在原始 index 转换执行后拼接于起始 head 标签之后，因此它先于启动 manifest、每一行插件资源，以及任何转换插入的标记。该 base 冻结入口目录：`/mount/` 与 `/mount/index.html` 是受支持的入口，而文档 URL 之后移动（页面内 `pushState`）不会移动 base。系统不推断任何前缀，因此深层直接加载与重新加载不是入口；裸挂载仍需依赖代理自身的规范化补齐尾部斜杠。

浏览器对这些路由的引用相对该文档——`api/x`、`plugins/x`——而服务端路由键保持绝对路径名：RPC channel 键 `/api`、`webServer` 注册路径，以及以 combo 路由 `/plugins/??...&rev=...` 为键的响应表。命名路由键的共享常量（`*_PATH`、`*_ENDPOINT`）在边界处被剥去前导斜杠（`KEY.slice(1)`）后浏览器代码才使用，浏览器形式以 `*_ROUTE` 与之并列。

宿主在每个生产者里只在一处组合浏览器引用。模块启动图 row 与批次描述符携带文档相对的 combo 引用；source-map trailer 只携带 combo 查询，因为脚本的 source-map 引用相对该脚本自身目录（`.../plugins/`）解析，而非相对文档。响应表仍以绝对路由为键，而请求在代理剥去前缀后到达的也正是该路由。

启动入口遵循同一规则。`authenticatedUrl` 把进程 token 加到调用方的 URL 上并保留其 authority 与挂载；token 交换重定向到 `./`，移除 query token 的同时保留请求 URL 的目录。Host/Origin 栅栏与 cookie 规则不变。

需要绝对 URL 的消费方相对 `document.baseURI` 解析：Gateway 构造 WebSocket URL 并选择 `ws:` 或 `wss:` 时，以及 Inspector 从启动图定位自身 bundle 时。

Desktop 是另一个文档所有者。它的窗口加载 `dsh-app://app/`：该来源在根目录提供同一份 dist，并把其他所有应用路径转发给它拥有的 Host，因此它的文档目录本就是根目录，无需为它注入 base 行；它改为通过传输层的 `streamBaseUrl` 为 Gateway 指定该 Host origin。它的资源就位于该根目录，这也是所服务 HTTP 外壳的 `./` 不适用于它的原因。

## 曾考虑的替代方案

**把配置 base URL 当作路由 base（`publicUrl`）。** 否决：文档已经知道自己的 URL，因此这是为页面本可读取的事实引入第二个易漂移来源，而且必须把它接入每个消费方，而不是只做一次外壳决策。对外公告的公开 URL 仍是面向运维的打印／打开输入，不是路由输入。

**从转发前缀请求头推断挂载点。** 否决：这会让请求头对路由具有权威性，任何设置该头的客户端都能挪动应用自有路由，代理约定也会变成服务端可见的配置。

**共享 `Connection.resolveUrl` 或 routes base。** HTTP 载体的文档基准与 worker tunnel 的 Host 根路径映射不同。在 Connection 中统一解析所有目标，会把静态 preview 路径加到 worker 本地路由之前，或丢失所服务的挂载。各载体解析自己的目标；UI 资源消费方使用文档基准。

**保留绝对 `/` 重定向并让代理改写 `Location`。** 否决：浏览器已经知道请求所在目录，而配置出来的重定向目标无法同时适用于 loopback 入口与代理挂载。

## 后果

一份 bundle 服务源站根与任一挂载，所服务的文档是挂载点的唯一来源。代价是显式的：受支持的入口只有 dist 根与配置的 index 路径；裸挂载依赖代理的斜杠规范化；页面内深层路径重新加载会在该路径重新进入，而非冻结目录。

功能包自有的路由（open-in-app、deliverables、会话日志导出、上传、markdown 媒体）通过各自的 `*_ROUTE` 常量遵循同一规则；让浏览器源码持续遵守该规则的静态门禁随那些改动一并记录。

## 测试

frontend-static 的真实组合测试通过 Loader 提供 index，并断言唯一的 `<base href="./">` 先于注入的插件资源行与转换标记。client-modules node 半侧测试断言启动图 row、批次描述符与 source-map trailer 均为文档相对，而响应表仍按路由提供它们，客户端测试 roster 与 assembled-boot fixture 携带同一相对形式。`browser-auth.host.spec.ts` 覆盖 `./` 重定向与保留 authority 和挂载的 `authenticatedUrl`；`frontend-static.spec.ts` 与 `apps/cli/tests/web-auth.e2e.ts` 分别经真实 Loader 组合与构建后的 CLI 运行该交换。

`apps/web/tests/public-mount.e2e.ts` 是浏览器证据：真实 Chromium 经剥离前缀的代理到达同一监听端口，挂载下的 WebSocket 双向成流，`pushState` 到更深路径后 `document.baseURI` 仍停在挂载点，而文档相对的 `fetch('api/session/create')` 在其下依然成功。
