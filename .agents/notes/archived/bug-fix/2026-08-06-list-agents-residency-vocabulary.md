# Agent Note: `list_agents` uses `ready` for resumable children

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-list-agents-residency-vocabulary.zh.md)

## Problem

`list_agents` projected a continuable child's process residency as `running | idle | complete`. `complete` reads as a terminal unit of work with a result somewhere, but the underlying fact says only that no Activation is resident: the conversation is intact, `send_message` can continue it, and nothing about the child's outcome is being claimed. A model that reads `complete` reasonably looks for a result to collect or sends replacement work to a conversation it believes has ended.

The word is especially misleading alongside [manager-owned settlement delivery](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.md). Completion reaches the parent as a notice; listing exists to recall durable conversations, not to poll for that notice.

## Decision

The model-facing projection reports `running | idle | ready`:

- **`running`** means the resident Agent has an active driver.
- **`idle`** means the Agent is resident between turns and may be waiting on agents it started.
- **`ready`** means only the durable conversation remains. `send_message` starts the next turn on the same conversation; the status is resumable rather than terminal and does not mean a result is waiting to be collected.

The tool description states those distinctions and directs the model away from polling: it says the parent is told when a child finishes and that listing is for recalling which children it started. `send_message` remains the authoritative delivery check because either snapshot may race another process or a later message.

The service layer is unchanged. `SubagentListEntry.activity` retains `'running' | 'inactive'`, which accurately describes corpus residency for consumers such as a UI. The model-facing adapter maps `inactive` to `ready` because that word communicates the action available to the model without inventing an outcome.

## Alternatives considered

**Keep `complete` and qualify it in the description.** A description saying that `complete` does not mean complete fights the rendered status on every read. The line the model scans must carry the correct distinction itself.

**Use `active | dormant`.** This removes the useful distinction between a resident Agent that is between turns and a storage-only conversation, and makes the storage-only state sound unavailable. `ready` states the useful fact: the same conversation accepts another turn.

**Drop the status entirely.** Residency remains useful when a parent decides whether to send more work. Removing it trades one misleading status for no signal.

**Rename the service activity values.** `running | inactive` is correct at the service layer and has non-model consumers. Renaming it would churn a general contract to fix one adapter's presentation; the [durable catalog note](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.md) continues to own that service vocabulary.

## Consequences

- The rendered line uses `<id> [running] — <label>`, `<id> [idle] — <label>`, or `<id> [ready] — <label>`.
- The output schema's `status` enum changes with the rendered contract. The generated tool catalog picks up the new description; it renders each tool's `parameters` only and never carried the output schema.
- Unit coverage pins all three mappings and the description clauses that direct the model to the settlement notice instead of polling this tool.
- The assembled ACP `subagent-list-agents` scenario renders `ready` for a settled, resumable child.
