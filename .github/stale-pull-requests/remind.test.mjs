import assert from 'node:assert/strict'
import test from 'node:test'

import { dueReminder, reminderBody, remindStalePullRequests } from './remind.mjs'

const now = new Date('2026-11-30T00:00:00Z')
const daysAgo = days => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
const human = { login: 'author', type: 'User' }
const bot = { login: 'github-actions[bot]', type: 'Bot' }
const comment = (actor, days, body = 'ok') => ({ event: 'commented', actor, created_at: daysAgo(days), body })
const reminder = (days, stage) => comment(bot, days, reminderBody('author', stage))

test('no reminder is due within 7 days of the last activity', () => {
  assert.equal(dueReminder({ createdAt: daysAgo(6), timeline: [], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(30), timeline: [comment(human, 6)], now }), undefined)
})

test('the latest due stage is posted once after the last activity', () => {
  assert.equal(dueReminder({ createdAt: daysAgo(7), timeline: [], now }), 7)
  assert.equal(dueReminder({ createdAt: daysAgo(10), timeline: [reminder(3, 7)], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(14), timeline: [reminder(7, 7)], now }), 14)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [], now }), 14)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [reminder(20, 14)], now }), undefined)
})

test('human activity restarts the cycle and bot activity does not', () => {
  const sentBefore = [reminder(30, 7), reminder(23, 14)]
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, comment(human, 8)], now }), 7)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'committed', committer: { date: daysAgo(3) } }], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'reviewed', user: human, submitted_at: daysAgo(3) }], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'line-commented', comments: [{ user: human, created_at: daysAgo(3) }] }], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, { event: 'head_ref_force_pushed', actor: human, created_at: daysAgo(3) }], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, comment({ login: 'ci[bot]', type: 'Bot' }, 1)], now }), undefined)
  assert.equal(dueReminder({ createdAt: daysAgo(40), timeline: [...sentBefore, comment({ login: 'ds-review-bot', type: 'User' }, 1)], now }), undefined)
})

test('mentions, labels and cross references are not activity', () => {
  const at = (event, days) => ({ event, actor: human, created_at: daysAgo(days) })
  // GitHub records a `mentioned` event for the author right after each reminder.
  assert.equal(dueReminder({ createdAt: daysAgo(14), timeline: [reminder(7, 7), at('mentioned', 7 - 1e-5), at('subscribed', 7 - 1e-5)], now }), 14)
  assert.equal(dueReminder({ createdAt: daysAgo(20), timeline: [at('labeled', 1), at('cross-referenced', 1), at('review_requested', 1)], now }), 14)
})

test('reminders mention the author and skip exempt and bot-authored pull requests', async () => {
  const pull = (number, overrides = {}) => ({ number, user: human, labels: [], created_at: daysAgo(20), updated_at: daysAgo(20), ...overrides })
  const pulls = [
    pull(1),
    pull(2, { labels: [{ name: 'DO_NOT_CLOSE' }] }),
    pull(3, { user: { login: 'dependabot[bot]', type: 'Bot' } }),
    // A bot comment or label refreshes `updated_at` without being activity.
    pull(4, { updated_at: daysAgo(1) }),
    pull(6),
    pull(5),
  ]
  const comments = []
  const timelines = []
  const github = {
    rest: {
      pulls: { list: 'pulls' },
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
      return []
    },
  }
  const sleeps = []
  const warnings = []
  const failures = []
  const core = { info() {}, warning: message => warnings.push(message), setFailed: message => failures.push(message) }
  await remindStalePullRequests({ github, context: { repo: { owner: 'o', repo: 'r' } }, core, now, sleep: async ms => sleeps.push(ms) })
  assert.deepEqual(timelines, [1, 4, 6, 5])
  assert.deepEqual(warnings, ['#6: locked'])
  assert.equal(failures.length, 1)
  assert.deepEqual(comments.map(({ issue_number }) => issue_number), [1, 4, 5])
  assert.match(comments[0].body, /^<!-- stale-pr-reminder:14 -->\n@author This pull request has had no activity for 14 days\./)
  assert.deepEqual(sleeps, [1000, 1000, 1000])
})

test('a run posts at most 100 reminders', async () => {
  const pulls = Array.from({ length: 105 }, (_, number) => ({ number, user: human, labels: [], created_at: daysAgo(20), updated_at: daysAgo(20) }))
  let comments = 0
  const github = {
    rest: { pulls: { list: 'pulls' }, issues: { listEventsForTimeline: 'timeline', createComment: async () => comments++ } },
    paginate: async method => method === 'pulls' ? pulls : [],
  }
  await remindStalePullRequests({ github, context: { repo: { owner: 'o', repo: 'r' } }, core: { info() {} }, now, sleep: async () => {} })
  assert.equal(comments, 100)
})
