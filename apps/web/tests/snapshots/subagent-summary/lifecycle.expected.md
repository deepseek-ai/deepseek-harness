## Preparing without description

- text: Preparing tool call Create subagent

## Preparing with partial description

- text: Preparing tool call Create subagent Review subagent task summaries

## Running

- text: Running
- button "Create subagent Review subagent task summaries"

## Created

- button "Create subagent Review subagent task summaries"

## Creation receipt and complete task

- button "Create subagent Review subagent task summaries" [expanded]
- text: Recorded result
- list:
  - listitem:
    - text: Started
    - term: Agent task description
    - definition: Review subagent task summaries Additional description context
    - term: ID
    - definition: child-foo
    - group:
      - text: Task
      - list:
        - listitem:
          - paragraph: Inspect the subagent tool card across its lifecycle. Check streaming arguments, creation receipts, and restored history. Return findings without changing unrelated files.
- button "Inspect"

## Restored creation receipt

- button "Create subagent Review subagent task summaries" [expanded]
- text: Recorded result
- list:
  - listitem:
    - text: Started
    - term: Agent task description
    - definition: Review subagent task summaries Additional description context
    - term: ID
    - definition: child-foo
    - group:
      - text: Task
      - list:
        - listitem:
          - paragraph: Inspect the subagent tool card across its lifecycle. Check streaming arguments, creation receipts, and restored history. Return findings without changing unrelated files.
- button "Inspect"
