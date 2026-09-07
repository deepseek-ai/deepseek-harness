# Agent Note: 用户设置 seam（`ctx.settings`）与文件提供方

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-user-settings-seam.md) | 中文

> 范围：`packages/settings/` 能力族——Service Definition、文件提供方，以及用户设置与 `cordis.yml` 的组合边界。[web config-tree note](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md) 曾把「profile 写路径」记为延后项；本 seam 就是该写路径的归属。消费方迁移（主题、语言、默认模型路由）与 web `settings.*` RPC 面是后续工作，不在本 note 已交付范围内。

## 问题

用户可编辑配置没有归属：`dsh web` 经静态白名单读 cwd 锚定的 profile json 且无写路径，TUI 读 `$DSH_HOME/config.yaml` 裸 loader patch，两者都在启动时冻结。个人设置页（web GUI）需要一个跨 surface 的用户层，带 schema 校验、写路径与热传导——同类产品（Codex、Claude Code、Kimi、OpenCode、Pi）也全部收敛于「用户偏好与扩展组合分离」。Loader 的 reactive 配置更新承载不了这件事：`fiber.update` 原地替换 entry config，构造期读过配置的插件毫无感知，也没有任何回调通知它。

## 决策

**两个面，一条判定。** `cordis.yml`（+ Include patches）仍是组合面：有哪些插件、接线、部署配置，归 orchestrator 所有并随产品升级。settings namespace 只承载用户可编辑子集；判定是「个人配置页应该能改它吗？」值可同时存在于两个面而不歧义，因为分层就是约定：schema 默认值，然后注册方的组合 `base`（其 entry 配置子集），最后用户文档分节。

**镜像 `session-persistence/` 的三包边界。** `dsh-settings` 拥有抽象 `SettingsProvider` 服务：namespace 注册表、分层解析、schema 校验、按 namespace 深相等变更检测，以及 `settings/updated` 提交事件。提供方只实现 `writable`/`load()`/`persist(ns, section)`，并通过受保护的 `publish(doc)` 推入外部观察到的文档——因此热更新语义对所有提供方一致，网络配置中心后端（nacos 类，可能只读）只是一个平级包的距离。`dsh-settings-file` 是文件提供方：由 `resolveSpec` 定位的 YAML/JSON（默认路径显式设为 `<DSH_HOME>/settings.yaml`）、chokidar 监听、在跨进程写锁下以 `0600` tmp+rename 原子提交的读改写持久化、对被写 namespace 的叶子级 diff 修补（未触碰节点的注释得以保留）、按内容相等抑制自写（[write-path integrity note](2026-07-30-settings-write-path-integrity.zh.md)）。

**注册是调用方 fiber 上的 effect。** `register()` 经服务代理调用，`this.ctx` 即注册方上下文，注册挂在 `ctx.effect` 上：对注册方执行 dispose（资源释放）时，即移除 namespace 及其观察者（经 HMR（热模块替换）资源释放测试证明），而用户的分节继续留在存储中等待下一任 owner。

**静止时响亮报错，运行中保留最后可用值。**启动期与注册期校验直接抛错（非法存量分节使正在注册的插件失败；存在但不可解析的文档使提供方加载失败）。运行中坏的外部编辑只告警并按 namespace 保留最后可用状态——热重载绝不拖垮进程。该不对称镜像 `Include.refresh()` 与 Kimi 的安全运行时重载。

**消费方天然可选。**消费方在 `ctx.inject(['settings'], …)` 内注册；不挂提供方时仍只按 entry 配置解析，因此所有既有组合、demo、快照原样工作，迁移按插件渐进。

## 备选方案

- **以 Include 写回为用户层**（cordis-webui 式的按插件配置页写 loader entry 文件）：写回目标是按组合的文件，会把用户偏好绑死在某个 `cordis.yml` 上；用户层必须在模板升级中存活，并以同一文档服务 TUI 与 web。
- **以 Loader reactive `fiber.update` 为传导通道**：构造期读取毫无感知；seam 的显式 `watch()` 把热更新变成消费方约定而非框架魔法。
- **领域化的 settings 服务**（按产品域的 getter）：因耦合而否决；服务只做存储、校验、发布——领域含义留给拥有 schema 的注册方。
- **现在就做多层优先级**（Codex/Claude Code 式 system/managed/project 层级）：延后到真实第二层出现；resolve 步骤是分层未来唯一的扩展点。
- **现在就上跨进程锁**（Pi 的 proper-lockfile）：最初以「原子替换加 watcher 收敛，真实冲突出现再说」为由延后——但收敛会丢失未观察到的同级 namespace，因此该延后已被 [write-path integrity note](2026-07-30-settings-write-path-integrity.zh.md) 的手写写锁取代。

## 后果

按依赖顺序延后：web `settings.raw`/`settings.describe`/`settings.update` RPC 面（暴露前必须对 `role('secret')` 字段脱敏）；首批消费者迁移（`ui-theme`、语言、api-gateway 默认路由）并退役 `PROFILE_MAPPINGS` 与 profile json；面向密钥的 `${env:VAR}` 值间接引用；provider 侧分层。keyless 快照义务随第一个对模型或产品用户可见的消费方落地，而非本基础设施步骤。
