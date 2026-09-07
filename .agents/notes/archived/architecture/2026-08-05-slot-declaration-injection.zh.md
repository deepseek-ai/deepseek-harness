# Agent Note: slot 声明注入与重载生命周期

Status: implemented
Archived: 2026-09-04

[English](2026-08-05-slot-declaration-injection.md) | 中文

## 问题

客户端插件可能在声明某个 slot 的插件之前或之后向该 slot 贡献内容。Cordis 服务注入无法表达这种依赖：服务只能作为间接的顺序信号；客户端 manifest（元数据清单）的依赖项不会规定激活顺序；即使所有相关服务始终挂载，slot 仍可能消失后重新出现。因此，立即注册会与尚未声明的 slot 形成竞态，而等待无关服务则会耦合本可独立重载的功能。

slot 级热替换还要求两个相互独立的所有者。移除声明方插件必须移除其子 slot 下的所有贡献；移除贡献方插件只能移除该插件自己的条目。即使消失与重新出现合并在同一次通知中，同一个 key 的替换声明也属于新的生命周期。

## 决策

`SlotRegistry.inject(name, callback)` 以已声明的 slot 本身作为依赖。完整的 `SlotMap` key 会经过静态检查；系统不引入命名空间构建器、合成的 Cordis 服务或 slot 专属 `Context`。声明存在时回调同步执行，否则等待；回调返回一个同步 disposer，或由多个 disposer 构成的同步 iterable。iterable effect 的安装具有事务性：后续 setup 失败时，系统会按逆序 dispose（资源释放）之前 yield 的所有 effect。

该账本记录独立于 slot 普通条目版本的 declaration epoch（声明代次）。每当子声明创建或折叠时，epoch 都会变化。注入会记住活跃 epoch；该 epoch 结束时，注入会 dispose 其回调 effect；即使最终观测到的状态始终为已声明，也会为替换声明重新执行回调。普通贡献变更不会重启注入。

声明方与贡献方各自保留其自然所有权。注入控制器和每项贡献都运行在贡献方插件调用时的 `Context` 上，因此 dispose 该插件会同时移除其等待与活跃条目。slot 账本现有的子项折叠级联会在声明方消失时移除条目；随后，注入会运行其 disposer 以释放服务层资源，并继续等待后续声明。系统既不会将声明方插件的 `Context` 保留为 capability 来源，也不会向贡献方公开它。

动态重载代码使用普通 Cordis 插件 fiber 作为替换单元：通过 `ctx.plugin()` 激活新模块；挂载替换模块之前，先 dispose 并等待旧 fiber；该 fiber 的 `slots.inject` 与 `slots.register` effect 会随之退出。renderer 订阅会观察到账本移除并卸载组件；无需建立 slot 自有的 fiber 树。

## 失败与生命周期约定

如果注入创建时声明已经存在，回调 setup 失败会同步上报。延迟声明出现后发生的回调失败，会先取消订阅并回滚已收集的 effect，再在 slot 通知刷新之外上报，避免一个注册方使其他 listener 得不到执行机会。直接调用 `slots.register()` 向未声明 slot 注册仍会抛出异常：注入是显式机制，不会削弱加载时验证。

对注入执行 dispose 具有幂等性。它会先取消订阅，再释放活跃的回调 effect，避免拆卸触发的账本通知复活该项贡献。声明绑定的 teardown 与账本边界同步，因此会在同一 tick 的任何后续注册之前释放服务层资源。随插件一同 dispose 的待命注入无法在之后激活。

## 备选方案

**将 `ConversationController` 或其他服务用作顺序屏障。** 服务存在并不能标识相应声明，也不会跟随声明的重载生命周期；只负责呈现的贡献方还会因此产生虚假的包依赖。

**将每项声明桥接为 `slot:<name>` Cordis 服务。** 这会污染服务命名空间，使拼错的动态 key 变成静默的服务等待，并把账本状态伪装成业务能力。原生 slot 注入无需改变 Cordis 拓扑，即可提供同样的等待能力。

**为每个 slot 创建 Cordis 上下文或 fiber。** 贡献方需要的是自身插件生命周期与声明生命周期的交集，而不是声明方的能力。slot 所有的上下文会引入 capability 继承和双父级拆卸问题，却无法改善账本所有权。

**让 `register()` 隐式等待。** 对未声明目标立即失败是一项有价值的配置检查。显式注入能够区分有意独立排序的贡献与错误组合。

**只根据 `spec(name) !== undefined` 判断替换。** 折叠与重新声明可以合并成一个最终状态始终存在的通知，而旧贡献此时已经被移除。declaration epoch 保留了这条生命周期边界。

## 影响

slot 依赖可以在注册点审计，并且无需特定于包的顺序约定即可跟随声明替换。动态插件 dispose 会通过既有 Cordis effect 移除已渲染条目，而声明替换则为后续 slot 级 HMR（热模块替换）提供稳定钩子。

运行时为每个被访问的 slot 多维护一个单调 epoch，且注入回调必须返回清理操作。多注册回调使用 iterable effect，使 setup 与 teardown 保持原子性。扁平的点分 key 账本和唯一的 `register()` 组合权威保持不变。
