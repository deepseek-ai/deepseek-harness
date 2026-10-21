/** `goal` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'phase.active': '进行中的目标',
  'phase.active.disarmed': '已暂停的目标',
  'phase.paused': '已暂停的目标',
  'phase.blocked': '受阻的目标',
  'objective.aria': '目标内容',
  'commandInput.aria': '指令输入',
  'action.save': '保存目标',
  'action.cancel': '取消编辑',
  'action.pause': '暂停目标',
  'action.resume': '恢复目标',
  'action.edit': '编辑目标',
  'action.clear': '清除目标',
} satisfies Record<string, string>

/** The goal namespace key union. */
export type GoalKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'phase.active': 'Ongoing Goal',
  'phase.active.disarmed': 'Inactive Goal',
  'phase.paused': 'Paused Goal',
  'phase.blocked': 'Blocked Goal',
  'objective.aria': 'Goal objective',
  'commandInput.aria': 'Command input',
  'action.save': 'Save goal',
  'action.cancel': 'Cancel edit',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.edit': 'Edit goal',
  'action.clear': 'Clear goal',
} satisfies Record<GoalKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'phase.active': '進行中の目標',
  'phase.active.disarmed': '非アクティブな目標',
  'phase.paused': '一時停止中の目標',
  'phase.blocked': 'ブロックされた目標',
  'objective.aria': '目標の目的',
  'commandInput.aria': 'コマンド入力',
  'action.save': '目標を保存',
  'action.cancel': '編集をキャンセル',
  'action.pause': '目標を一時停止',
  'action.resume': '目標を再開',
  'action.edit': '目標を編集',
  'action.clear': '目標をクリア',
} satisfies Record<keyof typeof en, string>
