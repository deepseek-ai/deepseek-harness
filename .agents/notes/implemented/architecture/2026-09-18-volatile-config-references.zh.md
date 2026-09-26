# Agent Note: Volatile 配置引用

Status: implemented

[English](2026-09-18-volatile-config-references.md) | 中文

## Problem

为了改变一个值而替换整个插件，也会销毁插件的服务和副作用。独立的 settings 订阅要求每个消费者额外实现一套动态配置来源。

## Decision

Schemastery 使用 `.volatile()` 声明动态字段，保留节点类型和表单元数据，解析结果是具有不可变快照的稳定引用。共享协议位于 Cosmokit。通用比较将两个 volatile 引用视为相等。Loader 根据 schema 声明的 volatile 路径计算原始配置差异，并保留原始配置供后续激活使用。原始 diff 未报告普通字段变化但原始配置有差异时，Loader 经 fiber 的 `internal/config` 钩子解析并校验候选配置，比较普通字段的有效值，在这些值仍匹配时提交引用并通知所属实例；所有更新路径，包括 profile 重载、HMR 的 Include 刷新和直接调用 `entry.update()`，都经 `Entry.update` 到达这一步。Fiber 不承担这项更新策略，文件监视由 HMR 提供。

仅 volatile 变化保留实例。普通字段变化沿用现有重新挂载生命周期，不更新旧引用。实例局部的 `loader/volatile-update` 事件在完整候选配置通过校验且所有引用提交后报告路径。事件使用普通 `emit`；监听器完成不是配置提交条件。可以保存引用，而值只能在单次操作中保存。缺省可选值仍具有可读取的引用。

Config schema 负责提供基于 schema 的 settings 表单需要的字段类型、默认值、角色和动态更新声明。现有 settings 消费者保持不变；自动表单生成及其迁移是独立工作。[配置指南](../../../../docs/cordis-tutorial/05-config.zh.md)负责插件作者的使用说明。

## Alternatives considered

**每次配置变化都重启。** 当只有操作时读取的参数变化时，这会释放仍然有效的资源。

**增加另一套 settings 专用动态值 API。** 这会重复运行时更新语义，并使插件为了读取普通配置而依赖 settings。

**仅在挂载时包装值。** 直接解析 schema 与插件配置将返回不同种类的值，需要独立的消费者类型。

## Consequences

Schema 拒绝动态容器内部的独立 volatile 引用；整个对象和数组可以作为一个 volatile 值。不可变快照接受普通数据。配置简化解包引用，共享 symbol 支持 ESM/CJS 副本互操作。Group/Include 保留分发，目标插件的仅 volatile 更新不进入 `internal/update`。直接调用 `fiber.update()` 保留原语义，包括自定义处理、保存及 `noSave`。动态 volatile 更新由 Loader 自己提交，不需要额外插件。

Schema 元数据使比较独立于解析：diff 不执行表达式、校验器或配置钩子。对象节点的缺省值或 null 按声明的默认值比较，即使没有 volatile 后代字段；等价的对象默认值不触发重新挂载。普通表达式即使求值结果相等，修改时仍按原始值比较。Loader 比较解析后的普通值，其中 URL 按规范化地址比较。普通表达式产生不同值时，Loader 改为按普通流程重新挂载而不提交；严格比较对 URL、Date、RegExp 之外的类实例按身份比较，因此每次解析都产生新实例的普通 transform 字段总是走重新挂载。通知阶段监听器抛错只记录日志，不使更新失败。Loader 在提交前校验 volatile 候选；非法编辑保留在原始配置中，但在后续激活之前不改变运行中的引用。

Schema 和生命周期回归测试覆盖直接更新、无效候选、实例隔离、依赖替换、真实文件监视及保存后重新加载。HMR 模块测试覆盖动态配置更新后的代码替换。这些测试不代表 settings 迁移或自动表单渲染已经完成。
