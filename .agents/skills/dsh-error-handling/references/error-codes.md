# Error class and code guide

Use this guide when adding or reviewing an error class, an error code, or a failure path whose `name` and `code` reach a durable record such as `tool/result` `error`.

## Where `name` and `code` go

`HarnessError` carries `name` and `code` beside `message` and `cause`. The tool registry copies `name` and `code` of a thrown `HarnessError` into `ToolErrorInfo`, which the Session log persists as `tool/result` `error`; the model sees only the rendered `message`. Retry policy, UI cards, replay, and failure analytics route on `name` and `code`, so both are compatibility promises from the first release that records them.

| Field | Audience | Content |
|---|---|---|
| `name` | Code and analytics | The error class; groups every failure one domain owns |
| `code` | Code and analytics | The failure class a consumer acts on |
| `message` | Model and logs | English, actionable, names the operation and the safe next step |
| `reason` (`ToolErrorInfo`) | User-facing projections | Optional raw detail kept out of model-facing content; only a policy decision that supplies `info` can set it |
| `cause` | Debugging | The original foreign or lower-level error |

## Choose the class

1. Reuse the owning domain's existing class when the failure belongs to that domain: `FsError` for filesystem targets, `SearchError` for `glob`/`grep`, `LspError`, `WebError`, `SubagentError`, `TeamError`, `GoalError`, `WorkflowError`, `UserQuestionError`, `SessionQueryError`, the `Sandbox*Error` classes, and `CodeRunFailedError`.
2. Use `ToolArgsError` (`INVALID_ARGS`) for argument constraints the parameter schema cannot express, such as an empty string, a range, or a cross-field rule.
3. Declare a new class only for a new owning domain. Prefer one class with a code union over one class per failure; a separate subclass is justified when consumers must catch it by type or it carries its own structured fields, such as `ToolArgsError.violations`, and it then extends the domain class when one exists so the domain still matches with `instanceof`.
4. Never declare a coded class that extends bare `Error`. An existing one is migrated by changing its base class and keeping every `name` and `code`.

## Name the class

- `name` is the PascalCase class name ending in `Error`, such as `JobError` or `SandboxEscalationError`.
- Assign `this.name` a string literal in the constructor. `HarnessError` defaults `name` to `new.target.name`, but a bundler may rename a colliding class binding, and a renamed class would change persisted data.
- Do not reuse another domain's class name, and do not encode a code in the name.
- Cancellation is the one exception: a tool throws a `HarnessError` whose `name` is `AbortError` and whose code is the `dsh-tools` `TOOL_ABORTED` constant (`ABORTED`), so tool-thrown and registry-generated cancellations share one `name` and `code`.

## Format the code

- A code matches `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$`: ASCII `UPPER_SNAKE_CASE`.
- New codes start with the domain prefix shared by the class, followed by the condition: `<DOMAIN>_<CONDITION>`, such as `FS_NOT_FOUND`, `TEAM_TASK_STALE_REVISION`, or `MCP_CONNECTION_CLOSED`. A subject between the prefix and the condition is allowed when the domain has several subjects, as in `TEAM_TASK_*` and `TEAM_MEMBER_*`.
- Existing unprefixed codes, such as `SubagentError`'s `NOT_RESUMABLE` or `LlmError`'s `TIMEOUT`, stay as they are; renaming them is a breaking change. New codes in those classes follow the class's existing style.
- A code is a literal. Never build one from a template string, a status number, a path, an id, a tool name, or a foreign code.

## Name the condition

Pick the condition from what the consumer does next, not from where the failure happened. Reuse these standard conditions before inventing one:

