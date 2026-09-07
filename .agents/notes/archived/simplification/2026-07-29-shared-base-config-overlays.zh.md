# Agent Note: 一份共享 base 配置加各 surface 的 overlay

Status: implemented
Archived: 2026-09-04

[English](2026-07-29-shared-base-config-overlays.md) | 中文

## 问题

`dsh` 交付了两棵完整的配置树，其中有 43 个共享配置项。`apps/cli/cordis.yml` 以 74 个平铺配置项组合 web surface，而 TUI 启动的是 `examples/tui-agent/cordis.yml`——其中单独一行 `@deepseek-ai/dsh-tui-demo` 挂载了十二个插件，并把它们的配置重新声明为自己那份二十个键、仅作透传的 `Config`。

这两份文件都名不副实。`examples/tui-agent` 并不是示例：`apps/cli/src/tui.ts` 把它硬编码为产品的默认配置；它还拥有 TUI 的 PTY 冒烟测试、八个终端快照场景，以及被 `cordis-agent` 叶节点 import 的 PTY harness。`dsh-tui-demo` 也不是 demo——它就是应用本身，由交付的二进制从 `packages/examples/` 中挂载。

真正决定性的问题是重复。43 个共享配置项中，38 个逐字节相同，5 个因各 surface 的正当理由而不同；因此每次能力改动都必须改两处，而且可能无声漂移。该组合包还反转了一个默认值：`composeTuiApp` 读取 `config.goals ?? {}`，于是交付的 TUI 挂载了 goals、`tool-goal`、`goal-round-driver` 和 `/goal`——尽管没有任何配置键要求它们。

## 决策

一份共享 base，每个 surface 一份 overlay，以平级 patch 列表的形式组合。

`apps/cli/config/base.cordis.yml` 持有两个 surface 都会挂载的 43 个配置项。`apps/cli/config/tui.cordis.yml` 与 `apps/cli/config/web.cordis.yml` 是 **patch 列表**，不是配置树：各自声明少数取值因 surface 而异的配置项，并 insert 自己的配置项。启动器只 include base 一次，并把每个 overlay 作为**同一** include 层级上的平级 patch 列表应用——因为 include patch 不会跨越 include 边界，把 overlay 堆叠成嵌套 include 会使其静默地无法触达 base 配置项。

优先级即列表顺序，逐配置项后写者胜：base，然后是 surface overlay，接着是 `--config` overlay 或个人 `~/.dsh/config.yaml`，最后是启动器自身的 flag 与 profile patch。

`--config <path>` 应用一个 overlay 来**取代**个人 overlay，因此测试树绝不会继承用户的提供方与 model。`--config-replace <path>` 则把某个文件作为整棵树启动，同时绕过 base、surface overlay 与个人 overlay。两个 flag 都会在 `/resume` 的 execve 交接中保留，否则恢复时会静默更换 agent（智能体）。

patch 会整体替换目标配置项的 `config` 而不合并。因此，取值因 surface 而异的配置项住在 overlay 中，绝不住在 base 里，从而没有任何配置项会被三层同时 patch。会话身份根本不能经由配置键传递——它迁移到了 `dsh-agent-loop` 的 `CONFIGURED_AGENT_IDENTITIES_KEY`，正如启动器持有身份的记录所述。

TUI 测试位于 `apps/cli/tests/`，Cordis 工具集 e2e 位于 `packages/extensions/tool-cordis/tests/`，受支持的 PTC mode demo 则以 `DSH_TOOLS_MODE=ptc` 运行 `dsh --profile headless`。

## 备选方案

**保留两棵平铺且重复的树。** 拒绝：43 个配置项维护两份正是缺陷本身，而用一个门禁断言二者保持一致只会固化重复，而非消除它。

**把 overlay 嵌套成 include（`ptc` → `tui` → `base`）。** 在对 Loader 实测后拒绝：patch 不会跨越 include 边界，因此外层文件的 patch 只会伴随一条告警被丢弃。三层链条使 `tools` 无法被 patch，而位于一层 include 之后的 base，会让每个个人 patch 都变成静默的空操作。

**把所有配置项的并集放进 base，由各 overlay 禁用自己不需要的部分。** 拒绝：base 将不再意味着「共享」，而每个 surface 都要携带仅为将其关闭而存在的配置项。

**把因 surface 而异的配置项留在 base 中，由 overlay 去 patch。** 仅对必须同时存在于两棵树中的那五个配置项采用，因为 patch 无法创建配置项。它们在 base 中的条目携带插件名与两个 surface 共享的配置，其余部分由各 overlay 声明。

## 影响

指名 `@deepseek-ai/dsh-tui-demo` 或 patch `tui-agent` 配置项的 overlay 或 `--config` 树将不再可解析。overlay 现在要 patch 拥有对应键的那一行：模型路由在 `agent-loop`，人设在 `system-prompt`，呈现设置在 `tui`。

若某个 patch 的 `id` 不匹配任何配置项，它仍为空操作而不报错。这是有意为之：同一份个人 overlay 会跨 surface 共用，而 `insert` 配置项按设计本就不匹配任何目标，因此仅在 `web` 下存在的配置项不能让 TUI 启动失败。

`dsh web` 新增 `--config`，作为一份额外 overlay 传入 `AppCLIEntry`。Web 保留沙箱化 Bash 与文件系统提供方，以及审批、权限预设、目录选择和浏览器权限界面；覆盖层会禁用共享的本地提供方，因为补丁可以禁用条目但不能删除条目。TUI 查询索引使用每个进程独有的临时数据库，因为 SQLite 后端要求单写入者所有权。该索引是每个进程重新构建的可丢弃派生数据；`/resume` 直接列出底层语料，不依赖索引复用。`AppCLIEntry` 在为自身 patch 合并恢复配置项默认值时会同时读取 base 与其 surface overlay，因为 flag 覆盖必须保留同一配置项上 overlay 的其他字段。

## 验证

组合的正确性通过用真实 Loader 启动每棵树并检查已就绪的条目来核对，而不是靠阅读 YAML：两个界面都能完全就绪，且没有未加载项；Web 会以沙箱化 Bash 与文件系统提供方启动 `httpServer`。PTC mode 继续由 ACP overlay 与程序化 TUI 快照覆盖，而不再维护独立交付的 TUI 应用。

全部八个终端快照场景在迁移后逐字节重放一致，14 个用例的 PTY 冒烟测试全部通过，其中两个用例断言个人 overlay 能触达一个 **insert 进来的**配置项——这正是 vendored `plugin-include` 修复所启用的行为（[`vendor/README.md`](../../../../vendor/README.md) 本地修改第 8 条，由 `packages/boot/app-boot/tests/config-reload.spec.ts` 覆盖）。

平铺过程暴露出三处潜伏缺陷，均在此一并修复：TUI 曾在构造时一次性捕获可选的 `sessionQuery` 服务，因此在挂载竞争中胜出时会永久禁用 `/resume`；交付的会话存储根目录曾静默退回项目本地的 `./.sessions`；`--config-replace` 曾在恢复交接中被丢弃。
