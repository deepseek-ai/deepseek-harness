# Remote and API rules

English | [中文](remote-and-api.zh.md)

Rules for the `packages/api` layer and the remote methods it exposes. [api-gateway.md](../api-gateway.md) describes the call model itself. Each section below states the requirement, how a reviewer judges it, what it does not cover, which exception applies and who approves it, and a correct and a wrong example.

## A new remote capability gets its own service

A new remote business capability is a new service — its own package or its own object — and `@Remote` marks that service's concrete methods. Growing an existing large service one method at a time leaves one object answering for auth, Session, workspace, and event carriage at once, mixes per-domain activation policy with history pagination, and makes every later change to one capability touch all of them. Split by business boundary, not by caller count: a capability with a single caller today still gets its own service, and an endpoint that changes owners moves to its new owner instead of joining the object it is leaving.

- Judged by: which object holds the new remote method. A method for a new business line added to a service that already owns another line is the defect; the fix is a service named for the new capability, with `@Remote` on its concrete methods. A migration is judged the same way — the moved method appears on its new owner, as `SubagentRuntime` does in `packages/subagent/subagent`, not on the object it left.
- Not covered: a service whose methods all serve one business boundary stays whole, and a new private helper of that capability belongs on it. Data that needs its own protocol does not become a Remote method on the new service either; session event streams, pagination, incremental reduce, projection, and entity substreams keep their separate registration model ([gateway boundaries](../api-gateway.md#boundaries)).
- Exception: none recorded; a single caller is not a reason to merge. Where the business boundary itself is contested, the domain owner settles it as an architecture question before the change lands.
- Fix: create the capability's own service object or package, put `@Remote` on its concrete methods, and let callers reach it through `ctx.remote.<namespace>`.

The subagent capability owns its own service, and every remote method is a concrete method of that service:

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

The wrong version adds the same capability to the object that already carries other domains:

```text
class ApiProxy {
  @Remote goalList(): GoalList            // goal domain
  @Remote subagentPrompt(request): ...    // subagent domain
}
```

One object then answers for both domains, so a change to either capability's activation policy, pagination, or event handling lands in the same place, and neither capability can move without the other.

## `@Remote` marks capability methods

`@Remote` carries five disciplines that a reviewer checks separately: it marks the concrete method that performs a capability; client-facing types come from the existing definitions through the generator instead of a hand-written copy; the payload is JSON and the remote method performs no output-side decode; existing method and field names are additive; and a method names every resource it touches and reads its caller only from the invocation. Each discipline removes a different failure — a wrapper hides which operation is exposed, a second hand-written type set drifts from the generated one, an output-side decode adds a second result path beside the codec the Gateway already runs, a rename breaks every caller in the same change, and an unnamed resource, an unfiltered aggregate, or an argument-supplied caller lets a non-owner reach what no binding grants it.

- **Capability methods.** The annotation goes on the concrete method that performs the operation (`list`, `prompt`, `interruptByParent`), never on a wrapper that forwards to the real implementation. Judged by the decorated method's body: a body that only delegates means the annotation is on the wrong method.
- **Types from inference.** Client-facing types are aliased from what the generator produces — `type SessionRemote = TypertClientRemote['session']` — instead of being written a second time. Judged by a hand-written declaration whose fields repeat a generated Client type; [typert.md](../subsystems/typert.md) owns the generated maps and their declaration merges.
- **JSON on the wire, no output-side decode.** The **wire payload** of a Remote method is JSON, with binary content expressed field-level. The Host signature keeps what the Gateway already supports — lookup arguments resolved to Host objects, a trailing `AbortSignal`, a stream declared with `@Remote({ mode: 'stream' })` — and `@Remote` performs no decode on the way out; the generated codec and the Gateway validate the result. Judged by a decode, a stream reassembly, or a whole non-JSON value in the payload of a method carrying the decorator; [programming model](../api-gateway.md#programming-model) owns what may cross a Remote method.
- **Existing names are additive.** A migration does not rename a remote method or field that a Client already calls; a new semantic gets a new entry, and a rename is its own change with its own review. Judged by a diff that renames or removes a name already exposed through `ctx.remote.<namespace>`.
- **Caller identity and access.** Every Remote method is under access control: the `@Remote({ resources })` / `@RemoteScope(key, { resources })` readers and automatic resolution must name every resource the method touches, because access control never checks a resource they omit, and a method returning several resources filters each item through `this.ctx.remoteAccess.allows(resource)`. The caller is read only from `this.ctx.invocation.peer.principal`, never from arguments; a Remote method that builds a user-message source records it through `principalOf(this.ctx.invocation)` and passes the built source down instead of passing the principal as a function argument. Every call path names its Peer explicitly. Judged by a method whose resolved resources omit one it touches, an unfiltered aggregate, a principal read from wire data or threaded through helper parameters, or a user-message source built in a Remote method without `principalOf`; the [Peer principals Agent Note](../../.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md) owns the design.
- **Not covered.** A method without the decorator stays an ordinary service method with in-process callers; the five disciplines govern what becomes a Remote method, not what a service may implement.
- **Exception.** A rename or a new decode path states its benefit and the impact on existing callers first and needs the domain owner's confirmation; the author never self-approves.

The generated map is the only source for Client-facing types, the decorator sits on the concrete method, and the payload stays JSON:

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

A hand-written second type set, a rename of a shipped name, and an output-side decode each break a different discipline:

```text
type SessionRemote = { list(): ...; rename(id: string): ... }   // hand-written copy
@Remote('renameSession') rename(...)                            // shipped name changed
@Remote decode(payload: Uint8Array): Result                     // output-side decode
```

The hand-written copy drifts from the generated type without failing a build, the rename breaks every existing Client call at once, and the decode replaces the generated codec with a second, unchecked result path.

## `packages/api` carries generic orchestration only

The packages under `packages/api` — the controllers, `gateway`, and `remotes` — carry transport, call shape, Session lifecycle, and other generic orchestration. A business branch never aggregates there: a decision that depends on concrete business state, handling bound to one feature, or a per-feature filter belongs in its own package or module and reaches this layer as projected data or through a registration surface. The criterion is where the logic belongs, not where the file sits, so a branch that only makes sense for one feature is a defect even when the file holding it is generic.

- Judged by: where the branch reads its condition. An `if` or `switch` over feature state, a per-feature filter, or a helper named for one feature inside `packages/api` is the defect; the same decision taken in the owning package and consumed here as projected data or a registered entry is not. The package census shows the impact: `packages/api` holds nine packages — `account-controller`, `gateway`, `job-controller`, `remotes`, `session-controller`, `settings-controller`, `terminal-controller`, `workspace-controller`, `workspace-files` — and `session-controller` is the largest at 34 `src` files (terminal-controller 12, gateway 11, workspace-controller 10, workspace-files 8, job-controller 8, remotes 4, settings-controller 3, account-controller 2).
- Not covered: generic Session lifecycle, transport, and storage abstraction stay — `gateway` dispatch, `remotes` selection, and shared session-list and catalog reads are infrastructure, not business logic. [Business ownership](../api-gateway.md#business-ownership) states the same split from the Gateway side.
- Exception: none by default. Adding a business branch here needs an independent-package review, and that review answers why the logic cannot live in the package that owns the feature.
- Fix: move the decision into the owning package, publish its result as projected data or register it on a registry this layer already injects, and leave only the orchestration that reads it.

The owning package decides and registers its unit, and the controller only reads the projected value:

```ts ignore-check
// packages/workspace/<feature>/src/index.ts: the rule lives with the feature it serves.
ctx.sessionProjections.register({
  key: 'durablePage',
  stateSchema: durablePageState,
  init: () => ({ durable: false }),
  apply: applyDurablePage,
  stateVersion: 1,
})

// packages/api/session-controller: generic orchestration reads the projected value.
const { durable } = ctx.sessionProjections.stateOf(session, 'durablePage')
```

The wrong version decides the rule inside the shared layer:

```text
// packages/api/session-controller: a feature branch inside the shared layer
if (session.page.transport === 'durable') { /* durable-transport handling */ }
```

The rule then has a second home, and every later change to it has to find both while the shared layer keeps carrying one feature's semantics.
