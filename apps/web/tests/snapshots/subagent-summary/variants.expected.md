## fallback

- button "Create subagent Review the fallback summary." [expanded]
- text: Recorded result
- list:
  - listitem:
    - text: Started
    - term: ID
    - definition: fallback-worker
    - group:
      - text: Task
      - list:
        - listitem:
          - paragraph: Review the fallback summary. Keep the complete task in details.
- button "Inspect"

## reply

- button "Create subagent Check synchronous agent reply" [expanded]
- text: Recorded result
- list:
  - listitem:
    - text: Agent response
    - paragraph: The synchronous agent found two issues. Both are documented in the report.
    - group:
      - text: Task
      - list:
        - listitem:
          - paragraph: Review the synchronous report. Keep every instruction available.
- button "Inspect"

## title-only

- button "Create subagent"

## error

- text: Failed
- button "Create subagent Subagent capacity exceeded"
