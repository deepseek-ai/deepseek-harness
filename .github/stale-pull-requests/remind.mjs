/**
 * Daily stale pull-request reminders and closing for the `Stale pull requests` workflow.
 *
 * A pull request's last activity is the latest of its creation, a commit, a force push, a reopen or ready-for-review
 * event, and a comment or review from a non-bot account. Other timeline events, such as mentions, labels and cross
 * references, do not count, so reminder and closing comments never extend it. After 7 and 14 days without activity the
 * workflow comments once per stage and mentions the author. After 21 days without activity, and at least 7 days after
 * the 14-day reminder, it comments and closes the pull request; the reminder therefore always gives the author 7 days'
 * notice, including for pull requests that were already inactive when the workflow started. Activity, including
 * reopening, starts a new cycle. Pull requests labelled `DO_NOT_CLOSE` and pull requests opened by bots are neither
 * reminded nor closed.
 *
 * Each run reads the timeline of every open pull request that is neither exempt nor bot-authored, because `updated_at`
 * also changes on events that are not activity. Each run posts at most `MAX_COMMENTS_PER_RUN` comments, least recently
 * updated pull requests first, so a backlog spreads over several days within GitHub's content-creation limits. A failed
 * pull request is reported and skipped.
 */

/** Label that exempts a pull request from reminders and closing. */
export const EXEMPT_LABEL = 'DO_NOT_CLOSE'

/** Days without activity after which each reminder is posted, in ascending order. */
export const REMINDER_DAYS = [7, 14]

/** Days without activity after which a pull request is closed. */
export const CLOSE_DAYS = 21

const DAY_MS = 24 * 60 * 60 * 1000
// GitHub asks integrations to wait at least one second between content-creating requests.
const COMMENT_INTERVAL_MS = 1000
const MAX_COMMENTS_PER_RUN = 100
// Reminders posted before closing existed use `stale-pr-reminder` and announce no closing, so they are ignored.
const MARKER = /<!-- stale-pr:(\d+) -->/
// Review bots that use ordinary user accounts.
const BOT_LOGINS = new Set(['ds-review-bot'])

const isBot = account => account?.type === 'Bot' || (account?.login ?? '').endsWith('[bot]') || BOT_LOGINS.has(account?.login)

/**
 * Returns the timestamps a timeline event contributes to the last activity.
 * @param {object} event GitHub issue timeline event.
 * @returns {string[]} ISO timestamps; empty for bot activity and events that are not activity.
 */
function activityTimes(event) {
  switch (event.event) {
    case 'committed':
      return [event.committer?.date].filter(Boolean)
    case 'head_ref_force_pushed':
    case 'reopened':
    case 'ready_for_review':
      return [event.created_at]
    case 'commented':
      return isBot(event.actor) ? [] : [event.created_at]
    case 'line-commented':
    case 'commit-commented':
      return (event.comments ?? []).filter(comment => !isBot(comment.user)).map(comment => comment.created_at)
    case 'reviewed':
      return isBot(event.user) ? [] : [event.submitted_at]
    default:
      return []
  }
}

/**
 * Selects the reminder or closing a pull request is due for.
 * @param {object} options
 * @param {string} options.createdAt Pull-request creation time.
 * @param {object[]} options.timeline Complete issue timeline of the pull request.
 * @param {Date} options.now Evaluation time.
 * @returns {{ days: number, comment: boolean } | undefined} Due stage in days, `CLOSE_DAYS` for closing, and whether its
 *   comment is still unposted; `undefined` when nothing is due. A closing whose comment was posted but whose close failed
 *   is due again without a comment.
 */
export function dueStage({ createdAt, timeline, now }) {
  const times = [createdAt, ...timeline.flatMap(activityTimes)].map(time => Date.parse(time)).filter(Number.isFinite)
  const lastActivity = Math.max(...times)
  const sent = timeline
    .filter(event => event.event === 'commented' && isBot(event.actor) && Date.parse(event.created_at) > lastActivity)
    .map(event => ({ days: Number(MARKER.exec(event.body ?? '')?.[1]), at: Date.parse(event.created_at) }))
  const finalReminder = REMINDER_DAYS.at(-1)
  const noticeMs = (CLOSE_DAYS - finalReminder) * DAY_MS
  if (now.getTime() - lastActivity >= CLOSE_DAYS * DAY_MS && sent.some(({ days, at }) => days === finalReminder && now.getTime() - at >= noticeMs)) {
    return { days: CLOSE_DAYS, comment: !sent.some(({ days }) => days === CLOSE_DAYS) }
  }
  const due = REMINDER_DAYS.filter(days => now.getTime() - lastActivity >= days * DAY_MS).at(-1)
  if (due === undefined || sent.some(({ days }) => days >= due)) return undefined
  return { days: due, comment: true }
}

/**
 * Builds the reminder or closing comment.
 * @param {string} author Pull-request author login.
 * @param {number} days Stage in days; `CLOSE_DAYS` builds the closing comment.
 * @returns {string} Comment body.
 */
export function stageBody(author, days) {
  const text = days === CLOSE_DAYS
    ? `@${author} This pull request has had no activity for ${days} days and is now closed. Reopen it, or ask a maintainer to reopen it, if you continue the work.`
    : `@${author} This pull request has had no activity for ${days} days. Please update it, reply to keep it open, or close it if it is no longer needed. Pull requests are closed after ${CLOSE_DAYS} days without activity and at least ${CLOSE_DAYS - REMINDER_DAYS.at(-1)} days after the ${REMINDER_DAYS.at(-1)}-day reminder. Add the \`${EXEMPT_LABEL}\` label, or ask a maintainer to add it, to stop reminders and closing.`
  return `<!-- stale-pr:${days} -->\n${text}`
}

/**
 * Posts every due reminder and closes every due pull request among the open pull requests of the workflow repository.
 * @param {object} options
 * @param {object} options.github Authenticated Octokit client from `actions/github-script`.
 * @param {object} options.context Workflow context from `actions/github-script`.
 * @param {object} options.core Actions toolkit core from `actions/github-script`.
 * @param {Date} [options.now] Evaluation time.
 * @param {(ms: number) => Promise<void>} [options.sleep] Delay between comments.
 * @returns {Promise<void>}
 */
export async function processStalePullRequests({ github, context, core, now = new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { owner, repo } = context.repo
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', sort: 'updated', direction: 'asc', per_page: 100 })
  let posted = 0
  let failed = 0
  for (const pull of pulls) {
    if (posted >= MAX_COMMENTS_PER_RUN) break
    if (isBot(pull.user)) continue
    if (pull.labels.some(label => label.name === EXEMPT_LABEL)) continue
    try {
      const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: pull.number, per_page: 100 })
      const stage = dueStage({ createdAt: pull.created_at, timeline, now })
      if (stage === undefined) continue
      const { days } = stage
      if (stage.comment) {
        if (posted > 0) await sleep(COMMENT_INTERVAL_MS)
        await github.rest.issues.createComment({ owner, repo, issue_number: pull.number, body: stageBody(pull.user.login, days) })
        posted++
      }
      if (days === CLOSE_DAYS) await github.rest.pulls.update({ owner, repo, pull_number: pull.number, state: 'closed' })
      core.info(days === CLOSE_DAYS ? `#${pull.number}: closed after ${days} days without activity` : `#${pull.number}: posted the ${days}-day reminder`)
    } catch (error) {
      failed++
      core.warning(`#${pull.number}: ${error.message}`)
    }
  }
  if (failed > 0) core.setFailed(`${failed} pull requests failed; see the warnings above.`)
}