| Condition | Meaning | Typical consumer action |
|---|---|---|
| `INVALID_<FIELD>` or `INVALID_ARGUMENT` | The caller's input violates a documented constraint | The model corrects the input |
| `NOT_FOUND` | The named target does not exist | The model picks another target |
| `ALREADY_EXISTS` | Creation conflicts with an existing target | The model reuses or renames |
| `PERMISSION_DENIED` | The host or the platform refused access | Report; do not retry unchanged |
| `SANDBOX_DENIED` | Sandbox policy refused the operation | Request escalation or stop |
| `REJECTED` | A person or a review policy declined the request | Stop and explain; do not work around it |
| `CANCELLED` / `ABORTED` | The user or the caller cancelled the operation | Stop without retrying |
| `TIMEOUT` | A deadline elapsed and the outcome is known to be incomplete | Retry only when the operation is idempotent |
| `UNAVAILABLE` | A required service, provider, or backend is not present or not reachable | Report the missing composition or retry later |
| `UNSUPPORTED_<FEATURE>` | The request is valid but this implementation cannot serve it | Choose another option |
| `LIMIT_REACHED` / `TOO_LARGE` | A configured count, size, or rate bound was hit | Reduce the request |
| `STALE_<STATE>` | The caller acted on an outdated version | Re-read and retry |
| `CONFLICT` | Concurrent or duplicate work holds the target | Wait or pick another target |
| `CORRUPT` | Persisted state failed validation | Report; do not trust the state |
| `<OPERATION>_FAILED` | A dependency failed in a way the owner cannot classify further | Report with the cause |

Use `<OPERATION>_FAILED` only after the specific conditions above do not fit. One code covers one consumer action: split a code when consumers must act differently, and merge candidates that every consumer handles alike.

## Declare the codes

A domain that owns all of its codes declares a closed list beside the class and types the constructor with it, as in this example for a job domain:

```ts
/** Every machine-routable job failure. */
export const JOB_ERROR_CODES = [
  'JOB_NOT_FOUND',
  'JOB_FOREIGN_SESSION',
  'JOB_LIMIT_REACHED',
] as const

/** One job failure code. */
export type JobErrorCode = typeof JOB_ERROR_CODES[number]

/** Typed job failure; `code` is one of {@link JOB_ERROR_CODES}. */
export class JobError extends HarnessError {
  override readonly code: JobErrorCode

  constructor(message: string, code: JobErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'JobError'
    this.code = code
  }
}
```

A Service Definition whose providers may add codes, such as `WebError` or `LlmError`, keeps `code: string`, documents the shared codes with exported constants, and requires consumers to tolerate unknown codes. Document each code in the class JSDoc or the owning subsystem page with its meaning and the consumer action.

## Convert foreign failures

Convert at the package that owns the dependency, keep the original as `cause`, and put any foreign numeric or vendor code in `message`, never in `code`.

| Foreign failure | Converted error |
|---|---|
| `ENOENT`, `ENOTDIR` | `FsError` `FS_NOT_FOUND` |
| `EACCES`, `EPERM` | `FsError` `FS_PERMISSION_DENIED` |
| `EISDIR` where a file is required | `FsError` `FS_NOT_REGULAR_FILE` |
| Other filesystem errno | `FsError` `FS_IO_ERROR` |
| Process spawn `ENOENT` | The spawning domain's `*_NOT_FOUND`, such as a missing executable |
| JSON-RPC, HTTP, or SDK status | The domain's condition for that status, with the status in `message` |
| Native or Win32 API failure | The calling domain's `<OPERATION>_FAILED`, with the API name and code in `message` |
| Worker or process boundary | Transport `name` and `code`, then reconstruct the same class |

When an error passes through several layers, the lowest layer that understands the failure classifies it and the layers above preserve it. Wrap a `HarnessError` only to add context, and keep its `name` and `code` on the wrapper.

## Change existing codes

Adding a code or a class is compatible. Renaming, splitting, merging, or reclassifying an existing `name` or `code` changes persisted data and analytics: record it in an [upgrade guide](../../dsh-create-upgrade-guide/SKILL.md) and list the old and new values. Do not reuse a retired code for a different meaning.

## Checklist

- [ ] Every expected failure reachable from the changed path throws a `HarnessError` subclass.
- [ ] The class extends `HarnessError` or the domain class and assigns a literal `name`.
- [ ] Each code is a literal from the declared list and names a consumer action.
- [ ] Foreign errors are converted at their owner with `cause`, and no layer drops `name` or `code`.
- [ ] `message` is actionable for the model and carries no sensitive internal detail.
- [ ] Tests assert `name` and `code` for each expected failure.
- [ ] A changed existing `name` or `code` has an upgrade guide.
