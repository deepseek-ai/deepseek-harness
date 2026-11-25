# Agent Note: Weighted approval 增加机器账号 review 试点

Status: implemented

[English](2026-11-18-weighted-approval-as-review.md) | 中文

## Problem

必填的 `weighted approval` commit status 把审批决定留在 CI 检查组里。它在策略满足前一直是 `pending`，所以等待审批看起来像 CI 正在运行，并且用自定义 status 重复了仓库原生的 review 要求。Issue #6719 记录了后续 `pull_request_target` 运行可能让 merge box 停在 `Expected`，而 API 报告 `success`。

此前的 [关于 commit status 的决定](../../archived/process/2026-10-20-weighted-approval-status-gate-with-check-run-label.md)保留了该 status，因为必填 check run 无法稳定关联到拉取请求 head。直接替换 status 会在基于 review 的要求得到验证之前移除对两点策略的唯一强制执行。GitHub App 身份无法满足基于团队的 required reviewer，因为 App 安装不是团队成员；而且每次评估都要用私钥签发 App token。

## Decision

分阶段上线期间保留 commit status 要求。旧版 `weighted-approval` workflow 继续在既有路径发布 `weighted approval` commit status 和 `weighted approval decision` check run，处于启用状态的 ruleset 20925054 继续要求该 status 和一个 approving review。机器账号的 review 可以满足这一 review 数量要求，但无法满足该 status；低于加权阈值的拉取请求仍被该 status 阻塞。status 由 job token 发布；决定标签优先使用配置的 App slug 所属的 check run。签发 App token 失败时，标签改用 job token；标签失败不会移除必填 status。旧版 publisher 仍是委托的人类 review dismissal 和 review request 的唯一写入者。

第二个 workflow `weighted-approval-machine` 以机器账号 `deepseek-ai-harness`（用户 ID 359032549）发布同一决定，形式为原生 review。它复用评分策略，以及无权限的 `weighted-approval-review-event` workflow 转交路径。它只写自己的评论、approving review 和对该 approval 的 dismissal；它读取评分所需的其它 review、评论、权限和历史。它从不 dismiss 人类 review，也不发起 review request。

试点使用 `secrets.DSH_APPROVAL_BOT_TOKEN`，即机器账号的 PAT。`evaluate` job 以字面量声明 `environment: weighted-approval`；该固定环境提供取值。可复用 workflow 的 `workflow_call` 以 `required: true` 声明 `DSH_APPROVAL_BOT_TOKEN`，调用它的旧版 publisher 只转发名称（`DSH_APPROVAL_BOT_TOKEN: ${{ secrets.DSH_APPROVAL_BOT_TOKEN }}`），不使用 `inherit`。即使被调用 job 的环境提供取值，调用方仍必须传入名称；同名时环境 secret 优先于仓库或组织 secret。独立触发路径不变：它们的 `evaluate` job 声明同一环境并直接读取该 secret。该环境的部署分支策略只允许 `master`，没有 tag 规则，并禁用管理员绕过；不满足该策略的部署会在 job 的步骤开始前被拒绝。`required: true` 会让省略该 secret 的调用方失败，但不证明环境 secret 有值；试点的 token 身份校验会在任何写入前拒绝缺失或错误的值。[GitHub 文档：在可复用 workflow 中传递 inputs 和 secrets](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)记录了按名称传入与环境优先级。试点不签发 App token，也不持有 App 私钥。任何写入之前，它按数字用户 ID 和 login 校验该 token 属于机器账号。它用 PAT 读取策略输入，并用只读的 `GITHUB_TOKEN` 获取合并历史和 production ownership。它按用户 ID 识别自己的评论和 review，因此其它账号复制的 marker 会被忽略。两个 publisher 都把机器账号的 review 排除在计分之外。

试点发布：

