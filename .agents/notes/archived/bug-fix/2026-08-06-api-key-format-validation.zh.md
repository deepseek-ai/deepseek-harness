# Agent Note: 在 API Key 进入 HTTP header 之前校验其格式

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-api-key-format-validation.md) | 中文

## 问题

一个含有 HTTP header value 无法承载的字符的 API Key，曾被每个配置入口接受，直到构造请求时才失败——离引发它的那个字段已经很远。

把含 emoji、中日韩文字或全角标点的 Key 粘进 Web 模型设置页，保存会报成功。首个轮次随即失败，报错为 `Cannot convert argument to a ByteString because the character at index 7 has a value of 55357 which is greater than 255`——其中的下标与码点是 UTF-16 内部细节，不附带任何可执行动作，却泄露了 Key 中某一个字符的码点。`llm-deepseek` 之所以产出这句，是因为 `fetch` 在 [adapter.ts](../../../../packages/llm/llm-deepseek/src/adapter.ts) 的 `try` 内部构造 `Bearer` header，而那个 `catch` 把一切失败都标为 `TRANSPORT`；该标签又在 `DEFAULT_RETRYABLE_CODES` 之中，于是一个永久且确定的故障还会被重试三次。

同样的输入在 `llm-pi-ai` 上更糟。它的探测路径在 [discovery.ts](../../../../packages/llm/llm-pi-ai/src/discovery.ts) 里用裸 `fetch` 构造同一个 header，并把一切失败包装成 `could not reach <url>`，于是一个本地的 Key 故障被报成网络不可达。这条探测在保存之前就够得着：`ProviderEditor` 把用户输入的 `keyDraft` 直接放进探测请求，所以「获取模型列表」按钮会在任何东西落盘之前就把非法 Key 发出去。

空白字符能通过每一道检查。`ProviderEditor` 判的是 `keyDraft.length`，于是三个空格构成的 Key 会被存下，随后以 `Bearer` 加若干空格去认证。两个适配器都不检查来自凭据或环境的 Key——而那正是 Models 页写入的路径，也就是用户真正走的路径。

## 决策

一条规则定义什么是合法 Key：**trim 之后非空，且每个字符都落在 `[\x21-\x7E]`**——可打印 ASCII，不含空格。

这一个断言覆盖了所有已报告的输入：空值、首尾空白、中间空白、C0 控制字符、emoji、中日韩文字、全角标点。它同时正是造成 ByteString 失败的那条约束，所以这些故障收敛于同一个定义，而不是两个恰好相关的修复。

第二条更窄的规则用于识别整行粘贴的环境变量：匹配 `^[A-Z][A-Z0-9_]*=[^=]` 或首尾成对引号的输入会被拒绝。把前缀限定为全大写可以让真实 Key 与之绝缘——`sk-` 这类形态会在连字符处中断标识符匹配——而要求分隔符之后必须是非 `=` 字符，则让 base64 的 padding 也与之绝缘。它报出的是与非法字符相同的那条格式失败，而不是自己的一句：读到它的人下一步动作完全一样，因此单列一句只会点出一个原因，却不改变该怎么做。

### 不变量属于每一层，启发式属于人所在的那一层

字符集规则是不变量。非 ASCII 字符对任何提供方都**不可能**在 header value 中传输，因此在浏览器、在各个 resolver、在每一次凭据读取上执行它，是结构上的一致而非约定上的一致。

形状规则是对人如何粘贴的猜测，因此**只在浏览器中运行**。`llm-pi-ai` 前面挂着 OpenAI、Anthropic 以及任意手工声明的网关，本仓库并不掌握它们的 Key 格式；若这条规则运行在 resolver 中，一个签发形如 `TENANT1=abc` 的网关会让用户被彻底锁死、无路可走——设置页拒绝它，手写的 `.env` 在读取时同样被拒。把启发式限制在粘贴动作发生的那一层，环境变量便始终是那条出路。

### 「没有 Key」是一种配置状态，不是缺失

规则作用于*已提供*的值；至于究竟有没有提供，由各个调用方自行判断。

**未点名凭据。** 省略 `apiKeyEnv` 的 pi-ai profile 可以在 harness 持有的凭据路径之外鉴权。[provider.ts](../../../../packages/llm/llm-pi-ai/src/provider.ts) 中的 `routeAuth` 保留内置 catalog 提供方自身的鉴权，正是为了让提供方原生的 ambient 发现继续工作；而该 catalog 附带的 `openai-codex` 通过 OAuth 鉴权。`namesCredential` 承载这一区分；省略不是需要校验的值。

**Web UI 中留空的输入框。** 即便某个提供方的 Key 已经存好，该输入框也是空着打开的——`keyStored` 的文案写的是「已配置——输入新值以替换」——所以留空意味着*保持已存储的值*。`ProviderEditor` 在草稿为空时完全跳过 `credentials.set`，这一点保持不变：留空绝不拦截提交，否则改一个 base URL 都得重新输一遍 Key。

