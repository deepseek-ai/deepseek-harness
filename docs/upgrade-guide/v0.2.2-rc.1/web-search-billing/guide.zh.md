---
kind: upgrade-guide
description: "DeepSeek Search 与 Fetch 新增按能力选择的计费方式，并将提供方认证字段替换为有序凭据来源。"
---

# DeepSeek 网页搜索与获取按计费方式选择凭据

[English](guide.md) | 中文

## 变更

DeepSeek Search 与 Fetch API（`web-deepseek-api`）过去只在 `deepseek-account` 会话中使用已登录账号；其他会话需要 API 密钥。新增的 `searchBilling` 与 `fetchBilling` 设置接受 `auto`（默认）、`account` 或 `api-key`。在 `auto` 下，DeepSeek 模型路由的行为不变；其他会话与会话之外的操作在没有密钥时改用已登录账号。`account` 只使用账号，`api-key` 只使用密钥。非空的 `*BaseURL` 或 `*ApiKeyEnv` 设置仍然优先。其他提供方（包括本地 HTTP 抓取）不受影响。

在 TypeScript 中，`DeepSeekSearchApiOptions` 与 `DeepSeekFetchApiOptions` 移除了顶层 `baseURL`。其 `auth` 改为 `{ sources, missingCredentialMessage? }`。每个账号或 API 密钥来源携带自己的地址；列表顺序替代隐式的账号优先顺序。直接调用提供方构造函数的代码需要迁移。

传入 `AbortSignal` 时，凭据读取错误现在保留原始 `Error` 作为 `cause`，诊断也保留其名称，不再额外包装一层 `Error:`。解析函数抛出名为 `AbortError` 的 DOMException 时，即使该 signal 未取消，现在也返回 `WEB_ABORTED`，而非 `WEB_PROVIDER_ERROR`。未传 signal 的路径原本就采用此行为。

## 迁移

1. 要禁用新增的账号回退，在 `web-deepseek-api` 行把两个能力都设为 `api-key`；也可以在**插件 > 内置插件配置 > 网页搜索与获取**中，选中相应的 DeepSeek API 后选择 **DeepSeek API Key**：

   ```yaml
   - name: '@deepseek-ai/dsh-web-deepseek-api'
     config:
       searchBilling: api-key
       fetchBilling: api-key
   ```

   这也会禁用账号会话中的账号计费，并不能完全恢复原来按路由选择的行为。
2. 迁移直接调用 `DeepSeekSearchApiProvider` 与 `DeepSeekFetchApiProvider` 构造函数的代码。下表描述 TypeScript 选项，而非 YAML 设置：

   | 原选项 | 替换方式 |
   |---|---|
   | `baseURL: base`、`auth.apiKey: key` | `auth.sources: [{ kind: 'api-key', baseURL: base, key }]` |
   | `auth.resolveApiKey`、`auth.apiKeyEnv` | API 密钥来源的 `key: { ref, configured, resolve }`。保留原引用（省略时为 `DEEPSEEK_API_KEY`）；`configured()` 只检查是否存在，不读取值，`resolve()` 读取值。 |
   | `auth.account` | `{ kind: 'account', ...account }`；保留其地址和回调。放在 Key 来源之前可保留账号优先行为。 |
   | `auth.missingKeyMessage` | `auth.missingCredentialMessage` |
   | `auth.invalidRoute` | 在无效来源的位置放置 `{ kind: 'misconfigured', message }`；只有轮到该项才失败。 |

3. 更新错误处理，将解析函数的 `AbortError` 识别为取消。不要依赖额外的错误包装层或其诊断前缀。
4. 确认迁移后的构造代码通过类型检查。选中 DeepSeek API 并使用 `api-key` 计费时，缺少密钥会隐藏相应工具；配置密钥后可以发请求。本地 HTTP 抓取不受影响。
