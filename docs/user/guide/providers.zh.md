# 配置模型

[English](providers.md) | 中文

本指南假定你已按照[根 README](../../../README.zh.md#run)启动 Web UI。模型变更会在下一次请求时生效，不需要重启服务器。

## 配置 DeepSeek

打开**设置 → 模型**。DeepSeek 卡片提供一个 API 密钥字段；输入密钥并保存。

![模型页：DeepSeek 卡片，及其下方的添加模型提供商入口](providers-models-page.zh.png)

密钥是只写的。保存后，页面只会收到脱敏描述符，永远不会收到明文密钥。密钥存储在 `$DSH_HOME/.credentials.yaml` 中，settings 只保留它的凭据引用。

## 添加第三方提供商

选择**添加模型提供商**。卡片默认打开在**第三方模型提供商**：选取 dsh 自带的提供商——列表显示的是提供商 id，例如 `anthropic`、`openai`、Kimi 对应的 `moonshotai`、GLM 对应的 `zai`——输入其 API 密钥并保存。已安装目录会提供端点、协议和模型列表。

通过 OAuth 登录的提供商（例如 Codex）暂不支持。

## 添加自定义模型 API

对于中转站、公司网关、自建服务器或已安装目录中不存在的提供商，把卡片切换到**自定义模型 API**。提供小写 Provider ID、基础 URL、API 协议、凭据和至少一个模型。**API 协议**必须选网关实际使用的那一种，选择框提供三种：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages，在当前 profile 的 `cordis.patch.yml` 中分别存为 `openai-completions`、`openai-responses` 和 `anthropic-messages`。一个提供商只使用一种协议，网关同时提供两种时需要建两个提供商。

![自定义模型 API 表单：Provider ID、显示名称、API 地址、API 协议、API 密钥](providers-custom-form.zh.png)

Provider ID 是永久的，因为请求、已保存会话、模型默认值和凭据引用都会使用它。如需重命名提供商，请添加新提供商并删除旧提供商。显示名称、基础 URL、协议、凭据和模型仍可编辑。

### 探测模型

在**模型目录**中选择**获取可用模型**，即可询问端点它提供哪些模型。请求使用表单当前的 API 地址、协议和密钥，已保存的提供商则用已存储的密钥；响应会打开一个可搜索的选择框，搜索、勾选想要的模型，再点**添加所选**。保存或创建提供商之前不会存储任何内容。

探测读取的是常见网关公开的列表格式，但并非每个端点都用这些格式作答，所以它只是便利手段而非保证：探测失败或列表为空时，手动添加模型 ID 即可，效果完全一样。内置提供商一律由已安装目录作答，即使其 API 地址指向网关也是如此，要查看网关实际提供的模型，请通过自定义提供商探测。

## 选择模型

已配置的提供商会出现在模型选择器中。选择模型也会将其设为新会话的默认值。已发送过请求的会话会保留自身日志中记录的模型。

如果已保存默认值指向已删除的提供商，输入框会显示**选择模型**，并在选择其他模型前阻止输入。

## 进阶配置

自动生成的[插件配置目录](../../config-catalog.zh.md)列出每个插件的所有受支持字段与默认值；[`dsh-llm-pi-ai`](../../config-catalog.zh.md#deepseek-aidsh-llm-pi-ai) 就是本页所配置的那个提供商段落。[`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.zh.md) 和 [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.zh.md) 参考文档负责直接 `cordis.patch.yml` 配置、目录解析、推理控制、凭据与适配器错误。

::: tip 其他设置
模型页提供 API 密钥、显示名称、API 地址、API 协议，以及每个模型的 ID、显示名称、上下文窗口、最大输出 token 数和输入类型。推理等级、请求兼容性开关、请求头、超时和重试策略在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中设置，也就是模型页写入的同一份文档。可以直接编辑它；浏览器与服务器在同一台机器时，也可以点击设置页顶部的**打开配置文件**打开它。适配器会在下一次请求时重新读取，无需重启任何东西。下面各小节介绍多数网关会用到的字段。

按常规方式通过 `dsh web` 启动 Web UI 时，`<profile>` 就是 `web`，完整路径为 `$DSH_HOME/profiles/web/cordis.patch.yml`。如果使用自定义 profile，请替换为启动时指定的名称。
:::

### 图片输入

在**设置 → 模型**中编辑提供商，打开**自定义设置**并展开该模型的**模型选项**。**输入类型**独占容量字段下方的一行。对于支持图片的模型，勾选**图片**并保存。没有继承图片能力的新自定义模型默认勾选**文本**。至少保留一种输入类型；仅图片模型需先勾选图片，再取消文本。

复选框将 pi-ai 模型的选择保存为 `input`，将直连 DeepSeek 适配器的选择保存为 `inputModalities`。也可以在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中编辑模型；例如，以下自定义 pi-ai 提供商声明了一个纯文本模型和一个视觉模型：

这些示例展示 profile patch 中的配置字段。Cordis 配置覆盖会替换完整条目配置；编辑已有覆盖项时，请保留其他 provider 和字段。

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        models:
          - id: legacy-chat
          - id: vision-preview
            input: [text, image]
```

Pi-ai 的 `input` 接受 `text` 和 `image`，且只作用于该模型。显式的非空选择优先。省略或为空的 `input` 先继承已安装目录的输入类型，再回退到路由的 `defaultInput`，后者默认为 `[text]`。复选框会显示这些继承值，仅打开模型行不会保存覆盖值。

DeepSeek 将省略的 `inputModalities` 视为纯文本，并拒绝空列表。取消图片还会移除该模型的 `imagePixelBudget` 和 `imageMaxBytes`，因为 DeepSeek 拒绝纯文本模型上的图片限制。以后重新启用图片且需要自定义限制时，需再次设置这些限制。

修改复选框后如需恢复继承，可在 `cordis.patch.yml` 中移除模型的 `input` 或 `inputModalities` 字段。**恢复默认模型**会移除整个模型目录覆盖，包括其他模型编辑，因此仅在需要恢复整个目录时使用。

如果你手动录入的模型全都接受图片，可以在路由上设置一次回退值，不必逐个模型写：

```yaml
- id: llm-pi-ai
  config:
    providers:
      vision-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://vision.example/v1
        defaultInput: [text, image]
        models:
          - id: first-model
          - id: second-model
```

`defaultInput` 是回退值而不是覆盖值，默认为 `[text]`：在内置提供商上，它只为其目录未描述的模型作答，因此绝不会把目录中本就具备图片能力的模型的该能力去掉。要收窄这类模型，请用它自己的 `input`。内置提供商没有显式 `models` 列表时，写在 `modelOverrides` 下，以模型 id 为键：

```yaml
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        modelOverrides:
          claude-sonnet-4-5:
            input: [text]
```

在 pi-ai 配置中，除模型自身的 `input` 外，每个列表都至少要写一项模态；模型自身的空列表与省略它同义。未知模态在任何位置写入都会被拒绝。

这两个字段都是对你端点的断言，而不是对它的检查。声明了端点并不提供的图片能力的模型不会在这里被拦下，改由提供商拒绝该请求。

### 推理等级

对于声明了推理等级的模型，模型选择器会提供**推理等级**菜单。内置提供商的模型从已安装目录继承其等级。手动录入的模型不声明任何等级，因此模型菜单里不会出现推理等级项，由端点自身的默认值决定模型是否思考。请在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中用 `reasoningEfforts` 声明等级：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        reasoning: high
        models:
          - id: my-reasoner
            reasoningEfforts:
              off:
              high: high
              max: max
```

每个键都是菜单提供的一个等级，其值是在协议上以 `reasoning_effort` 发送的写法，因此 `max: xhigh` 可以为自有一套词汇的网关重命名某个等级。只有 `off` 可以留空，因为对多数端点来说，不思考就是不传该参数。路由的 `reasoning` 是会话尚未选择等级时采用的等级；在选择器中选定某个等级后，它会与模型一起保存为新会话的默认值。

留空的 `off` 什么都不发送，这只能让「按请求才思考」的模型停下来；给 `off` 一个值，则会把该值作为 `reasoning_effort` 发送。对于「不明确关闭就会思考」的模型——例如 OpenAI 兼容网关后面的 DeepSeek V4——需要 `compat.thinkingFormat: deepseek`：它让 `off` 发送 `thinking: {type: disabled}`，其他每个等级则在 effort 之外再发送 `thinking: {type: enabled}`：

```yaml
        models:
          - id: deepseek-v4-pro
            compat:
              thinkingFormat: deepseek
            reasoningEfforts:
              off:
              high: high
              max: max
```

网关并不提供推理能力的内置提供商模型，可在 `modelOverrides` 下用 `reasoningEfforts: false` 去掉其等级；之后再为它选择等级会被拒绝并报 `UNSUPPORTED_REASONING_EFFORT`。DeepSeek 自身的路由不需要以上任何配置：其模型已经提供 `off`、`low`、`high` 和 `max`，`llm-deepseek.reasoningEffort` 设置选择器的起始默认值：

```yaml
- id: llm-deepseek
  config:
    reasoningEffort: max
```

### 请求兼容性

网关可能持有可用的密钥、地址也通得到，却仍然拒绝每一个请求。pi-ai 依据端点的 URL 决定请求的形状——系统提示词由哪个角色承载、输出上限写在哪个字段、思考级别如何传输——而对于它无法识别的地址，会当作 OpenAI 本身来对待。多数 OpenAI 兼容网关至少会拒绝 OpenAI 所接受的某一样东西。

其中两样占了绝大多数。声明了推理能力的模型，其系统提示词会以 `role: "developer"` 发出，很多网关直接拒绝；输出上限则写作 `max_completion_tokens`，只认 `max_tokens` 的服务端会拒绝。表单里没有这两个字段；请在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的路由上更正：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: my-model
```

路由的 `compat` 是其模型的默认值，模型自身的则逐字段胜出，因此更正某一个模型无需重述整条路由：

```yaml
        models:
          - id: my-model
          - id: my-reasoner
            compat:
              thinkingFormat: deepseek
```

两者都未设置的字段，沿用已安装 catalog 为该模型记录的值；catalog 也未描述的，落到 pi-ai 的检测。凡是写下的开关都要给值：冒号后留空的键（`supportsDeveloperRole:`）会被拒绝而不是被忽略，因为空值会抹掉 catalog 已知的信息，却又没有给出任何替代。任何协议都不接受的名字同样会被拒绝，报错会列出可用的那些。

每个开关归属于声明了它的那些协议，因此在某个 `api` 上合法的开关，在另一个上可能被拒绝——报错会点名该协议实际提供哪些。与上面的 `input` 一样，开关陈述的是关于你的端点的一个断言，而不是对它的检查：设置一个网关其实并不需要的开关，只是发出一个不同的请求而已。

全部开关、各自接受的取值，以及接受它们的协议，都列在[生成的 `dsh-llm-pi-ai` 配置参考](../../config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)的 `PiAiCompatProfile` 之下——该参考派生自源码，因此不会落后于适配器实际接受的内容。

## 排错

- **`MISSING_CREDENTIAL`**：通过模型页存储提供商密钥，或提供被引用的环境变量。
- **`UNKNOWN_MODEL`**：选择已配置的模型，或向自定义提供商添加缺失的模型。
- **获取可用模型返回 401**：检查密钥。模型发现会调用 OpenAI 兼容的 `GET /models` 端点；对于不提供该端点的服务，请手动输入模型。
- **获取可用模型提示既没有 `data` 数组也没有 `models` 对象**：端点返回的列表格式不在探测的读取范围内。请手动输入模型。
- **密钥与地址都正确，网关却拒绝每一个请求**：它的请求形状与 OpenAI 不同。先在路由上设 `compat.supportsDeveloperRole: false` 与 `compat.maxTokensField: max_tokens`。
- **只有推理模型失败**：pi-ai 把它们的系统提示词以 `developer` 角色发出，而网关拒绝该角色。设 `compat.supportsDeveloperRole: false`。
- **手动录入的模型没有推理等级菜单**：该模型没有声明任何等级。在 `cordis.patch.yml` 中给该模型加上 `reasoningEfforts`。
- **`off` 无法让 DeepSeek 模型停止思考**：留空的 `off` 不发送任何推理字段，默认思考的端点就继续思考。请在模型或路由上设置 `compat.thinkingFormat: deepseek`。
- **某个 compat 开关因没有值而被拒绝**：冒号后什么都没写。给它一个值，或删掉该键以沿用已安装 catalog 的值。
- **图片在发送前被拒绝**：该模型未声明图片模态。请给自定义提供商的模型加上 `input: [text, image]`；在 DeepSeek 自身的路由上，请从配置的目录中选择支持图片的条目（默认为 `deepseek-flash`），并确认网关提供该模型且支持图片输入。
- **提供商拒绝了带图片的请求**：该模型声明了其端点实际并不提供的图片能力。请从授予它图片能力的那个列表中移除 `image`——可能是模型的 `input`，也可能是路由的 `defaultInput`——然后开启新会话：附加的图片会留在会话日志里，因此在会话离开它之前，同一个请求会不断重复。