**解析得到的值只含空白。** 两个适配器都将其视为非法，因为它无法为请求鉴权。在浏览器中，这同样是字段级失败：字段是人刚刚敲过字的地方，静默丢弃他敲进去的内容永远不是正确答案。

因此 `normalizeApiKey` 接受 `string`，而绝非 `string | undefined`。

### 规则住在哪里

`normalizeApiKey` 是 `dsh-llm` Service Definition 的一个模块，与已经承担共享 header 事务的 [attribution.ts](../../../../packages/llm/llm/src/attribution.ts) 并列。两个适配器都依赖该 seam 且都需要这条规则，因此它拥有两个当前消费方而非一个预设消费方。它返回 trim 后的值，或一个原因（`empty`、`illegalCharacters`）。

两个适配器同样都需要那句完全相同的「拒绝一个已存储凭据」的诊断，差别仅在包名前缀。`LlmError` 声明在 Service Definition 的 `index.ts` 中，因此 `assertUsableApiKey(raw, pkg, ref)` 就住在它旁边，两个适配器都不再各留一份。断言模块本身保持零依赖：把 `LlmError` 引入 `api-key.ts` 会与 `index.ts` 对它的再导出成环。

客户端无法引入其中任何一个：client 包只 reference client 包，因此 `packages/client/ui-settings-models` 在自己的 `apiKey.ts` 中镜像这个断言并持有本地化文案，正如 `validateDeepSeekModels` 镜像 host 侧的 `catalogModel` schema。两侧在注释中互相指名。

### 各处分别做什么

| 位置 | 行为 |
|---|---|
| `dsh-llm` | 拥有 `normalizeApiKey`、`assertUsableApiKey` 与 `INVALID_CREDENTIAL_CODE`，后者刻意不进 `DEFAULT_RETRYABLE_CODES`。 |
| `llm-deepseek` `resolveApiKey` | 归一化凭据 seam 或环境返回的值，以 `INVALID_CREDENTIAL` 拒绝，消息指明模型设置页，绝不回显 Key。 |
| `llm-pi-ai` `resolveApiKey` | 归一化凭据与环境路径。不指定任何凭据的 profile 仍返回 `undefined`，ambient 与 OAuth 路由不受影响。 |
| `llm-pi-ai` `discoverModels` | 在构造 header 之前归一化，使非法 Key 成为凭据故障而非端点不可达。不带 Key 的探测保持未鉴权。 |
| `ui-settings-models` | 镜像字符集规则，加入形状启发式，在探测与 `credentials.set` 之前 trim `keyDraft`，并修正 `stringAt` 的空值判断。留空的输入框仍是可以提交的空操作；只含空白的输入框则是字段级失败。提交**与端点探测**同时受拦截，因此被拒绝的密钥不会白花一次往返去换取字段上已经写明的答案；失败呈现在字段上，与既有的 `modelFailure` 模式一致。 |

`ProviderEditor` 同时服务 DeepSeek 与 pi-ai 两种布局，因此一处客户端改动覆盖两个提供方。`CustomProviderCard` 为手工声明的路由承载同一套判定。

`credentials-local` 刻意不动。它存储各类凭据，而可打印 ASCII 是 HTTP header 的约束而非凭据存储的约束；它既有的、拒绝任何 dotenv 样式都无法表示的值的行为保持原样。

## 曾考虑的替代方案

**由 client 与 host 共享一个校验模块。** 被 source plane 布局否决：client 包只 reference client 包外加 `vendor/cordis` 与 `runtime-diagnostics/invariants`，把它放宽到够得着 host 包会撞上这一分割本就要隔开的两份 `Context` 合并。在两侧各镜像一行断言并各配一份测试，是此处的既定形态。

**在 `llm-deepseek` 与 `llm-pi-ai` 中各留一个抛错 helper。** 最初的计划正是各留一份，差别仅在消息中的包名前缀，并配一个重复检测豁免来放行这一对。在实现之前即被否决：`LlmError` 声明在 Service Definition 中，因此该包完全可以自己拥有这句诊断，而那里的一个豁免恰恰会掩盖它本要遮掩的重复。

**在适配器的 `catch` 中嗅探 `TypeError`。** 这只是事后归类 ByteString 失败，header 构造本身仍无防护。它依赖 Node 错误消息的措辞，因而会随运行时版本静默失效；它也帮不到 `llm-pi-ai`——后者的请求 header 构造在 pi-ai SDK 内部。在交出 Key 之前就拒绝，则对两个适配器与探测路径同时有效。

