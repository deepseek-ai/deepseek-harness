- banner:
  - navigation "Session hierarchy": Stream one TypeScript fence for
  - text: Standard mode
  - button "More actions"
  - button "Open right sidebar"
  - tablist:
    - tab "Chat" [selected]
    - tab "Trajectory"
- text: Stream one TypeScript fence for the highlighting snapshot. {{clock}}
- button "Copy"
- status: Deep diving...
- button "Deep diving for {{duration}}" [disabled] [expanded]
- text: ts
- button "Wrap lines" [pressed]
- button "Copy"
- code: "const first: number = 1 const second = \"two\" let tail"
- textbox "Message or run a task, / commands, @ files or sessions"
- button "Add files or run commands"
- 'button "Access mode, current: Workspace Write"': Workspace Write
- button "Select model, current streaming-fence-highlight-test/streaming-fence": streaming-fence-highlight-test/streaming-fence
- button "Stop generating"

---

{
  "language": "ts",
  "pre": {
    "className": "shiki css-variables",
    "style": "background-color: var(--shiki-background); color: var(--shiki-foreground);",
    "tabIndex": "0"
  },
  "lines": [
    [
      {
        "text": "const",
        "style": "color: var(--shiki-token-keyword);"
      },
      {
        "text": " first",
        "style": "color: var(--shiki-token-constant);"
      },
      {
        "text": ":",
        "style": "color: var(--shiki-token-keyword);"
      },
      {
        "text": " number",
        "style": "color: var(--shiki-token-constant);"
      },
      {
        "text": " =",
        "style": "color: var(--shiki-token-keyword);"
      },
      {
        "text": " 1",
        "style": "color: var(--shiki-token-constant);"
      }
    ],
    [
      {
        "text": "const",
        "style": "color: var(--shiki-token-keyword);"
      },
      {
        "text": " second",
        "style": "color: var(--shiki-token-constant);"
      },
      {
        "text": " =",
        "style": "color: var(--shiki-token-keyword);"
      },
      {
        "text": " \"two\"",
        "style": "color: var(--shiki-token-string-expression);"
      }
    ],
    [
      {
        "text": "let",
        "style": "color: var(--shiki-token-keyword);"
      },
      {
        "text": " tail",
        "style": "color: var(--shiki-foreground);"
      }
    ]
  ]
}
