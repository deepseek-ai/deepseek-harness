## Menu

- group "智能体团队协作":
  - text: 开启智能体团队协作
  - switch "开启智能体团队协作" [checked]
  - paragraph: 通过共享任务板协调多个智能体的分工与进度，复杂任务表现更佳，token 开销也相应更高。

## Confirmation

- dialog "确认关闭智能体团队协作？":
  - heading "确认关闭智能体团队协作？" [level=2]
  - button "关闭"
  - paragraph: 对话过程中关闭智能体团队协作，将停止共享任务工具和团队协调指令。
  - paragraph: 关闭后可能影响缓存复用、增加后续 token 用量与开销，并影响当前任务的协作效果。
  - button "取消"
  - button "确认关闭"
