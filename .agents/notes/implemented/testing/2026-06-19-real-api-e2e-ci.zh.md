# Agent Note: 在 CI 中对外部 DeepSeek API 运行真实 API e2e 测试

Status: implemented

[English](2026-06-19-real-api-e2e-ci.md) | 中文

## 问题

根据策略，harness 高度依赖真实 API 测试：[docs/testing.md](../../../../docs/testing.zh.md) 指出，无密钥套件证明的是管线，而非产品；[ACP（Agent Client Protocol）inject 事故复盘（postmortem）](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)则是常设证据——178 项无密钥测试保持绿色时，真实 ACP 客户端会话却立即崩溃。真实 API e2e 套件（`pnpm run test:e2e`，即 `*.e2e.ts` 文件）的存在正是为了弥合这一缺口：它针对线上 DeepSeek API 驱动 agent（智能体）——真实模型调用、真实 bash 工具、多轮次、恢复、ACP-over-stdio。

默认门禁（[.github/workflows/ci.yml](../../../../.github/workflows/ci.yml)）刻意无密钥：不携带 secret，可供 fork 运行。`test:e2e` 在无密钥时自动跳过（`describe.skipIf(!process.env.DEEPSEEK_API_KEY)`），因此将其加入该工作流只会报绿而不会真正执行真实套件。要让真实 API 覆盖率成为合并信号，需要一个独立的、携带 secret 的工作流。

## 决策

一个与 ci.yml 分离的专用工作流 [.github/workflows/e2e.yml](../../../../.github/workflows/e2e.yml) 使用 repo secret 对外部 API 运行且仅运行 `pnpm run test:e2e`，仅在可信事件上触发，并带有一个 preflight 检查：将缺失的 secret 转化为明确的失败而非虚假的绿色。无密钥工作流保持独立，使可 fork 的质量门禁与消费 secret 的真实 API 门禁各自拥有不同的触发和凭证策略。

### 独立工作流，而非 ci.yml 中的一个 job

ci.yml 的价值在于它无密钥、可 fork、始终为绿：任何贡献者（包括外部 fork）都能获得完整的无密钥信号，secret 不在爆炸半径内。在其中添加消费 secret 的 job 会将这个始终为绿的门禁耦合到凭证可用性和不同的触发策略上。将携带 secret 的工作放在独立文件中，隔离了 secret、触发和并发策略，并为 fork 保留了 ci.yml 的特性。不同的生命周期→不同的文件。

### 约束不是成本，而是可靠性

内部推理（inference）成本不是限制因素，因此工作流针对覆盖面和信号优化。它会在多种触发条件和每个受信任 PR（Pull Request）上运行所有匹配的 `*.e2e.ts` 文件，以落实 [docs/testing.md](../../../../docs/testing.zh.md) 的有密钥策略。

### 触发条件：仅限可信事件

`workflow_dispatch` + `push` 到 `main`/`master` + 每夜 `schedule`（`17 0 * * *`，即北京时间 08:17）+ `pull_request`。push 提供合并后信号；schedule 捕捉外部 API 漂移；dispatch 是手动逃生通道；可信 PR 获得合并前门禁。该合并前信号有意接受 § 安全性中描述的更大密钥暴露面。

### 不可信 PR 的门禁

GitHub 对两类 PR 扣留 repo secret：来自 **fork** 的 PR，以及 **Dependabot** PR（同仓库分支，`head.repo.fork == false`，但 secret 仍被扣留）。一个 job 级 `if:` 对两者都跳过整个 job：

```
github.event_name != 'pull_request'
  || !(github.event.pull_request.head.repo.fork || github.event.pull_request.user.login == 'dependabot[bot]')
```

Dependabot 子句基于 PR **作者**（`pull_request.user.login`）而非 `github.actor`（运行触发者）：维护者重新打开或重跑 Dependabot PR 时，`github.actor` 会变成人类，但该 PR 仍然无密钥；基于作者的判断在这种情况下依然正确。被 **job 级** `if:` 跳过的 job 报告为*成功*检查（不同于工作流/触发级跳过会保持 pending），因此如果需要将此工作流标记为 required status check 也是安全的——fork/Dependabot PR 的跳过但绿色的检查不会阻塞合并。

