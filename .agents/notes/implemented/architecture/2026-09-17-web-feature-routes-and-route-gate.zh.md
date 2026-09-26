# Agent Note: 功能路由遵循文档 base，并由门禁维持

Status: implemented

[English](2026-09-17-web-feature-routes-and-route-gate.md) | 中文

## 问题

[Web 应用自有路由相对文档寻址](2026-09-14-web-document-relative-app-routes.zh.md)让外壳、插件 bundle 与流在任一挂载下到达同一监听端口。功能包自有的路由仍寻址源站根：`/open-in-app/...`、deliverables 的 `present.*` 与 `changes.*` 路由、会话日志导出下载、上传 worker 的 `/api/session/uploadFileBinary` 提交，以及本地 markdown 图片路径背后的 `/api/file` 路由。在剥离前缀的代理之后，这些请求全部落空。也没有任何机制阻止新的浏览器侧引用再次把 bundle 绑定到单一挂载。

## 决策

每个功能生产者保留其绝对注册键，并在旁边派生浏览器形式：`OPEN_IN_APP_*_PATH`/`*_ROUTE`、`PRESENT_*_PATH`/`*_ROUTE`、`CHANGED_FILES_PATH` 与 `CHANGES_*_PATH`/`*_ROUTE`、`SESSION_LOG_EXPORT_PATH`/`_ROUTE`、`FILE_UPLOAD_PATH`/`_ROUTE`。浏览器代码只寻址 `*_ROUTE` 形式；页面安装的 Fetch 形载体（`FileUploadFetch`、`RpcFetch`）收到该相对路由，并相对自身基准解析。

两个消费方需要绝对 URL，并相对 `document.baseURI` 解析：上传 worker（其自身基准是 `blob:` URL）与 markdown 图片词汇表（只输出绝对的 `http(s)`、`blob` 或 `data` 目标）。

`verify-client-route-resolution` 在 `hygiene` 与 CI 静态检查中运行，覆盖 client 编译面编译的每个浏览器源文件。它治理请求目标——请求构造器、`fetch` 形调用或动态 import 的第一个参数；赋值的资源属性；JSX 的 `src`/`href` 属性——拒绝根绝对、协议相对或绝对的应用路由（`api`、`plugins`、`open-in-app` 前缀），以及相对 `location` 读取解析的相对应用路由。作为请求目标使用的共享 `*_PATH`/`*_ENDPOINT` 键必须先剥去前导斜杠。同一遍检查还覆盖宿主侧浏览器引用的生产者：以根绝对应用路由写入的 `url`、`src` 或 `href` 字段被拒绝，而路由键与响应表键保持绝对，不在范围内。

## 曾考虑的替代方案

**在浏览器代码中禁止一切 `location` 读取。** 否决：身份比较、preview 自身查询读取、worker tunnel 的宿主相对映射都属正当。门禁治理请求目标——绑定挂载点的路由真正出现的位置。

**在代理中改写功能响应。** 否决：这会为代理并不知晓的每条路由在部署配置里重复挂载点，而文档本就能解析相对引用。

## 后果

门禁只读取内联字面片段，因此组合出来的引用（`comboReference(...)`、`artifact.url.slice(1)`）不被追踪；组合而成的启动图 row、批次描述符与 source-map trailer 的回归信号由 `packages/client/modules/tests/node-half.client.spec.ts` 持有。Preview 页面不会在文档 URL 下暴露其 worker 的文件 API，因此 markdown 本地文件图片 URL 无法到达该 Host。[会话正文本地媒体展示](../feature/2026-09-07-session-prose-local-media-display.zh.md)持有图片词汇表。

## 测试

门禁自身的 spec 为每条规则固定了负向对照：插值目标（`${origin}/api/file`）、协议相对与绝对形式、未剥前导斜杠的共享键、相对路由相对 `location` 读取解析，以及生产者中根绝对的引用字段。各功能包的 spec 断言其浏览器半侧发出的相对路由；`markdown-images.e2e.ts` 端到端维持本地图片路径的覆盖。发现逻辑的 spec 固定了哪些 client 项目贡献浏览器源文件：同时被 Host 聚合编译的 DOM 项目，若没有 `src/client` 半边，则其整个 `src/` 都计入。
