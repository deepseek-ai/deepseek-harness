# Terminology

本表约定本仓库的中英术语统一译法。

**通用规则：**
- "中文"列为中文译文的正文默认用词。若该列为英文，则中文译文的正文中保留英文不翻译。
- 首次出现按"首次出现"列书写（带括号注释）；后续出现只写括号前的部分（可能为中文，也可能为英文），不出现括号内的注释。
- "不要译作"列为严格禁止的译法。
- 如果某术语已经作为另一个术语的组成部分被括注过（如 `agent loop（智能体循环）` 中已包含 `agent` 的括注），则该术语后续单独出现时无需再次括注。

## 缩写类（中英文文本中均使用缩写）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| ACP | ACP | ACP（Agent Client Protocol） | | |
| AI | AI | AI（人工智能） | | |
| API | API | | | |
| CI | CI | | | |
| CLI | CLI | CLI（命令行界面） | | |
| e2e | e2e | | | |
| HMR | HMR | HMR（热模块替换） | | |
| JSON Schema | JSON Schema | | | |
| JSONL | JSONL | | | |
| LLM | LLM | LLM（大语言模型） | | |
| MCP | MCP | | | |
| PR | PR | PR（Pull Request） | | |
| RAG | RAG | RAG（检索增强生成） | | |
| SDK | SDK | | | 只指受支持的 Python 与 TypeScript SDK 所使用的 JSON-RPC 客户端／服务器协议；DeepSeek Harness 项目本身不是 SDK |
| SSE | SSE | SSE（Server-Sent Events） | | |

## 英文类（中英文文本中均使用英文）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| agent | agent | agent（智能体） | | |
| Agent Note | Agent Note | | 智能体注记、智能体笔记 | 仓库定义的文档类型，涵盖提案、已实现决策和被否决提案；中文对侧 H1 保持固定前缀 `# Agent Note: `，标题中不加术语括注 |
| agent harness | agent harness | agent harness（智能体框架） | | agent 组合词（agent harness/workflow/loop/skill 等）整体保留英文；未括注过 agent 时首现按对应组合词或 agent 行处理 |
| agent loop | agent loop | agent loop（智能体循环） | | |
| blob hash | blob hash | | | `git hash-object` 的结果 |
| coding agent | coding agent | coding agent（编程智能体） | | agent 组合词，正文保留英文 |
| Cordis | Cordis | | | |
| dispose | dispose | dispose（资源释放） | | |
| doc-sync | doc-sync | doc-sync（文档同步门禁） | | |
| fiber | fiber | | | |
| fixture | fixture | fixture（测试前置数据） | | |
| fork | fork | | | |
| Function Calling | Function Calling | Function Calling（函数调用） | | |
| harness | harness | | | |
| harness engineering | harness engineering | | | |
| KV Cache | KV Cache | | | 专有技术名称，保持大小写与空格 |
| lint | lint | | | |
| mock | mock | | | 保留英文；指测试替身 |
| loader | loader | | | |
| manifest | manifest | manifest（元数据清单） | | |
| monorepo | monorepo | | | |
| Round | Round | | 回合、目标回合、Ralph 回合 | 外层策略使用 Round 时，领域层级为 Session > Round > Turn（轮次） > Step（步骤）；Round 是可选的外层策略迭代，并非每个会话轮次都具有的通用层级。Goal Round 与 Ralph Round 均保留英文。一个 Round 承载一个轮次，步骤隶属于该轮次；明确的零步骤轮次仍保持原义。 |
| schema | schema | | | |
| schema DSL | schema DSL | | | |
| seam | seam | | 接缝 | 一个可替换能力的整体，包含 Service Definition / Service Provider / Consumer 三种角色；角色需要独立演化时才拆包，也可由同一包承担多个角色。以 `packages/shell` 为范例；Service Definition 是 Cordis `Service`（抽象类或具体 registry 服务），不是 TypeScript interface。任何单一角色、普通边界或扩展点都不能称为 seam。本仓库正文保留英文；与 `extension point` 是不同概念 |
| Service Provider | Service Provider | | Service provider | 能力 seam 的命名角色；单数固定写作 Service Provider，复数写作 Service Providers。泛指提供服务的 provider 不适用本词条 |
| skill | skill | skill（技能） | | |
| slot | slot | | 坑位、孔位 | 客户端架构中的具名可注册位置，保留英文 |
| spill | spill | | | 工具输出超限落盘机制；组合词写 `spill 文件`、`spill 路径` |
| spawn | spawn | | | |
| steering | steering | steering（中途引导） | | |
| job id | job id | | 任务 id | 保留英文 |
| subagent | subagent | | | 文档正文保留英文；中文 UI 中译作「子智能体」，不使用「子代理」 |
| transcript | transcript | transcript（文本记录） | | 指会话渲染给用户或编辑器的完整文本，区别于事件日志 |
| Typert | Typert | | TypeRT、typeRT、Type RT | DeepSeek Harness 类型图、生成器、loader 与运行时 registry 的产品拼写 |
| waterfall | waterfall | waterfall（瀑布式事件） | | |
| wheel | wheel 包 | | | Python 打包格式 |
| worktree | worktree | | | git 工作区概念 |
| Zstandard | Zstandard | | | RFC 8878 compression format; `zstd` remains a code value. |