该门禁是一个*干净跳过的便利措施*，而非 secret 的安全边界（见 § 安全性——边界是 GitHub 自身在 `pull_request` 下对 fork 的 secret 扣留机制）。没有该门禁，fork 仍然无法读取密钥；只是会遇到令人困惑的 preflight 硬失败并浪费计算资源。

### Preflight：明确失败，绝不虚假报绿

由于 job 仅在 secret 应当存在的可信事件上运行，preflight 是一个无条件的存在性检查：密钥为空→`exit 1` 并附带 `::error::` 注解指明需要配置的 secret 名称。这是让自跳过套件可以安全地作为门禁的关键。没有它，被删除/重命名/错误配置的 secret 会让 `test:e2e` 跳过所有真实套件并报告全绿——整个安全网的静默退化。该守卫将「secret 缺失」从不可见的虚假通过转化为可见的失败。（其正确性已在实际中验证：secret 存在之前的运行恰好在此步骤失败。）

### Secret 映射与卫生

repo secret 命名为 `DEEPSEEK_API_KEY_EXTERNAL`；映射到适配器和测试读取的 `DEEPSEEK_API_KEY` 环境变量（`process.env.DEEPSEEK_API_KEY`）。独立的 secret 名称记录了意图（这是*外部*公开 API 密钥，不是内部端点密钥），并允许内部端点密钥日后无冲突地共存。以下卫生选择均为防御性设计：

- **步骤级 secret。** `DEEPSEEK_API_KEY` 仅在 preflight 和 e2e 步骤的 `env:` 中设置，从不在 job 级设置——因此 checkout/setup-node/install 永远看不到它。依赖中被入侵的安装时生命周期脚本无法读取不在其环境中的 secret。
- **`permissions: contents: read`。** job 仅读取仓库以运行测试；不需要写权限（无 PR 评论、无 status 写入），因此 `GITHUB_TOKEN` 降至最小权限。
- **`DEEPSEEK_BASE_URL` 固定**为 e2e 步骤上的 `https://api.deepseek.com`。适配器在未设置时会默认使用此值（[packages/llm/llm-deepseek/src/index.ts](../../../../packages/llm/llm-deepseek/src/index.ts) `PUBLIC_BASE_URL`），但显式固定具有自文档性和密封性——仓库根目录的 `.env`（如果存在，`vitest.e2e.config.ts` 会加载它）无法静默地将运行重定向到其他端点。
- **不回显 secret。** preflight 仅打印 `DEEPSEEK_API_KEY present.`——不打印值或长度。

### 范围与运行时形态

job 仅在 Node 24 上运行 `test:e2e`；无密钥门禁和版本兼容性属于主 CI 工作流。测试通过 workspace paths 映射以未构建形式运行，使用有界的可配置 worker 池、逐测试重试和 job 超时。[被取代 CI 的取消策略](../process/2026-09-09-cancel-superseded-ci.zh.md)会在 PR、push、schedule 和手动触发之间取消同一工作流/引用组内的旧运行；合并后或每夜触发并不保证完成。

DeepSeek 原生 `web_search` 探测已注册但会跳过。线上 Anthropic 兼容端点可能返回成功响应却没有结构化来源块，因此对来源存在性的正向断言不是可靠的合并信号；单元测试仍会锁定响应解析行为，但 CI 不会验证线上端点返回的来源块协议格式（wire format）。

## 安全性

仓库的首个 CI secret 需要一份记录在案的威胁模型，因为同仓库 PR、fork PR 和 Dependabot PR 的访问权限各不相同，且仓库公开后会发生变化。

### 私有仓库中谁能触及 secret

- **无写权限（fork PR）：不能。** 两个独立事实阻止了它。第一，工作流使用 `pull_request` 而**非** `pull_request_target`——GitHub 不会将 repo secret 传递给 fork PR 的 `pull_request` 运行，因此 `secrets.DEEPSEEK_API_KEY_EXTERNAL` 在 fork runner 上解析为空。第二，`if:` 门禁完全跳过 fork PR。secret 扣留是真正的边界；门禁是纵深防御和用户体验。
- **有写（push）权限：能。** 同仓库分支 PR 会收到 secret，因此有写权限的作者可以修改测试代码（或安装生命周期脚本，或其分支上的工作流 YAML）来窃取密钥。这**是 GitHub Actions 的固有特性，并非本文引入的**：任何对任何仓库有 push 权限的人都可以通过编写工作流来窃取该仓库的任何 Actions secret。写权限⇒secret 访问权，始终如此。缓解措施在于谁被授予写权限以及分支保护，而非本文件。

