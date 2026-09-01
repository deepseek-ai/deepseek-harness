# 实操手册：添加 workspace 包

[English](adding-a-package.md) | 中文

为新建 `@deepseek-ai/dsh-<name>` 包提供的逐文件清单。本清单以 bash 和适配器这两个包为模板进行验证；如果清单与模板有出入，请在此修正。

## 1. 创建包

```
packages/<group>/<pkg>/
  package.json     # copy from packages/core/tools, adjust name/description/deps
  tsconfig.json    # extends ../../../tsconfig.base.json, rootDir src,
                   # outDir lib/types, references: ../../../vendor/cosmokit,
                   # ../../../vendor/cordis (+ ../../../vendor/schemastery if
                   # you use Config, + ../../<group>/<dep> for each dsh dep)
  src/index.ts     # service default export or plugin (name/inject/apply/Config)
  README.md        # service API, events, extension points, design notes,
                   # + gated Model Experience context blocks or short form
                   # + the gated "Known Limitations and Deferred Work" section
                   # (or a whitelist entry in scripts/verify-package-readme-limitations.ts)
```

当已有分组与包的角色匹配时，选择该分组（`core`、`llm`、`shell`、`compaction`、`subagent`、`todo`、`session`、`client`/`host`、`util` 或 `test-support`）。允许新建分组，但分组只是纯容器：没有 `package.json`，没有源文件，包仍然恰好位于其下一层。

package.json 不变式（由 `pnpm run constraints` / `scripts/check-workspace-constraints.ts` 强制执行）：`private: true`，`version` 与根 `package.json` 一致，`type: module`，`main: "lib/index.js"`，`types: "lib/types/index.d.ts"`，`exports["."].types: "./lib/types/index.d.ts"`，`exports["."].default: "./lib/index.js"`，`@deepseek-ai/cordis` 同时出现在 peerDependencies 和 devDependencies 中（相同范围）。每个 dsh 对等依赖（peer dependency）都要在 devDependencies 中镜像。`@deepseek-ai/schemastery` 放在 `dependencies` 中（它是运行时校验器），与 agent-loop 保持一致。`files` 列表精确包含 `lib/index.js`、`lib/types/**/*.d.ts` 以及门禁认可的包专用运行时产物；发布 `./invariant` 的包还要包含 `lib/invariant.js`。如果包的运行时 export 指向输出树，还要包含 `lib/types/**/*.js`。不要发布 `src`、声明映射、JS map 或陈旧的根声明文件。带有 `bin` 的 CLI 应用包在 `files` 中将 `lib/bin.js` 紧跟在 `lib/index.js` 之后。

包内的相对导入在源码中使用显式 `.ts` 后缀（例如 `export * from './types.ts'`）。编译器在输出的 JS 中将其重写为 `.js`，在声明文件中保留显式 `.ts` 后缀；标准的 NodeNext/Node16 TypeScript 消费方会将其解析到同目录的 `.d.ts` 文件。

## 2. 在根配置中注册

