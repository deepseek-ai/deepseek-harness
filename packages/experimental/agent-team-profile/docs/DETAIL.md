Ask the agent you are talking to, the lead, to split a job. It creates subagents, puts the work on a shared task board, waits for their results, and reports back.

## How to use

- Ask in plain words, for example: "Use Agent Teams to split this task between two teammates, wait, and summarize."
- Click **Task board** next to the conversation title to see **Shared tasks**. Each task shows its status, **Owner**, **Write scopes**, and the tasks it is **Blocked by**.
- Use the conversation's subagent links to open a teammate's conversation and talk to it there.
- The panel is read-only. To change tasks or teammates, ask the lead.

## Good to know

- Each teammate is a separate agent with its own model requests, so a team uses more tokens than one agent.
- Teammates share the same files. Overlapping **Write scopes** only show a warning; nothing stops two teammates from editing the same file.
- A team can hold at most 256 tasks; deleting a task frees a slot. Teammates follow the ordinary subagent limits.
- The ordinary subagent tools create teammates and carry their messages. This plugin adds the shared task board and its panel.
- After turning it on with a conversation open, reload the page to see the panel.
