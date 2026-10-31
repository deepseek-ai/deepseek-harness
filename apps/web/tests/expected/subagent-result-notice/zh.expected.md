- button "子智能体已完成任务 {{clock}}" [expanded]:
  - text: 子智能体已完成任务
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent notice-result-child finished and will do no further work unless you send it more.Its closing message:## Research result The original child reply stays available.

- button "子智能体任务已停止 {{clock}}" [expanded]:
  - text: 子智能体任务已停止
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent notice-result-child was stopped before it finished.Its closing message:## Research result The original child reply stays available.

- button "子智能体执行失败 {{clock}}" [expanded]:
  - text: 子智能体执行失败
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent notice-result-child failed before it finished.Its closing message:## Research result The original child reply stays available.

- button "子智能体已达 token 上限 {{clock}}" [expanded]:
  - text: 子智能体已达 token 上限
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent notice-result-child ran out of room before it finished.Its closing message:## Research result The original child reply stays available.

- button "子智能体拒绝执行 {{clock}}" [expanded]:
  - text: 子智能体拒绝执行
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent notice-result-child declined the task.Its closing message:## Research result The original child reply stays available.

- button "子智能体已完成任务 {{clock}}" [expanded]:
  - text: 子智能体已完成任务
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent notice-result-child finished and will do no further work unless you send it more.It left no closing message.

- button "子任务状态更新 {{clock}}" [expanded]:
  - text: 子任务状态更新
  - time: {{clock}}
- paragraph: 这条通知触发了本轮回复。
- text: Background subagent finished.
