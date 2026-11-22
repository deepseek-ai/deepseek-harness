import assert from 'node:assert/strict'
import test from 'node:test'

import { dueStage as dueAction, stageBody, processStalePullRequests } from './remind.mjs'

const now = new Date('2026-11-30T00:00:00Z')
const daysAgo = days => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
const human = { login: 'author', type: 'User' }
const bot = { login: 'github-actions[bot]', type: 'Bot' }
const comment = (actor, days, body = 'ok') => ({ event: 'commented', actor, created_at: daysAgo(days), body })
const reminder = (days, stage) => comment(bot, days, stageBody('author', stage))
const dueStage = options => dueAction(options)?.days

test('no reminder is due within 7 days of the last activity', () => {
  assert.equal(dueStage({ createdAt: daysAgo(6), timeline: [], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(30), timeline: [comment(human, 6)], now }), undefined)
})

test('the latest due stage is posted once after the last activity', () => {
  assert.equal(dueStage({ createdAt: daysAgo(7), timeline: [], now }), 7)
  assert.equal(dueStage({ createdAt: daysAgo(10), timeline: [reminder(3, 7)], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(14), timeline: [reminder(7, 7)], now }), 14)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [], now }), 14)
  assert.equal(dueStage({ createdAt: daysAgo(17), timeline: [reminder(3, 14)], now }), undefined)
})

test('a pull request closes after 21 days without activity and 7 days after the 14-day reminder', () => {
  assert.equal(dueStage({ createdAt: daysAgo(21), timeline: [reminder(14, 7), reminder(7, 14)], now }), 21)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [reminder(20, 14)], now }), 21)
  // A pull request that was already inactive gets the 14-day reminder first and 7 days' notice.
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [reminder(6, 14)], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [reminder(30, 7)], now }), 14)
  // A 14-day reminder from before the last activity gives no notice.
  assert.equal(dueStage({ createdAt: daysAgo(60), timeline: [reminder(40, 14), comment(human, 25)], now }), 14)
  // Reminders posted before closing existed announce no closing.
  const legacy = comment(bot, 10, '<!-- stale-pr-reminder:14 -->\n@author This pull request has had no activity for 14 days.')
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [legacy], now }), 14)
})

test('a closing whose comment was posted retries the close without another comment', () => {
  assert.deepEqual(dueAction({ createdAt: daysAgo(30), timeline: [reminder(9, 14)], now }), { days: 21, comment: true })
  assert.deepEqual(dueAction({ createdAt: daysAgo(30), timeline: [reminder(9, 14), reminder(1, 21)], now }), { days: 21, comment: false })
})

test('human activity restarts the cycle and bot activity does not', () => {
  const sentBefore = [reminder(30, 7), reminder(23, 14)]
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, comment(human, 8)], now }), 7)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'committed', committer: { date: daysAgo(3) } }], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'reviewed', user: human, submitted_at: daysAgo(3) }], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'line-commented', comments: [{ user: human, created_at: daysAgo(3) }] }], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'head_ref_force_pushed', actor: human, created_at: daysAgo(3) }], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'reopened', actor: human, created_at: daysAgo(3) }], now }), undefined)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, comment({ login: 'ci[bot]', type: 'Bot' }, 1)], now }), 21)
  assert.equal(dueStage({ createdAt: daysAgo(40), timeline: [...sentBefore, comment({ login: 'ds-review-bot', type: 'User' }, 1)], now }), 21)
})

test('mentions, labels and cross references are not activity', () => {
  const at = (event, days) => ({ event, actor: human, created_at: daysAgo(days) })
  // GitHub records a `mentioned` event for the author right after each reminder.
  assert.equal(dueStage({ createdAt: daysAgo(14), timeline: [reminder(7, 7), at('mentioned', 7 - 1e-5), at('subscribed', 7 - 1e-5)], now }), 14)
  assert.equal(dueStage({ createdAt: daysAgo(20), timeline: [at('labeled', 1), at('cross-referenced', 1), at('review_requested', 1)], now }), 14)
})

test('reminders and closing mention the author and skip exempt and bot-authored pull requests', async () => {
  const pull = (number, overrides = {}) => ({ number, user: human, labels: [], created_at: daysAgo(20), updated_at: daysAgo(20), ...overrides })
  const pulls = [
    pull(1),
    pull(2, { labels: [{ name: 'DO_NOT_CLOSE' }] }),
    pull(3, { user: { login: 'dependabot[bot]', type: 'Bot' } }),
    // A bot comment or label refreshes `updated_at` without being activity.
    pull(4, { updated_at: daysAgo(1) }),
    pull(6),
    pull(5),
    pull(7, { created_at: daysAgo(30) }),
    pull(8, { created_at: daysAgo(30) }),
  ]
  const comments = []
  const closed = []
  const timelines = []
  const github = {
    rest: {
      pulls: {
        list: 'pulls',
        update: async params => {
          if (params.pull_number === 8) throw new Error('close failed')
          closed.push(params)
        },
      },
      issues: {
        listEventsForTimeline: 'timeline',
        createComment: async params => {
          if (params.issue_number === 6) throw new Error('locked')
          comments.push(params)
        },
      },
    },
    paginate: async (method, params) => {
      if (method === 'pulls') return pulls
      timelines.push(params.issue_number)
      return [7, 8].includes(params.issue_number) ? [reminder(9, 14)] : []
    },
  }
  const sleeps = []
  const warnings = []
  const failures = []
  const core = { info() {}, warning: message => warnings.push(message), setFailed: message => failures.push(message) }
  await processStalePullRequests({ github, context: { repo: { owner: 'o', repo: 'r' } }, core, now, sleep: async ms => sleeps.push(ms) })
  assert.deepEqual(timelines, [1, 4, 6, 5, 7, 8])
  // A failed close after its comment is retried on the next run without another comment.
  assert.deepEqual(warnings, ['#6: locked', '#8: close failed'])
  assert.equal(failures.length, 1)
  assert.deepEqual(comments.map(({ issue_number }) => issue_number), [1, 4, 5, 7, 8])
  assert.match(comments[0].body, /^<!-- stale-pr:14 -->\n@author This pull request has had no activity for 14 days\./)
  assert.match(comments[3].body, /^<!-- stale-pr:21 -->\n@author This pull request has had no activity for 21 days and is now closed\./)
  assert.deepEqual(closed, [{ owner: 'o', repo: 'r', pull_number: 7, state: 'closed' }])
  assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 1000])
})

test('a run posts at most 100 reminders', async () => {
  const pulls = Array.from({ length: 105 }, (_, number) => ({ number, user: human, labels: [], created_at: daysAgo(20), updated_at: daysAgo(20) }))
  let comments = 0
  const github = {
    rest: { pulls: { list: 'pulls' }, issues: { listEventsForTimeline: 'timeline', createComment: async () => comments++ } },
    paginate: async method => method === 'pulls' ? pulls : [],
  }
  await processStalePullRequests({ github, context: { repo: { owner: 'o', repo: 'r' } }, core: { info() {} }, now, sleep: async () => {} })
  assert.equal(comments, 100)
})
