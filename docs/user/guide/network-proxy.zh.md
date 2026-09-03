# 在网络代理后面运行 DSH

[English](network-proxy.md) | 中文

DSH 会把自身的出站请求——模型调用、web 搜索、页面抓取、走 HTTP 的 MCP 服务器——都经由标准代理环境变量所指定的代理发出。它在启动时读取这些变量，不需要其他配置。有几条路径出于设计或运行时限制保持直连，下文"哪些保持直连"一节列出了它们。

## 导出环境变量

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

把这两行写进 shell 配置，这样每次调用 `dsh` 都会继承它们；也可以写进 `$DSH_HOME/.env`（默认 `~/.dsh/.env`），和 API key 放在一起；导出的环境变量始终优先于该文件。项目自己的 `.env` 不能设置它们：它随 `git clone` 一起到来，DSH 宁可拒绝启动，也不让一个仓库决定你的流量去向。

需要凭据的代理把凭据写在 URL 里：`http://user:password@proxy.example:8080`。DSH 绝不会回显这个 URL：诊断只点名被拒绝的变量，因此用户名和密码都不会出现在任何地方。

## 为什么浏览器走代理、终端却不走

这是最常见的意外，而且并非 DSH 特有。**根本不存在一个所有软件都遵循的"系统代理"**——实际上有三套互不相干的机制：

| 机制 | 谁会遵循 |
|---|---|
| 操作系统的代理设置 | Safari、绝大多数 macOS 原生应用、Chrome 与 Edge |
| `HTTP_PROXY` / `HTTPS_PROXY` 环境变量 | `curl`、`git`、`npm`、`pip` 以及 DSH |
| TUN 模式（虚拟网卡） | 所有程序，且对应用透明 |

Clash 这类代理软件里的"系统代理"开关只写第一套。浏览器会读到它，命令行工具则永远看不到。这就是为什么导出环境变量是一个独立步骤，也是为什么打开 TUN 模式后两者都能工作、且完全不需要变量。

DSH 不读取操作系统的代理设置。请导出环境变量，或使用 TUN 模式。

## 指定哪些目标保持直连

`NO_PROXY` 列出需要直连的主机：

```sh
export NO_PROXY=internal.example.com,.corp.example.com,registry.local
```

一个条目写的是主机名，它连同其下所有子域名一起匹配：`NO_PROXY=example.com` 也会让 `api.example.com` 直连。前缀 `.` 或 `*.` 可以写，含义相同。条目可带 `:port`，`*` 则放行全部。

**CIDR 网段不生效。** 操作系统的绕过列表常含 `10.0.0.0/8` 或 `192.168.0.0/16` 这类条目；把它们复制进 `NO_PROXY` 不会有任何效果。请改用主机名或域名后缀。

不需要列出 `localhost` 或 `127.0.0.1`。DSH 始终绕过 loopback，否则它自己的 Web UI 与本地服务器都会经由代理并形成回环。

## 值得知道的限制

**不支持 SOCKS 代理。** `socks5://` 形式的值会在启动时被报告并跳过，指定它的那个 scheme 转为直连——把 `HTTPS_PROXY=socks5://…` 与一个可用的 `HTTP_PROXY` 一起设置时，`https:` 会保持直连，而不会去借用 HTTP 代理。请把变量指向代理软件的 HTTP 端口——多数软件两者都提供，且 HTTP 端口通常就在相邻的端口号上。

**只设 `ALL_PROXY` 也够用。** DSH 会用它为两种协议兜底，尽管 Node 与 curl 在这一点上并不一致。显式设置 `HTTPS_PROXY` 仍然更清楚。

**做 TLS 拦截的企业代理需要它的证书。** 如果代理已经可达但请求仍报证书错误，请在启动前把 Node 指向你所在组织的 CA 包：

```sh
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

Node 只在进程启动时读取该变量，所以要在运行 `dsh` 之前导出。

**DSH 替你运行的工具遵循同一个代理。** bash 工具里的命令、`git`、`gh`，以及作为子进程启动的 MCP 服务器都会继承这些变量。子进程若本身是 Node 程序，则需 Node 22.21 或更高版本才会遵循；更旧的 Node 会直连。如果你的某个代理变量是 DSH 拒绝的值——比如 SOCKS URL——基于 Node 的工具同样直连而不是起不来，`curl` 与 `git` 则仍会读取那个值。

**代理 URL 里的密码同样会到达这些工具。** `HTTPS_PROXY=http://alice:s3cret@proxy.example:8080` 就是一个普通环境变量，因此 DSH 运行的每一条命令——包括模型编写的那些——都能读到它，而打印环境的命令会把密码写进被保留的输出。这与该变量在你 shell 里对其他一切程序的行为一致。若这一点重要，请为代理提供一个无需凭据的入口，或改用 URL 之外的方式认证。

## 哪些保持直连

并非 DSH 发出的每个请求都会走代理：

- **本机上的一切。** loopback 始终直连：`localhost`、整个 `127.0.0.0/8` 段、`::1` 与 `0.0.0.0`。代理无法有意义地访问一个只在本地监听的服务。
- **模型编写的代码。** workflow 与 code-runtime worker 从不接收代理配置，因此模型编写的脚本读不到可能携带密码的代理 URL。这类脚本只有自行配置才能联网。
- **使用情况遥测。** OTLP 导出器用的是 Node 自带的 HTTP 客户端，而不是代理所配置的那个，因此遥测直连；在禁止直连出网的环境里它只会失败。DSH 的任何功能都不依赖它。设 `DSH_TELEMETRY_MODE=DISABLED` 可完全关闭。
- **`web_fetch` 访问字面量私网地址。** 形如 `http://10.0.0.5/` 的 URL 会被拒绝而非交给代理，与未配置代理时得到的拒绝相同。

## 验证是否生效

让 agent 抓取一个页面，同时观察代理软件的连接日志：

```sh
dsh --profile headless "fetch https://example.com and tell me the page title"
```

如果请求没有出现在那里，确认变量确实进入了 DSH 自己的环境：

```sh
env | grep -i proxy
```
