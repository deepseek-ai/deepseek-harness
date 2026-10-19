# 远程与 API 规则

[English](remote-and-api.md) | 中文

`packages/api` 层及其对外远程方法的规则。调用模型本身见 [api-gateway.zh.md](../api-gateway.zh.md)。以下每条规则都给出要求、审查者的判定方式、不覆盖的内容、例外与批准人，以及一个正例与一个反例。

## 新的远程能力要有自己的 service

新的远程业务能力就是一个新的 service——独立包或独立对象——`@Remote` 标在它的具体方法上。往既有的大 service 上一个方法一个方法地加，会让同一个对象同时承担 auth、Session、workspace 与事件载体，把逐领域的激活策略与历史分页混在一起，并让之后对任一能力的变更都要动所有这些面。按业务边界切，而不是按调用方数量切：当前只有一个调用方的能力也建独立 service；端点迁移是搬到新归属，而不是并进它正要离开的那个对象。

- 判定：新远程方法最终落在哪个对象上。把属于新业务线的方法加到已经承担另一条业务线的 service 上即为违反；修法是为新能力建一个以它命名的 service，并把 `@Remote` 标在它的具体方法上。迁移按同一标准判定——被搬走的方法出现在新归属上（如 `packages/subagent/subagent` 的 `SubagentRuntime`），而不是留在它离开的那个对象上。
- 不覆盖：所有方法都服务同一条业务边界的 service 保持完整，该能力新增的私有辅助方法就属于它。需要独立协议的数据也不会变成新 service 上的 Remote 方法；会话事件流、分页、增量 reduce、projection 与实体子流保持各自独立的注册模型（[gateway 边界](../api-gateway.zh.md#boundaries)）。
- 例外：无。只有一个调用方不构成合并的理由；业务边界本身有争议时，由对应领域专家作为架构问题先行裁定，再落地。
- 修法：为新能力建独立 service 对象或包，把 `@Remote` 标在它的具体方法上，调用方经 `ctx.remote.<namespace>` 使用。

subagent 能力拥有自己的 service，它的每个远程方法都是该 service 的具体方法：

```ts ignore-check
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

interface SubagentList { ids: string[] }
interface PromptRequest { text: string }
interface PromptResult { accepted: boolean }

class SubagentRuntime extends TypertRemoteService {
  @Remote list(): SubagentList { return { ids: [] } }
  @Remote prompt(request: PromptRequest): PromptResult {
    return { accepted: request.text !== '' }
  }
  @Remote interruptByParent(id: string): void { }
}
```

反例把同一能力加到已经在承担其他领域的对象上：

```text
class ApiProxy {
  @Remote goalList(): GoalList            // goal domain
  @Remote subagentPrompt(request): ...    // subagent domain
}
```

于是一个对象同时为两个领域作答：任一能力的激活策略、分页或事件处理变更都落在同一处，两个能力也无法各自搬迁。

## `@Remote` 标在能力方法上

`@Remote` 有五项纪律，审查者分别核对：标注执行能力的具体方法；面向 Client 的类型经生成器来自既有定义，而不是手写第二份；载荷只承载 JSON，远程方法不做输出侧 decode；既有的方法与字段名只增不改；方法指明其访问的全部资源，且只从 invocation 读取调用方。每项纪律消除一类不同的缺陷——壳方法藏起真正暴露的是哪个操作，手写的第二份类型会与生成结果漂移，输出侧 decode 在 Gateway 已有的 codec 之外再造一条结果路径，改名让所有调用方在同一次变更里一起断掉，遗漏资源、未过滤的聚合结果或按参数判定调用方则让非 owner 访问没有 binding 授予它的内容。

- **标能力方法。** 标注落在执行该操作的具体方法上（`list`、`prompt`、`interruptByParent`），绝不落在转发给真正实现的壳方法上。判定看被标注方法的函数体：函数体只做转发，标注就标错了方法。
- **类型靠推断。** 面向 Client 的类型从生成结果取别名——`type SessionRemote = TypertClientRemote['session']`——而不是重写一份。判定看是否出现字段与生成的 Client 类型重复的手写声明；生成映射及其声明合并的正家是 [typert.zh.md](../subsystems/typert.zh.md)。
- **线上载荷只承载 JSON、不做输出侧 decode。** Remote 方法的**线上载荷**是 JSON，二进制在字段级表达。Host 签名保留 Gateway 已支持的形式——经解析变成 Host 对象的 lookup 参数、末尾的 `AbortSignal`、以 `@Remote({ mode: 'stream' })` 声明的流式返回；`@Remote` 不做输出侧 decode，结果由生成的 codec 与 Gateway 校验。判定看带该标注的方法上是否出现 decode、流重组或整体非 JSON 值；可跨越 Remote 方法的内容正家是 [编程模型](../api-gateway.zh.md#programming-model)。
- **存量名只增不改。** 迁移不改 Client 已在调用的远程方法名或字段名；新语义新增条目，改名是独立的一刀、单独评审。判定看 diff 是否改名或删除了已经经 `ctx.remote.<namespace>` 暴露的名字。
- **调用方身份与访问。** 每个 Remote 方法都受访问控制：`@Remote({ resources })` / `@RemoteScope(key, { resources })` 的读取函数与自动解析必须指明方法访问的全部资源，因为访问控制从不检查它们遗漏的资源；返回多个资源的方法对每一项经 `this.ctx.remoteAccess.allows(resource)` 过滤。调用方只从 `this.ctx.invocation.peer.principal` 读取，绝不从参数读取；在 Remote 方法内构造用户消息 source 时经 `principalOf(this.ctx.invocation)` 记录调用方，并向下传递已构造的 source，而不是把 principal 当函数参数传递。每条调用路径都显式给出 Peer。判定看方法解析出的资源是否遗漏其访问的资源、聚合结果是否未过滤、principal 是否从 wire 数据读取或经辅助函数参数逐层传递、Remote 方法内构造的用户消息 source 是否未经 `principalOf`；设计的正家是 [Peer 身份属性 Agent Note](../../.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md)。
- **不覆盖。** 不带该标注的方法仍是有进程内调用者的普通 service 方法；这五项纪律约束的是什么成为 Remote 方法，而不是 service 可以实现什么。
- **例外。** 确需改名或新增 decode 路径，须先说明收益与对既有调用方的影响，并取得对应领域专家的确认；作者不得自行批准。

生成的映射是面向 Client 类型的唯一来源，标注落在具体方法上，载荷保持 JSON：

```ts ignore-check
import { Remote, TypertRemoteService, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

// Client-facing types come from the generated map, never from a second hand-written set.
type SessionRemote = TypertClientRemote['session']

class SessionController extends TypertRemoteService {
  @Remote('search')
  search(query: string): SessionSearchValue {
    return this.runSearch(query)
  }
}
```

手写第二份类型、改名已发布的名字、在远程方法上做输出侧 decode，各自破坏一项纪律：

```text
type SessionRemote = { list(): ...; rename(id: string): ... }   // hand-written copy
@Remote('renameSession') rename(...)                            // shipped name changed
@Remote decode(payload: Uint8Array): Result                     // output-side decode
```

手写的副本会与生成类型漂移而不会让构建失败，改名一次性打断所有既有 Client 调用，decode 则用第二条未经校验的结果路径替换生成的 codec。

## `packages/api` 只承载通用编排

`packages/api` 下的包——各 controller、`gateway`、`remotes`——承载传输、调用形态、Session 生命周期等通用编排。业务分支绝不在其中聚合：依赖具体业务状态的判断、与单个功能绑定的处理、逐功能的过滤，都归独立包或模块，并作为投影数据或经注册面接入本层。判据是逻辑的归属，而不是文件的位置，所以只对一个功能成立的业务分支即使放在通用文件里也是缺陷。

- 判定：分支的条件从哪里读取。在 `packages/api` 内对功能状态做 `if` 或 `switch`、写逐功能的过滤、或以某个功能命名的辅助方法，即为缺陷；同样的判断由归属包做出、在本层作为投影数据或注册条目消费，则不是。包普查是影响面的证据：`packages/api` 共 9 个包——`account-controller`、`gateway`、`job-controller`、`remotes`、`session-controller`、`settings-controller`、`terminal-controller`、`workspace-controller`、`workspace-files`——其中 `session-controller` 以 34 个 `src` 文件为最多（terminal-controller 12、gateway 11、workspace-controller 10、workspace-files 8、job-controller 8、remotes 4、settings-controller 3、account-controller 2）。
- 不覆盖：通用 Session 生命周期、传输与存储抽象留下——`gateway` 的分发、`remotes` 的选择、共享的会话列表与目录读取属于基础设施，不是业务逻辑。[业务所有权](../api-gateway.zh.md#business-ownership)从 Gateway 一侧给出同一个划分。
- 例外：默认无例外。在此新增业务分支须走独立包评审，评审要回答这些逻辑为什么不能住在拥有该功能的包里。
- 修法：把判断移进归属包，将其结果作为投影数据发布、或注册到本层本就注入的注册表上，这里只留下读取它的编排。

归属包做出判断并注册自己的单元，controller 只读取投影值：

```ts ignore-check
// packages/workspace/<feature>/src/index.ts: the rule lives with the feature it serves.
export const durablePageProjectionDefinition = {
  key: 'durablePage',
  stateSchema: durablePageState,
  init: () => ({ durable: false }),
  apply: applyDurablePage,
  stateVersion: 1,
}
await ctx.sessionProjections.register(durablePageProjectionDefinition)

// packages/api/session-controller: generic orchestration reads the projected value.
const durablePage = await ctx.sessionProjections.register(durablePageProjectionDefinition)
const { durable } = durablePage.stateOf(session)
```

反例把这条规则的决定放进共享层：

```text
// packages/api/session-controller: a feature branch inside the shared layer
if (session.page.transport === 'durable') { /* durable-transport handling */ }
```

这条规则于是有了第二个家，之后每次变更都要同时找到两处，而共享层继续承载某一个功能的语义。