- 策略未满足时，创建或更新一条带 `<!-- weighted-approval -->` 标记的评论。评论列出分数、计入的 approval、剩余点数、阻塞的 change request、仍在等待的委托 review，以及没有写权限的 review。
- 策略满足时，先为被评估的提交提交带同一标记的 `APPROVE` review，等 review 记录后才删除该评论。提交失败时评论保留。如果最近一条 review 已经是该提交的 `APPROVED`，不再提交第二条。
- Draft 会撤回每一条带标记的机器账号 `APPROVED` review，并删除评论；Draft 永远不会被 approve。阻塞的 change request 或低于阈值的分数也会撤回这些 review，然后发布或保留评论。
- 提交 approval 之前，它重新读取拉取请求，并在其关闭、变为 draft 或 head 变化时让 run 失败。review 携带被评估的 commit ID，试点会校验返回的 review 指向该提交。

试点不在评估前 dismiss 自己的 approval，因为 dismiss 本身会是一次 review 事件，并触发另一轮评估。身份校验之后，评分失败会尝试 dismiss 每一条带标记的机器账号 approval，然后让 run 失败。setup、凭据或 API 失败以及未送达的事件仍可能留下较早的 approval，因此这些路径上不能保证失败时没有 approval。ruleset 20925054 和 27532727 的 stale-review dismissal 都保持关闭，所以发布后的 push 不会自动撤回 approval；下一次评估会重新给新 head 计分。策略仍满足时，显式 dismiss 该 approval 会触发一次评估，并为当前 head 提交新的 approval。workflow run 是异步的，因此拉取请求可能短暂显示针对较早提交的 approval。这些是试点的限制；在错误行为、延迟和 stale approval 行为得到处理并验证之前，不启用 required review team。

发布由 `DSH_APPROVAL_REVIEW_SCOPE` 控制：未设置时禁用试点；一个精确的十进制拉取请求编号只发布该拉取请求；`all` 广泛发布打开的拉取请求事件。`workflow_dispatch` 输入 `pull_number` 在 scope 选中该拉取请求时，从默认分支重新评估一个打开的拉取请求。试点期间 ruleset 27532727 保持禁用，不增加单独的要求。处于启用状态的 ruleset 20925054 要求一个 approving review 和 `weighted approval` status；机器账号的 review 满足该 review 数量要求，但低于加权阈值的拉取请求仍被该 status 阻塞。

在试点验证评论更新、approval 提交、dismissal、head 绑定、错误行为、延迟和 stale approval 行为之后，重新评估该要求将覆盖的每个打开的拉取请求，并检查其已发布的评论或 approval。在一个临时分支上配置隔离的 ruleset，其 include 条件只写该分支的精确名称，把一个只有机器账号一名成员的团队设为所有文件的 required reviewer，`minimum_approvals: 1`，并用拉取请求验证根目录文件、dotfile 和嵌套文件；不要在测试中把该团队加入 ruleset 20925054 或 27532727，不要把测试 ruleset 应用于生产分支，并在测试后删除它。验证之后，把同一团队和覆盖要求涉及路径的文件模式加入 ruleset 27532727，并启用该 ruleset。该要求使机器账号的 approval 成为强制要求。只有该团队要求得到验证后，发布流程才退役旧版 status 要求和 publisher。在此之前不移除两者。

## Verification

审批策略套件用 `pnpm run test:approval-policy` 运行 keyless 测试，覆盖两个 publisher：旧版 status 发布；试点的评论和 approving review 发布；撤回；scope 选择；机器身份；head 绑定；委托；计分；以及 API 失败。`scripts/ci-workflow.spec.ts` 中的 workflow 测试钉住可信 checkout、无权限的 review 事件转交、旧版 status 与 App 标签 token、`evaluate` job 上的字面量 `weighted-approval` 环境、`required: true` 的 `workflow_call` secret 声明与调用方只转发名称、试点 PAT、试点不签发 App token、scope 变量、workflow-dispatch 输入、事件和命令。

已合并的 #9005 探针只在一个专用探针环境上测量了手动 `workflow_dispatch` 运行的环境隔离：其受保护的 job 在 `master` 读到 marker secret，同一个 job 在 topic 分支上的任何步骤执行前被拒绝，而没有环境的独立 control job 在 topic 分支上运行，并断言 marker 不存在。它没有测量 `pull_request_target`、`workflow_run`，也没有测量旧版 publisher 发起的委托 `workflow_call`。在试点覆盖第二个拉取请求之前，先在一个隔离的拉取请求上验证 `evaluate` job 能到达 `weighted-approval` 环境，并在这三条路径上读取 `DSH_APPROVAL_BOT_TOKEN`。确认每次运行都为该环境记录一次部署，并且 publisher 完成身份校验并写入。测试期间把 scope 设为该拉取请求的编号，在三条路径全部通过前不要设为 `all`。