**在 `credentials-local.set` 中执行。** 它能一次性拦住所有写入方，包括手工编辑的文件。它落败于该提供方存储各种类型的凭据，而一条源自 HTTP header 编码的规则并不属于它。

**让形状启发式也在 resolver 中运行。** 更对称，且能拦住直接写进 `.env` 的整行环境变量。因上文所述的锁死风险而否决：resolver 中的一次误判会让用户无路可走，浏览器中的一次误判则仍留有环境变量这条路。

**在保存时探测提供方以证明 Key 可用。** 它能关掉最初报告的那件事——保存报成功、首个轮次才失败。因超出范围而否决，且在当时的代码上无法建成：对 pi-ai 恰好自带 catalog 的那些提供方，`discoverModels` 会在任何网络调用之前短路到内置 catalog，因而对 Key 什么都验证不了；而 DeepSeek 卡片根本没有探测。验证器的价值在于分清「Key 被拒」与「无法连通」，而这正是本次改动让其变得可靠的区分；先建验证器只会得到一个分不清自身结果的验证器。同类产品也不在保存时验证，因此保存时的阻断式网络调用会是一个意外行为，而非一处缺失。

## 后果

格式错误的 Key 在持有它的那个字段上就被拒绝；格式错误的已存储 Key 以 `INVALID_CREDENTIAL` 失败，消息指明修复位置且不含 Key 的任何片段。由于该 code 位于 `DEFAULT_RETRYABLE_CODES` 之外，一个确定性的凭据故障不再被当作瞬时传输抖动重试三次。`llm-pi-ai` 的探测把非法 Key 报为凭据故障，而非端点不可达。

形状启发式可能拒绝一个真实的 Key。匹配任意「全大写标识符接 `=`」会比预期覆盖面更宽：一个以 padding 结尾的全大写 base64 Key（`ABCD==`）会命中它并不像的赋值形态。要求分隔符之后必须是非 `=` 字符即可排除 padding——base64 的 padding 只出现在末尾。剩下的形态（大写名称、一个 `=`、然后是值）是已知提供方不会签发的，且该规则只在浏览器中运行，因此仍撞上它的用户可通过环境变量设置该凭据。残留代价是对一个尚无人报告过的 Key 给出一次令人困惑的拒绝。

限定为可打印 ASCII 比传输本身的要求更严：header value 是可以承载 `\x80`–`\xFF` 的。放行 latin-1 会让 `é` 通过并换回一个语焉不详的 401，而不是一次本地的、有解释的拒绝，因此从严是刻意的。若某个提供方签发 latin-1 的 Key，这条规则需要放宽。

字符集断言存在两份，每个 source plane 一份。布局禁止共享它；两侧各自带测试并在注释中指名其孪生体。

早先版本已存下的 Key 会经 `resolveApiKey` 读取，因此一个非法的既存值将从解析时开始失败，而非到请求时才失败。诊断变好了，但对当前正持有这类值的人而言，失败点提前了。

把这件事做错的最大代价，会是把「未指定」当成「非法」：一条施加到 `undefined` 上的规则会打断每一条依赖 ambient 发现或 OAuth 鉴权的路由，而一个会拦截提交的空输入框，则会让改动任何其他设置都必须重新输入 Key。这两点都由测试钉住，而不是仅仰赖谨慎。

## 测试

`packages/llm/llm/tests/api-key.spec.ts` 以整张输入表驱动 `normalizeApiKey` 与 `assertUsableApiKey`——空值、纯空白、带首尾空白、含中间空格、C0 控制字符、emoji、中日韩文字、全角、latin-1，以及可打印 ASCII 的边界字符——并钉住一次拒绝携带 `INVALID_CREDENTIAL` 且不含 Key 的任何部分。

`packages/llm/llm-deepseek/tests/` 在 `dynamic-config.spec.ts` 中经真实凭据 seam（而非 stub）端到端覆盖已存储凭据路径。`packages/llm/llm-pi-ai/tests/` 覆盖探测路径，包括不带 Key 的探测不会发出 `authorization` 标头。

`packages/client/ui-settings-models/tests/` 以同一张表加上形状用例钉住 `apiKeyFailure`，并驱动两张卡片：留空的输入框可提交且不写入凭据、只含空白的输入框在字段上失败、非法或被包裹的 Key 同时拦截提交与探测、带首尾空白的 Key 在 `credentials.set` 与探测之前被 trim，以及手工声明的路由可以完全不带 Key 创建。

用户可见的终态则钉在它真正被组装的位置：`apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` 让 one-shot 应用在一个 HTTP 标头无法承载的已存密钥下运行，复用其 missing-credential 兄弟场景的同一套无密钥 composition，并记录该轮次以 `INVALID_CREDENTIAL` 结束、消息可操作且既不含密钥也不含 `ByteString` 字样。包级测试无法证明这一点，而 web e2e 只覆盖了浏览器那一半。
