- banner:
  - navigation "Session hierarchy":
    - button "Stream one TypeScript fence for" [disabled]
  - img
  - text: Standard mode
  - button "Session log":
    - text: Session log
    - img
  - tablist:
    - tab "Chat" [selected]
    - tab "Trajectory"
- button "System prompt":
  - img
  - img
  - text: System prompt
- text: Stream one TypeScript fence for the highlighting snapshot. {{clock}}
- button "Copy":
  - img
- button "Context injection @deepseek-ai/dsh-system-prompt":
  - img
  - img
  - text: Context injection @deepseek-ai/dsh-system-prompt
- text: ts
- button "Copy"
- code: "const first: number = 1 const second = \"two\" let tail"
- status: Deep diving...
- textbox "Message or run a task... / commands, @ files or sessions"
- button "Commands":
  - img
- button "Add attachment":
  - img
- 'button "Access mode, current: Workspace Write"': Workspace Write
- button "Select model, current streaming-fence-highlight-test/streaming-fence":
  - text: streaming-fence-highlight-test/streaming-fence
  - img
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