因此「任何能开 PR 的人都能窃取它」是错误的：只有写权限集合内的人能，而这些人本来就能窃取仓库持有的任何 secret。

### `pull_request` 触发器增加的残余暴露面

由于启用了 PR 运行，密钥会在合并前被交给**写权限作者 PR 分支上的代码**。这比 `push` + `schedule` + `workflow_dispatch` 的暴露面更大，为在可信写权限集合内获得合并前信号而接受。如果这一权衡发生变化，可移除 `pull_request` 触发器，同时保留合并后、每夜和按需覆盖。

### 仓库公开后的变化

**通过本工作流**，secret 对公众仍然受保护：`pull_request` 在公开仓库上行为一致——fork PR（现在任何人都能开）仍然收不到 secret，且在公开仓库上 GitHub 额外要求维护者批准 fork PR 运行，即使批准后运行也不会获得 secret（批准运行不等于交出密钥）。写权限集合不因可见性改变而改变，因此内部人员的现实也不变。

变差的是*周边*模型，以下是翻转可见性之前需要处理的事项：

- **日志变为全球可读。** 泄露给组织成员的粗心 secret 回显，公开后会泄露给整个互联网并在数分钟内被爬取。secret 处理纪律（不回显值/长度——已做到）的重要性大幅提升。
- **`pull_request_target` 陷阱变为灾难性的。** 如果有人为了「修复」PR 运行而将触发器切换为 `pull_request_target`，工作流将在 base-repo 上下文中运行不可信的 fork 代码并**携带** secret——完整的密钥泄露向量。在私有仓库中这勉强无害，在公开仓库中则是灾难。e2e.yml 中触发器上的 `SECURITY —` 注释禁止此更改并指向本文。
- **翻转时轮换密钥。** 密钥曾存在于私有仓库的 CI 中；将公开视为「假定已暴露」，在那一刻轮换 `DEEPSEEK_API_KEY_EXTERNAL`。
- **将 secret 置于控制之下。** 确认 Settings → Actions → *"Send secrets to workflows from fork pull requests"* 保持**关闭**（这是唯一真正会打破 fork 边界的设置），并考虑将密钥移入带有 required reviewers 的 GitHub **Environment**，使即使已合并的代码也只在受控条件下使用它，且轮换有单一归属。

以上均不需要修改工作流即可公开；它们是运维步骤加上已添加的 `pull_request_target` 守卫注释。

## 曾考虑的替代方案

- **在 ci.yml 中添加消费 secret 的 job**：否决。会将无密钥、可 fork、始终为绿的门禁耦合到凭证可用性和不同的触发/并发策略上；不同的生命周期，不同的文件。
- **省略 `pull_request` 触发器**（更小的密钥暴露面）：为获得合并前信号而否决；安全性章节承载了已接受的暴露分析。

## 后果

新增一个 CI 工作流和仓库的首个需要维护的 secret。真实 API 套件现在作为合并门禁（可信 PR 上的合并前门禁、主分支上的合并后门禁）并每夜运行，因此 agent 与外部 API 交互中的真实故障会在 CI 中浮现，而非仅在开发者的本地运行中出现——代价是每个可信 PR 和合并都会产生真实的（但内部免费的）API 调用。preflight 使 secret 配置错误变为自我通告而非静默禁用安全网。

该设计带有已记录的约束表面：`pull_request` 触发器在密钥暴露方面的取舍（删除它可加强防护）、`if:` 门禁对基于作者的 Dependabot 检查的依赖，以及对 `pull_request_target` 的严格禁止。上方公开仓库检查清单是操作配套——未来维护者在更改触发器集合或切换仓库可见性之前，应重新阅读本 Agent Note，而不是从头推导 fork/secret 模型。

schedule 触发器在仓库不活跃 60 天后会自动禁用（GitHub 行为）；push/PR/dispatch 是后备，活跃的 monorepo 不会触及此限制。假设 runner 对 `https://api.deepseek.com` 有出站连通性——GitHub 托管的 `ubuntu-latest` 具备此条件；受出站限制的自托管 runner 需要在依赖每夜运行之前确认连通性。
