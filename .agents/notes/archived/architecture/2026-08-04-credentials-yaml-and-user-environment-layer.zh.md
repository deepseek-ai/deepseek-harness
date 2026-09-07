# Agent Note: 把凭据存储与用户环境层拆开

Status: implemented
Archived: 2026-09-04

[English](2026-08-04-credentials-yaml-and-user-environment-layer.md) | 中文

## Problem

`$DSH_HOME/.env` 同时承担了两件互不相容的工作。它是 [`credentials-local`](../../../../packages/credentials/credentials-local/README.zh.md) 的可写密钥存储，因此任何表层都不能把它提升进 `process.env`——一旦提升，每个已存密钥都会读作只读的启动时覆盖，从而阻断从 Models 页轮换密钥。但它的文件名和 dotenv 格式承诺的是一个环境文件，于是用户把非机密值放进去，而那些值哪儿也到不了：同一个文件里，一个能用的 `DEEPSEEK_API_KEY` 旁边的 `DEEPSEEK_BASE_URL` 会被静默忽略，因为只有凭据 provider 读这份文档，而它只寻址凭据引用。

一个文件无法既是由 Harness 拥有并隔离的存储，又是按普通环境规则传播的层。[请求级凭据决策](2026-07-29-request-level-llm-config-credentials.zh.md)当初选择 dotenv 是为了对齐同类产品的 home `.env`，而这种混同直到有非机密值需要用同一个文件时才暴露出来。

## Decision

两件工作在 Harness home 下拆成两个文件。

**`.credentials.yaml` 是 provider 管理的存储。** 一份从 `CredentialRef` 到非空字符串的严格 YAML 映射，没有 `version` 字段，也没有包装层：

```yaml
DEEPSEEK_API_KEY: sk-…
OPENAI_API_KEY: sk-…
```

因为该文档只存放凭据、别无他物，任何偏离都是拒绝而不是跳过条目：根节点不是映射、非 POSIX 标识符的键、非字符串值、空字符串、重复键以及格式错误的 YAML 全部失败——启动时和写入时响亮失败，运行期热重载则告警并保留最后可用快照。被静默忽略的键读起来就是「我存进去的密钥没有生效」，而这正是本次变更要消除的失败。dotenv 物理行编辑器被替换为对已解析文档打补丁，因此注释与未触及条目的排版都会保留，任何字符串值都能往返（含多行），也不会再有条目因为缺少可用引号样式而不可写。写锁、read-modify-write、`0700` 目录下的 `0600` 原子写、精确路径 watcher、按内容相等抑制自写、以及 dispose 时的完全停稳，均保持不变。

**`$DSH_HOME/.env` 是用户的普通环境层。** [`dsh-app-boot`](../../../../packages/boot/app-boot/README.zh.md) 中的 `loadLayeredEnv` 先解析调用目录的 `.env`，再解析 Harness home 的，并且只在进程中没有更高层值时物化每个已接受的值，从而得到 `用户 < 项目 < 继承`。Harness home 在两个文件加载*之前*就从继承的环境解析完毕，因此项目 `.env` 无法改变读取哪份用户文档。只有产品 CLI（命令行界面）叠加这两个文件；SDK 与示例 bin 仍通过 `loadEnv` 加载各自的目录，绝不继承开发者的 `$DSH_HOME`。

凭据优先级会区分继承环境与发现的文件：继承值仍是只读的按次覆盖，其后是受管文档，再后是仍可写的项目与用户 `.env` 后备值。因此 `set` 会替换发现文件中的值，而不是因为扁平化的 `process.env` 视图认为写入会被遮蔽就加以拒绝。

不做迁移。已经放在 `$DSH_HOME/.env` 里的密钥会继续作为后备值解析；Models 页一旦存储该引用，受管文档就会优先。

## Consequences

- 放弃的：留在 `$DSH_HOME/.env` 里的密钥会被物化进 `process.env`，因而会按[子进程凭据清洗](../../../../packages/subprocess/subprocess/README.zh.md)的规则抵达子进程，而不再留在 provider 内部。它仍是 `.credentials.yaml` 之下的可写后备值；需要由 Harness 拥有并隔离的密钥属于受管文档，后者永不物化。
- 换来的：用户 `.env` 里的非机密值终于生效，这正是最初的缺陷；文档格式可以拒绝它无法承担的内容；`0600` 保护的是一个只存密钥的文件，而不是一个我们同时叫用户往里写普通配置的文件。
- 提供方写入时使用的 `0600` 同样约束它读取的内容：在 POSIX 上，只要文档带有任何 group 或 other 权限位，就会在读取内容之前让启动失败——启动时与每次 reload 都检查，诊断里给出 `chmod 600` 的修复命令。Windows 没有可检查的 mode（其 ACL 无法在此表达），因此跳过该检查而不是伪造它。
- `0600` 这条边界仍然只挡其他 OS 用户、挡不住模型，本次拆分未改变这一点——该限制及 keychain 提供方的延后项归 [提供方 README](../../../../packages/credentials/credentials-local/README.zh.md) 所有。

## Alternatives considered

**保留单一的 `$DSH_HOME/.env`，让 CLI 去提升它。** 否决：提升存储本身正是让已存密钥无法轮换的原因，这也是 [app-boot 当初记录该排除](../../../../packages/boot/app-boot/README.zh.md)的理由。冲突来自这个文件的两份工作，而不是加载器。

**`$DSH_HOME/.credentials.env`——第二个 dotenv 文件。** 否决：dotenv 适合环境层，却无法表达「一份按凭据引用索引的受管文档」。它无法拒绝非字符串或无法寻址的键，而且它的行编辑器本来就会拒绝无法加引号的值，留下可读却不可写的条目。

**给新文档加 `version` 字段。** 否决：该格式只有一个受 schema 约束的字符串 mapping，没有需要判别的历史变体。在未发布阶段，直接修改结构并拒绝旧结构，好过提前承诺迁移协议。

**首次运行时把形似凭据的键从 `$DSH_HOME/.env` 迁出。** 否决：迁移代码会把短命格式变成长期维护面，而判断一个未知文件里哪些键是密钥，恰恰是本次拆分要消除的歧义。旧文件继续作为环境工作，这是诚实的结果，而不是静默的结果。

**彻底取消用户 `.env` 层，只保留继承的环境。** 在此处否决为超出范围：它本身是自洽的设计（层次更少、每个值只有一处来源），但会移除用户已有的工作流，而分层问题属于那个被延后的优先级决策，不属于本次拆分。
