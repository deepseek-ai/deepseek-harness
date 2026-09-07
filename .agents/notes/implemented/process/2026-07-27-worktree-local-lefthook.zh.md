# Agent Note: 让 Lefthook 安装限定于各 worktree

Status: implemented

[English](2026-07-27-worktree-local-lefthook.md) | 中文

## 问题

每次运行 `pnpm install` 都会执行根目录的 [`postinstall`](../../../../package.json)，其中的 [`install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) 会调用 `lefthook install --force`。若无额外配置，关联的 Git worktree 共用同一仓库的默认钩子目录，因此在任一 worktree 中安装都可能改写其他所有 worktree 使用的钩子。

Lefthook 生成的钩子会优先使用安装时从对应 worktree 记录的绝对二进制文件路径，之后才尝试当前 worktree 的回退路径。因此，共享钩子会一直运行另一个 worktree 固定版本的二进制文件，直到该 worktree 消失；并发安装还会写入同一组文件。

## 决策

钩子安装以 worktree 为作用域。当 `CI=true` 或 `GITHUB_ACTIONS=true` 时，安装程序会在探测 Git 或做出任何变更之前返回，因为自动化任务不会使用贡献者钩子。否则，安装程序要求 Git 2.26 或更高版本，使 `git config --show-scope` 可以报告由哪个作用域提供配置值；它会将格式版本为 0 的仓库升级到格式版本 1，启用 `extensions.worktreeConfig`，并将当前 worktree 的 `core.hooksPath` 设为指向 `$GIT_DIR/dsh-hooks` 的绝对路径。

升级格式 0 之前，安装程序会拒绝共用配置中直接设置的 `extensions.*`；它还会拒绝直接设置的 `core.worktree` 或 `core.bare=true`，以及启用扩展后将被激活的非空休眠 worktree 配置。迁移会移除直接设置的 `core.bare=false`，因为 false 是 Git 的默认值。共用仓库配置和每个已有的 `config.worktree` 都必须是常规文件。这些检查会禁用 include 展开，因为 Git 的仓库格式解析器也会忽略 include 目标。仓库级锁会串行化迁移和钩子写入；释放时，锁的进程 ID、随机令牌、文件身份和完整内容必须仍然匹配。所属进程已结束或内容无效的锁必须人工介入恢复，而不能自动强制解除。

每个钩子目录都有一个 JSON 所有权标记，其中包含上次写入 worktree 配置的绝对路径。检出目录移动后，该标记只允许替换确切的陈旧自有值。Git 会以主 worktree 的配置为新链接 worktree 初始化 `config.worktree`；当该初始配置包含某个已注册 worktree 中由所有权标记佐证的保留钩子路径时，安装程序只会在新 worktree 的配置中将其替换为新 worktree 自有的路径。Lefthook 运行前，所有权标记和每个已有的生成钩子都必须是不带别名的常规文件。安装程序会解析 `core.hooksPath` 的生效作用域、来源和值，包括通过当前生效的 `config.worktree` include 加载的值；它会拒绝命令作用域路径、非自有的 worktree 作用域路径以及非自有的保留目录。继承自系统、全局或共用仓库配置的路径必须设置 `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1`，从而只让当前 worktree 显式启用 Lefthook。未生效的 `includeIf` 目标不会被递归检查，因为它们不影响当前配置。完成验证后，Lefthook 子进程的环境会移除命令作用域的 Git 配置。

若 Lefthook 在更改 `core.hooksPath` 后失败，安装程序会恢复先前的 worktree 值；若回滚失败，会与安装失败一并报告。`$GIT_COMMON_DIR/hooks` 中的现有文件绝不会被移除或改写。有针对性的安装程序测试锁定了以下行为：隔离、对复制而来的新 worktree 配置的处理、迁移拒绝、所有权与检出目录移动、并发安装、自定义路径及回滚。

## 考虑过的替代方案

**保留共享的生成钩子，并依赖其当前 worktree 回退路径。** 只要对应 worktree 仍存在，记录的绝对路径就会优先生效，因此回退路径无法提供版本或生命周期隔离。

**让每个 worktree 都指向同一个纳入版本控制的 `.githooks` 目录。** 使用受版本控制的相对目录可以消除生成的绝对路径，但更改共享的 `core.hooksPath` 可能会禁用旧 worktree 中的钩子，因为其分支并不包含该目录；同时，每个 worktree 仍然耦合于同一个共享配置值。

**构建通用的钩子管理器串联层。** 执行顺序、参数转发、失败语义和升级都会成为仓库自行负责的行为，却与 Lefthook 隔离无关。因此，安装程序会拒绝 worktree 专属的自定义路径，只将范围更窄的继承路径覆盖设为显式操作。

**将特定 CI 提供商的凭据 include 路径加入白名单。**CI 不使用贡献者钩子，因此路径豁免会使安装程序的安全性耦合于 CI 提供商检出流程的内部实现，并削弱贡献者安装时的严格验证。在 CI 中直接跳过操作，无需任何豁免即可避免修改仓库。

**停止自动安装钩子。** 手动设置可以避免共享写入，却会使仓库中低成本的提交与推送检查意外变成可选项，短期存在、由 agent（智能体）使用的 worktree 尤其容易受到影响。

## 后果

安装或移除任一 worktree 不再改变其他 worktree 的生效钩子、二进制文件路径或生成的钩子字节。并发安装会串行执行，重复安装保持幂等；[快速本地 Git 钩子](../../archived/process/2026-07-22-fast-local-git-hooks.md)所规定的任务与延迟边界保持不变。

首次安装后，仓库会采用 Git 格式版本 1。安装程序需要 Git 2.26 来使用 `--show-scope`；worktree 配置扩展本身的出现早于该命令。自定义 worktree 钩子管理器需要明确选择集成方式；继承钩子路径可继续供其他 worktree 使用，但当前 worktree 显式启用 Lefthook 后，其中不会运行这些继承钩子，除非贡献者通过 `lefthook.yml` 将其串联起来。

旧的共用钩子会为尚未升级的 worktree 保留在磁盘上。它们可能逐渐陈旧，但自动删除这些钩子会破坏已注册但所在分支尚未采用本安装程序的 worktree。
