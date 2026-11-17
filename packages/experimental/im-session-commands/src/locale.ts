/**
 * Reply strings of the session-commands plugin: every reply the plugin publishes goes through one table so an operator
 * can switch language with `config.locale` (`zh` by default).
 */

export type SessionCommandsLocale = 'zh' | 'en'

/** Command names the plugin answers itself; the same order `/help` lists them in. */
export type BuiltinCommandName = 'stop' | 'clear' | 'new' | 'status' | 'help'

/** Every reply string of one locale; `{count}` is the only placeholder. */
export interface SessionCommandStrings {
  /** `{count}` sessions were stopped. */
  stopped: string
  /** Nothing was running. */
  nothingToStop: string
  /** `{count}` sessions were reset. */
  reset: string
  /** No home session matched the resettable owners. */
  nothingToReset: string
  /** The chat has no session to act on. */
  noSession: string
  /** The sender is not allowed to run a privileged command. */
  denied: string
  /** A passthrough command succeeded without text. */
  done: string
  /** A side-effecting command was interrupted before its result was recorded. */
  interrupted: string
  /** Header line of `/help`. */
  helpTitle: string
  /** Label separator (full-width colon in Chinese). */
  colon: string
  /** One description per built-in command. */
  describe: Record<BuiltinCommandName, string>
  /** Labels of the `/status` reply. */
  status: {
    session: string
    model: string
    state: string
    queued: string
    activity: string
    running: string
    idle: string
  }
  /** Turn-age fragments (`{count}` seconds/minutes/hours ago). */
  age: { seconds: string; minutes: string; hours: string }
}

const zh: SessionCommandStrings = {
  stopped: '已停止 {count} 个会话。',
  nothingToStop: '没有正在运行的会话。',
  reset: '已重置 {count} 个会话，下一轮对话将使用新的上下文。',
  nothingToReset: '没有可重置的会话。',
  noSession: '当前聊天还没有会话。',
  denied: '你没有权限执行这个命令。',
  done: '已完成。',
  interrupted: '该命令此前已开始执行，但结果未能落盘（结果未知，未重复执行）。',
  helpTitle: '可用命令：',
  colon: '：',
  describe: {
    stop: '停止正在运行的会话',
    clear: '清空会话（重置上下文）',
    new: '开启新会话（重置上下文）',
    status: '查看会话状态',
    help: '显示这个帮助',
  },
  status: {
    session: '会话',
    model: '模型',
    state: '状态',
    queued: '排队消息',
    activity: '最近活动',
    running: '运行中',
    idle: '空闲',
  },
  age: { seconds: '{count} 秒前', minutes: '{count} 分钟前', hours: '{count} 小时前' },
}

const en: SessionCommandStrings = {
  stopped: 'Stopped {count} session(s).',
  nothingToStop: 'No session is running.',
  reset: 'Reset {count} session(s); the next turn starts from a fresh context.',
  nothingToReset: 'No session to reset.',
  noSession: 'This chat has no session yet.',
  denied: 'You are not allowed to run this command.',
  done: 'Done.',
  interrupted: 'This command was already started before its result could be recorded (outcome unknown; not re-run).',
  helpTitle: 'Commands:',
  colon: ': ',
  describe: {
    stop: 'Stop the running session',
    clear: 'Clear the session (reset context)',
    new: 'Start a new session (reset context)',
    status: 'Show the session status',
    help: 'Show this help',
  },
  status: {
    session: 'Session',
    model: 'Model',
    state: 'State',
    queued: 'Queued',
    activity: 'Last active',
    running: 'running',
    idle: 'idle',
  },
  age: { seconds: '{count}s ago', minutes: '{count}m ago', hours: '{count}h ago' },
}

const tables: Record<SessionCommandsLocale, SessionCommandStrings> = { zh, en }

/**
 * Reply strings of one locale.
 * @param locale - configured language.
 * @returns the immutable string table.
 */
export function stringsOf(locale: SessionCommandsLocale): SessionCommandStrings {
  return tables[locale]
}

/**
 * Substitute the `{count}` placeholder of one template.
 * @param template - a string carrying `{count}`.
 * @param count - the number to render.
 * @returns the filled string.
 */
export function fill(template: string, count: number): string {
  return template.replace('{count}', String(count))
}

/**
 * Render how long ago a session was last active.
 * @param elapsedMs - milliseconds since the last activity.
 * @param strings - reply strings of the configured locale.
 * @returns seconds, minutes or hours, whichever unit reads best.
 */
export function describeAge(elapsedMs: number, strings: SessionCommandStrings): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 60) return fill(strings.age.seconds, seconds)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return fill(strings.age.minutes, minutes)
  return fill(strings.age.hours, Math.floor(minutes / 60))
}
