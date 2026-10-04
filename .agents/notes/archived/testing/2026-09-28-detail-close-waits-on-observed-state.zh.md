# Agent Note: 任务详情关闭断言等待它所观测的状态

Status: implemented
Archived: 2026-09-30

[English](2026-09-28-detail-close-waits-on-observed-state.md) | 中文

## Problem

`packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx` 的用例 "keeps details after a refresh failure and closes them after a successful retry" 在 `node 24 / coverage` lane 的 `thread-safe` 分区上间歇失败，失败点是它最后一条断言：`AssertionError: expected <aside aria-label="Task details" …> to be null`。该用例与本文件全部 269 个用例在本地都通过；该 lane 的覆盖率插桩只改变下面两个 commit 之间那个窗口被观测到的概率。

该用例最后一步在一次已确认删除之后重试失败的目录读取，`await screen.findByText(en['list.empty'])`，然后只读一次 `screen.queryByRole('complementary')`。空列表与被移除的详情并不在同一个 commit：

- `catalog-source.ts` 把这次读取的 `records: []` 与 `status: 'ready'` 发布在同一个快照里，因此 `TaskManagerPage` 在这个 commit 渲染 `list.empty` 状态区域。
- `TaskDetail` 在同一个 commit 计算出 `deleted = deletionConfirmed && !authoritative`，并通过它的被动 effect 关闭。该 effect 调用 `onDeleted` → `closeDetails`（接线在页面的 `<TaskDetail>` 元素上），后者把 `selectedId` 置为 null。
- 只有下一次渲染才移除 `<TaskDetail>`，`complementary` 区域随之消失。

`findByText` 在渲染空列表的那个 commit 上返回；关闭由该 commit 的被动 effect 排入，其渲染落在其后，因此在第一个信号返回时就发出的单次读取仍可能看到面板。页面级那个同样会在记录离开权威 ready 快照时关闭选区的 effect 在本用例中不触发：`useTaskDetail` 把已确认删除的任务保留为草稿，于是 `selected` 在行消失的那一帧里仍然有定义。

## Decision

最后一条断言等待它所要断言的状态：`await waitFor(() => { expect(screen.queryByRole('complementary')).toBeNull() })`。`findByText` 的等待保留，作为该用例对「列表回退到空状态」的检查；它不再被当作「关闭已经提交」的信号。

产品行为不变。关闭按设计是提交后 effect：删除已确认或一次保存失败时，面板必须在该行消失的刷新过程中保留，因此它不能在丢弃该行的同一次渲染里被推导掉。

## Alternatives considered

**在更长的等待之后只读一次面板，或在断言之外重试该读取。** 按 Related 两篇 note 为固定窗口、以及未与被断言条件绑定的重试所记录的同一理由不采纳。本用例特有的部分是它所信任的信号：`findByText` 在渲染空列表的那个 commit 上返回，而丢弃面板的并不是那个 commit，因此重试的读取必须绑定到被断言的 DOM，而不是绑定到这个更早的信号。

**按邻近的刷新顺序用例那样，用 `Promise.withResolvers` 延迟量驱动重试，再用一次 `await act(...)` 冲刷。** 本用例不采用：那些用例同时持有删除与刷新的 promise，因为它们的对象是两者之间的先后顺序；而本用例的对象是重试按钮自身路径结算后的状态。把重试做成延迟量会把刷新的结算权交给用例，并把关闭冲进同一个 act 边界，从而把用户可见的 `list.retry` 路径换成手工驱动的路径。轮询保留该路径，而 Consequences 里的负例对照表明：面板永不关闭时失败仍落在该断言上。

**把详情关闭改为渲染期推导，而不是放在 effect 里。** 不采纳：删除已确认或保存失败期间，详情必须在刷新不再报告该行时继续挂载，这样它的失败提示与已保存记录仍然可达。把选区从目录推导出来，会在第一次丢弃该行的刷新就卸载它，而该用例前面的断言固定的正是「保留」这一状态。

**断言 `onDelete` 已结算，而不是断言 DOM。** 不采纳：该用例的对象是面板离开了页面。回调已结算并不能证明该区域已被移除，而延迟的关闭正是这个用例存在的原因。

## Consequences

该用例现在观测的是关闭详情的那个 commit，而不是它之前的一个 commit；只有面板真的不关闭时，它才付出 `waitFor` 默认超时的代价。

该用例在两个方向上都能固定这次关闭。在覆盖率插桩下（也正是该失败出现的 CI 条件），修前的单次读取在 5 次本地运行中有 1 次以 CI 的消息失败，而等待式断言在同一命令的 10 次运行中全部通过。在 `TaskDetail` 中把 `deleted` 条件与 `onDeleted` 之间插入 25 毫秒的 `setTimeout`，修前的单次读取会在同一断言处失败，而同一延迟下等待式断言为绿；把该 effect 里的调用去掉（`if (deleted) onDeleted`：只引用函数、不调用）时，等待式断言在同一断言处失败，因此永不关闭的面板仍会被报告。改动后又用 `-t` 跑了 10 次、整文件 269 个用例跑了 3 次，均未失败。

## Related

- [Windows-lane observations wait on the state they read](2026-09-27-observation-waits-on-observed-state.zh.md) 给出了本用例所应用的规则：观测要等待它所读取的状态，而不是等待墙钟窗口或更早的信号。
- [Web lane assertions name their input state](2026-09-27-web-lane-assertions-name-their-input-state.zh.md) 记录了同一类缺陷在 web e2e lane 上的实例：五条断言采样了前一个动作尚未结算的状态。本条单独成篇是因为 lane、提交机制（一个被动 effect）与负例对照都不同。