线上发布分阶段进行，且不在本次改动中执行：本次改动不设置该变量、不启用 ruleset 27532727，也不移除旧版 status 要求。先把 `DSH_APPROVAL_REVIEW_SCOPE` 设为一个已有两个 approval 点的试点拉取请求编号，确认机器账号提交一条 `APPROVE` review，其 `commit_id` 是当前 head、`user.id` 是 359032549，并确认状态评论消失；仅凭 `reviewDecision` 为 `APPROVED` 无法看出是谁批准、批准的是哪个提交。低于两点的拉取请求保留评论，且没有机器账号的 approval。然后把变量设为 `all`，在打开的拉取请求事件上验证相同行为。在启用团队要求前，重新评估每个匹配的打开的拉取请求。只有在 required review team 配置完成，且其错误行为、延迟和 stale approval 行为得到验证之后，才退役旧版 status。

## Alternatives considered

**直接替换 commit status。** 否决，因为它在基于 review 的要求得到验证之前就移除强制执行；ruleset 27532727 处于禁用状态，required review team 也未经验证。

**用 GitHub App 发布 review。** 否决，因为 App 安装不能加入团队，无法满足未来只有一名成员的团队 required reviewer；而且每次评估都要用私钥签发 token。

**把试点 PAT 保留为仓库或组织 secret。** 否决，因为任何有写权限的用户都可以推送一个修改过的 workflow 分支，在没有环境的情况下读取该 secret；环境作用域的副本对不声明 `weighted-approval` 的 job 不可用，而该环境只允许 `master` 部署。

**永久保留 commit status。** 否决，因为该 status 仍是阻塞合并的 CI 条目，并可能显示 `Expected`（issue #6719）；试点的目的就是在验证后替换它。

**试点不设 scope 限制。** 否决，因为意外的评论或 review 状态会波及每个拉取请求；scope 变量先把影响限制在一个试点拉取请求，再扩展到 `all`。

**让试点同时协调委托 dismissal 和 review request。** 否决，因为两个 publisher 会写同一批人类 review；并存期间旧版 publisher 保持唯一写入者。

**第一轮就要求该单成员团队。** 否决，因为试点失败会阻塞每个拉取请求；团队要求等待验证。

## Consequences

并存期间，处于启用状态的单个 approving review 要求可以由机器账号的 review 满足，而低于加权阈值的拉取请求仍被必填 status 阻塞。在 ruleset 27532727 和团队要求启用之前，它们不增加强制执行。评分失败会尝试 dismiss 试点的 approval，但 setup、凭据或 API 失败以及未送达的事件可能留下较早的 approval；发布后的 push 也可能让较早提交的 approval 保留到下一次评估。reviewer 必须检查被评审的提交。

机器账号需要对仓库的写权限。其 PAT 必须轮换，并且只保存为 `weighted-approval` 环境 secret `DSH_APPROVAL_BOT_TOKEN`；仓库作用域不得保留副本，并且必须移除本仓库对同名组织 secret 的访问权限，因为不声明该环境的 job 可以读取任一副本。这比旧版 check-run 标签所用的 App 安装有更宽的访问权限。GitHub 会拒绝机器账号对自己创建的拉取请求提交 approval。启用单成员团队要求后，人类 approval 无法满足该团队要求，因此机器账号创建的拉取请求不得以受覆盖的 ref 为目标。

团队要求生效后，机器账号的 approval 成为强制要求，加权分数决定每个拉取请求能否合并；任何有写权限的人类 approval 都不再单独满足要求。退役 status 后，后续 `pull_request_target` 运行不再出现 `Expected` 故障。旧版 publisher 的 job 不再是必填检查；试点评估失败会作为失败的 run 出现，但不会阻塞已有 required team approval 的合并。