| 文件 | 变更 |
|---|---|
| `tsconfig.base.json` | 已有分组无需编辑；新分组需为 `@deepseek-ai/dsh-*` 通配符添加 `./packages/<group>/*/src` 候选路径 |
| `tsconfig.host.json`（Host 包）或 `tsconfig.client.json`（Client 包） | 在 `references` 中添加 `{ "path": "./packages/<group>/<pkg>" }`——普通包恰好属于一个 aggregate，绝不两个都加。`api/remotes` 因 Host 生成约定与 Client 消费约定之间存在顺序依赖而使用仓库专属拆分，新增包不得仿照（[布局](../development.zh.md#typescript-project-layout)） |

`packages/client/*` 包改为 extends `tsconfig.base.client.json`（而非 `tsconfig.base.json`）；client 插件包还需在 package.json 声明 `dsh.client`、导出 `./client`、调用共享 tsdown preset（`packages/client/tsdown.client.ts`）——client 侧见 [packages/client/AGENTS.md](../../packages/client/AGENTS.md)。

以下内容由 glob 或包 manifest（元数据清单）发现机制自动覆盖，无需手动编辑：根 `package.json` workspaces、`scripts/publint-all.ts`、`tsdown.config.ts`、`.oxlintrc.json`、`scripts/check-workspace-constraints.ts`。

## 3. 确定包拓扑

对于可替换的能力，当 Service Definition／Service Provider／Consumer 角色需要独立演进时，将它们拆分到不同包中（见 docs/architecture.md § "Capability seams"——shell 三组件是模板）。单一用途的插件保持为一个包。

### 使用符合实际的角色名称

名称必须描述当前稳定职责。不要用首个实现、可能的未来扩展或 Cordis 基类命名。接口包使用能力名称。实现包加上能够区分实现的机制、协议、环境或厂商限定词。只有同主机执行属于约定时，才使用 `local`。

一个 engine、runtime、policy、controller、resolver、store 或当前配置使用单数 `ctx` key。registry 或拥有多个具名成员的服务使用复数 key。类的角色与 key 的单复数必须一致。不得让不兼容的 host 与 client 声明复用同一个 Cordis `Context` key。即使二者使用独立的运行时 context，TypeScript 声明合并仍会同时看到两种类型。如果自然复数已经属于另一个端面，就增加职责后缀。

| 词 | 适用条件 | 不适用条件 |
|---|---|---|
| `Controller` | 接受命令或用户意图，并改变一项既有领域状态或展示状态。 | 执行任意工作、拥有一组 provider，或只把值转换为展示形式。 |
| `Store` | 拥有一组数据，主要提供该数据的 CRUD、snapshot 或 subscription 操作。 | 校验状态机、裁决权限、分派工作或拥有 provider 优先级。类中有 map 不等于 store。 |
| `Directory` | 暴露供发现或选择的条目及其元数据。 | producer 向其中注册任意实现，或调用方通过它执行工作。 |
| `Presenter` | 将领域值或工具参数纯转换为渲染意图。 | 执行 I/O、订阅、修改状态或拥有生命周期。 |
| `Registry` | 拥有一组动态具名注册，以及查询、重复项或优先级规则、生命周期和释放。 | 主要约定是分派、执行、取消、策略或编排。 |
| `Runtime` | 运行实时工作，并跨调用拥有分派、取消、provider 协调或操作生命周期。 | 只存储记录、返回目录、解析一个值或保存配置。 |
| `Resolver` | 根据输入计算或定位一个答案，但不拥有该答案的生命周期。 | 拥有可变集合或长时间运行的执行过程。 |
| `Binder` | 把一个已声明接口绑定到调用方的 context 或生命周期，并返回绑定值。 | 把该值作为集合持有、控制其领域状态，或只转换数据。 |
| `Engine` | 实现领域算法或有状态执行模型。 | 只选择 provider 或跨协议边界转发请求。 |
| `Policy` | 决定允许、选择、限制或观察什么。 | 执行该决定所允许的机制。 |
| `Executor` | 在一项能力中运行一个明确请求或已解析 spec。 | 拥有广泛应用生命周期或 provider 目录。 |
| `Gateway` | 适配进程、网络、RPC 或 API 边界。 | 只注册同进程服务或存储元数据。 |
| `Provider` | 提供一项能力定义的一个实现。存在多个实现时，加上机制或厂商限定词。 | 表示能力定义、provider registry 或消费方 runtime。 |
| `Backend` | 在已定义接口之后实现可替换的底层持久化、传输或执行。 | 表示面向用户的服务或一个已返回的实时资源引用。 |
| `Handle` | 引用一个实时资源，并控制或观察该资源。 | 创建并管理完整资源池。 |
| `Config` | 拥有一个已解析配置值，或一项边界严格的配置记录及其更新约定。 | 存储通用集合、执行工作或暴露无关设置。 |
| `Service` | 拥有一项无法用以上更精确角色诚实描述的内聚领域服务。 | 只因为类继承 Cordis `Service` 而使用该名称。 |

只对受支持的 Python 与 TypeScript SDK 所使用的 JSON-RPC 客户端／服务器协议使用 `SDK`。DeepSeek Harness 本身是 agent harness，不是 SDK 项目。产品拼写统一使用 `Typert`，不得使用 `TypeRT` 或 `typeRT`。

<a id="4-write-the-package-readme"></a>

## 4. 编写包 README

将包特有的服务 API、配置、事件、扩展点和设计说明放在前面。根据 [dsh-doc 元数据参考](../../.agents/skills/dsh-doc/references/metadata-links-i18n.md#the-kind-system)中的四种 kind 标签——组、参考、库或 bundle——选择 frontmatter 的 `kind`，使其匹配包在仓库中的位置与入口形态；每个 kind 恰好对应一个 README 模板。limitations 部分记录持久的消费方缺口和本包拥有的非显而易见的维护者约束；日常清理事项留在源码 TODO 或 Agent Note 中。间接的 Model Experience 语句可以点名暴露本包贡献的消费方，但不重述该消费方的实现。包 README 以如下规范序列结尾：

````markdown
## Model Experience

### Request context and condition

#### What the model sees

The exact data-dependent fields, an anchored generated-catalog link, or an introduction to the verbatim literal below.

##### Verbatim text for this field, when needed

```markdown
Stable system-prompt prose of any length, or another long non-generated literal, copied exactly from source.
```

#### Token effect

Fixed, conditional, retained, replaced, capped, or zero-direct token effect.

#### KV Cache effect

Append-only, prefix-stable, replacing, or independent behavior, including the exact conditions that may invalidate reuse.

## Known Limitations and Deferred Work

- **Consumer-visible gap** — exact missing operation or case, its consequence, and any maintainer constraint.
````

根据实现填写 Model Experience。每个直接、条件、上限、生命周期或辅助的模型上下文条目使用一个 H3，包含上述三个有序 H4 字段，每个字段下有一个正文段落。引用包拥有的稳定文本：系统提示词放在引出它的字段下，用带标题的 H5 加 `markdown` 围栏表示，通常归入 `What the model sees`；其他短文本以命名占位符内联，其他长文本使用相同的嵌套形式。仅概述数据依赖或提供方拥有的文本。工具 schema 条目链接到生成的[工具目录](../tool-catalog.zh.md)中对应的锚定章节，仅说明该处缺失的差异。当作用域可以隐藏 prompt 或 schema 其中之一而不影响另一个时，将二者分开。填写 `KV Cache effect` 时，应区分仅追加增长、稳定重复的前缀、替换既有请求 token 和独立模型请求，并列出会使缓存复用失效、且由本包拥有的变化。“不使缓存失效”仅表示本包保留了已有的可复用前缀；缓存是否可用以及何时淘汰不属于本包约定。[行文标准](../../.agents/skills/dsh-prose-standard/SKILL.md)约束完整性与归属；验证器强制执行所需章节结构。

没有上下文效果或仅有消费方拥有路径的包使用 [`SENTENCE_MODEL_EXPERIENCE`](../../scripts/verify-package-readme-model-experience.ts) 中经过审计的 `None, as ` 或 `Indirectly, through ` 语句，随后添加 `KV Cache effect` H4 和一个非空正文段落；与模型无关的通用包可以改为加入 `NO_MODEL_EXPERIENCE_SECTION`。两种情况都不要展开为对另一个包工作的描述。limitations [allowlist](../../scripts/verify-package-readme-limitations.ts) 独立管理。[Model Experience Agent Note](../../.agents/notes/implemented/process/2026-07-12-package-model-experience-contract.zh.md) 记录了设计动机。

## 5. 验证

```sh
pnpm install        # registers the workspace
pnpm run doc-sync
pnpm run constraints && pnpm run typecheck && pnpm run lint
pnpm run build && pnpm run hygiene
```

请遵循[仓库测试政策](../testing.zh.md)，执行新包所需的行为专项检查并达到相应覆盖率。
