# User actions and agent tools

Expose the plugin UI's operations on application data and configuration to the agent. Pure view interactions, such as switching tabs or expanding details, do not need tools. Confirm the Host entry points and tools you use with `cordis_inspect_query` before relying on them.

## One operation, two callers

1. Implement the operation once as a Host service method. It returns the result or an explicit status, and a failure carries its reason.
2. The UI action calls it through a Client-callable Host entry point found with inspection, such as a session command that `ctx.remote.commands.execute()` runs, and shows the returned failure.
3. Expose the operation through an agent tool with matching parameters and meaning. Related operations may share a tool with an `action` parameter. The tool calls the same method and returns its result as the tool result.

An action that grants or confirms authority, such as approving a tool call, answering a question the agent asked, or loosening a policy, stays user-only. Do not maintain separate operation logic in the UI and tool paths.

## Verification

For operations available to both callers, perform the operation through the tool alone and compare its state changes, return values, and failures with the UI action. For user-only actions, verify that the agent cannot execute or authorize them.