## 双语类（中英文文本各自使用中英文）

| English | 中文 | 首次出现 | 不要译作 | 备注 |
|---|---|---|---|---|
| adapter | 适配器 | | | |
| adapter contract | 适配器约定 | 适配器约定（adapter contract） | | |
| append-only | 仅追加 | | | |
| artifact | 产物 | | 制品 | |
| backend | 后端 | | | |
| binder | 绑定器 | | | 命名角色：把已声明接口绑定到调用方 context 或生命周期 |
| config | 配置 | | | 命名角色：一个已解析配置值或边界严格的配置记录 |
| controller | 控制器 | | | 命名角色：接受意图并改变一项既有领域或展示状态 |
| directory | 目录 | | | 命名角色：暴露供发现或选择的条目及元数据 |
| engine | 引擎 | | | 命名角色：实现领域算法或有状态执行模型 |
| gateway | 网关 | | | 命名角色：适配进程、网络、RPC 或 API 边界 |
| handle | 句柄 | | | 命名角色：引用并控制或观察一个实时资源 |
| policy | 策略 | | | 命名角色：决定允许、选择、限制或观察什么 |
| presenter | 展示转换器 | | | 命名角色：把领域值纯转换为渲染意图 |
| resolver | 解析器 | | | 命名角色：根据输入计算或定位一个答案 |
| store | 存储 | | | 命名角色：拥有一组数据并主要提供数据操作 |
| background job | 后台任务 | | | |
| block | 块 | | | |
| build target | 构建目标 | | | |
| cancel | 取消 | | | |
| canary test | canary 测试 | | 金丝雀测试 | 本仓库保留 `canary` |
| capability | 能力 | | | 必须与 `feature` → `功能` 区分 |
| capability seam | 能力 seam | | 功能 seam、能力接缝 | 本仓库 Service Definition、Service Provider 与 Consumer 三种角色组成完整可替换能力的命名架构概念；普通 `seam` 仍按其词条处理 |
| feature | 功能 | | 能力 | SDK 产品与工程模型中的可管理产品单元 |
| feature option | 功能选项 | | variant | 一项 SDK 功能内有限、可选择的实现或配置 |
| checkpoint | 检查点 | | | |
| chunk | 分片 | | | |
| compaction | 压缩 | 压缩（compaction） | | |
| companion tool | 配套工具 | | | |
| composition bundle | 组合包 | | | 只约束应用或插件的组合语境，不约束所有 `bundle` |
| Cordis plugin config | Cordis 插件配置 | | | Cordis 插件公开的 `Config` 对象或配置结构 |
| config key | 配置键 | | | Cordis 插件配置中的单个字段 |
| consumer | 消费方 | | 消费者 | |
| content block | 内容块 | | | |
| Cookbook | 实操手册 | | | 文档标题用语 |
| context | 上下文 | | | |
| counterpart | 对侧文件 | | 对应物、配对物 | 双语配对语境；泛指"另一侧"时可写「另一侧」 |
| configurable-provider directory | 可配置提供方目录 | | | llm seam 中 `registerConfigurableProviders()` 维护的目录；沿用 Service Catalog →「服务目录」先例 |
| context compaction | 上下文压缩 | 上下文压缩（context compaction） | | |
| contract | 约定 | | | 如：`pairing contract` →`配对约定` |
| Cordis config entry | Cordis 配置项 | | | 指 `cordis.yml` 插件列表中的一项；插件实现本身写`Cordis 插件` |
| Cordis plugin | Cordis 插件 | | | Cordis 加载的插件实现，不指 `cordis.yml` 中的一项配置 |
| crash recovery | 崩溃恢复 | | | |
| deploy root | 部署根目录 | | | |
| dormant | 休眠 | | 睡眠、蛰伏 | 指已声明可配置但当前未注册路由的提供方 |
| durability | 持久性 | | | |
| feature requirement | 功能依赖 | | | 功能或功能选项通过 `requires` 声明的关系 |
| event | 事件 | | | |
| event log | 事件日志 | | | |
| event stream | 事件流 | | | |
| event-sourced | 事件溯源 | | | 沿用 DDD 社区通行译法 |
| Executive summary | 摘要 | | | 事故复盘标题用语 |
| executor | 执行器 | | | |
| expected output | 预期输出 | | 金标 | 指 snapshot 比较产物；翻译语料的人工校准样例不在此列 |
| extension | 扩展 | | | |
| extension point | 扩展点 | | | 注意与 `seam` 区分 |
| fail-fast | 快速失败 | | | |
| fenced code block | 围栏代码块 | | | 沿用 MDN 中文翻译 |
| fingerprint | 指纹 | | | 通用内容指纹；双语配对机制使用 sidecar record 按分节记录两侧 hash |
| finish reason | 结束原因 | | | |
| fold | 折叠区 | | | 配置界面语境：默认收起的字段分区（collapsed →「收起」）|
| foreground run | 前台运行 | | | |
| freshness | 新鲜度 | | | 沿用 MDN 中文翻译；在本项目中指译文相对源文的同步状态 |
| hook | 钩子 | | | |
| implementation | 实现 | | | |
| inference | 推理 | 推理（inference） | | 需要和 `reasoning` 区分时保留英文括注 |
| info string | 信息字符串 | | | 沿用 CommonMark 中文翻译；指代码围栏 ``` 之后的语言标注 |
| injection | 注入 | | | |
| integration | 集成 | | | |
| interface | 接口 | | | |
| language switcher | 语言切换行 | | | i18n 配对机制用语：双语配对文件顶部的互链行 |
| merge | 合并 | | | |
| message | 消息 | | | |
| mod | 模组 | | | |
| model provider | 模型提供商 | | | 指为模型提供 API 的厂商或网关：模型设置页文案、用户指南 providers 与 `ui-settings-models` README 用「提供商」；llm seam 的开发者文档（可配置提供方目录、dormant 等）沿用「提供方」 |
| model selection | 模型选择 | | 模型目标 | 面向 Agent 的提供方、模型和可选推理强度选择。 |
| module | 模块 | | | |
| non-escalation | 非升权 | | 非升级、不可升级 | 仅用于安全与权限语境，指主体不得获得超出既有授权的权限；普通升级不适用此行 |
| npm dependency | NPM 依赖 | | | `package.json` 中的包关系；`dependencies`、`devDependencies` 等字段保持原样 |
| opt-out ratio | opt-out 比例 | | 退出检查比例 | |
| orphan | 遗留 | | 孤儿、孤立 | 指英文源已不存在的 `.zh.md`（如「遗留译文」）；进程语境按 OS 惯用语译「孤儿进程」 |
| orphan branch | 孤立分支 | | 孤儿分支 | 沿用 git 官方中文翻译 |
| package | 包 | | | 指 npm 包（`@deepseek-ai/dsh-*`）；`package.json` 等代码标识保持原样 |
| pairing | 配对 | | | |
| parent-subset grants | 父级子集授权 | | 父集合授权 | 指授权范围仅限于父级所持授权的子集 |
| peer dependency | 对等依赖 | 对等依赖（peer dependency） | | |
| permission | 权限 | | | |
| persistence | 持久化 | | | |
| pipeline | 流水线 | | | |
| plugin | 插件 | | | |
| postmortem | 事故复盘 | 事故复盘（postmortem） | 事后分析、事故记录 | 事故记录与分析文档；目录或路径中的 `postmortem` 保持代码形式 |
| prompt | 提示词 | | | |
| provider | 提供方 | | | 泛指的提供方（搜索、检查、settings 文件、subagent 等）；模型厂商或网关见 model provider 行 |
| provider-neutral | 提供方无关 | | 提供方中立 | |
| quality gate | 质量门禁 | | | |
| quiescence | 完全停稳 | | 静默、静止状态 | 指生命周期工作全部结算后的状态 |
| reasoning | 推理 | 推理（reasoning） | | 需要和 `inference` 区分时保留英文括注 |
| reasoning_content | 思考内容 | | | |
| registry | 注册表 | | | |
| replay | 回放 | | | |
| resume | 恢复 | | | |
| runtime | 运行时 | | | |
| same-world subprocess | 与宿主共享文件系统和内核的子进程 | | 同世界子进程 | |
| sandbox | 沙箱 | | | |
| service | 服务 | | | |
| serving interface | 对外服务接口 | | | |
| session | 会话 | | | |
| session event | 会话事件 | | | |
| setup card | 设置卡片 | | | 首次运行时代替行卡直接展开的配置卡 |
| sidecar file | 伴随文件 | | | 指与文档同目录的普通伴随文件 |
| sidecar record | 伴随记录 | | 旁挂记录 | 指与文档同目录的伴随记录文件 |
| smoke test | 冒烟测试 | | | |
| snapshot | 快照 | | | |
| source of truth | 真源 | | 事实来源、唯一来源 | |
| spine | 主干 | | | |
| stale | 陈旧 | | 过期 | 与 `fresh`（`新鲜`）成对；门禁输出中保留英文 `stale` 不翻译；`expired` 才译为`过期` |
| step | 步骤 | | | |
| stream | 流 | | | |
| structural signature | 结构签名 | | | i18n 配对机制用语：门禁比对两侧文件时提取的有序结构序列（标题层级、代码块、列表等） |
| Summary | 概述 | | | 事故复盘标题用语 |
| system prompt | 系统提示词 | | | |
| taxonomy | 分类体系 | | | |
| token usage | token 用量 | | | |
| tool | 工具 | | | |
| tool call | 工具调用 | | | |
| tool result | 工具结果 | | | |
| tool schema | 工具 schema | | | |
| toolkit | 工具包 | | | |
| turn | 轮次 | | | |
| VFS | VFS | 虚拟文件系统（VFS） | | |
| typecheck | 类型检查 | | | |
| vocabulary | 词汇 | | | |
| wire format | 协议格式 | 协议格式（wire format） | | |
| workflow | 工作流 | | | |
| wrapper | 包装层 | | | 软件层或 SDK 包装层 |
| wrapper script | 包装脚本 | | | 可执行脚本包装层 |
