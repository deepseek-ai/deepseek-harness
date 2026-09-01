import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countVisibleUnits,
  initializeIssueStartDate,
  initializePullRequestStartDates,
  nextResolvingIssueStatus,
  parseReferences,
  projectDate,
  retainIssueReferences,
  resolvingIssueStatusCommand,
  requiresPullRequestPolicy,
  validateBody,
  validateIssue,
  validatePullRequest,
} from './policy.mjs'

const projectGraphqlData = ({
  projectItem = true,
  startDate = null,
  startDateField = true,
  startDateType = 'DATE',
} = {}) => ({
  organization: {
    projectV2: {
      id: 'project-id',
      title: 'DSH Issue Management',
      fields: {
        nodes: [
          { id: 'status-field-id', name: 'Status', dataType: 'SINGLE_SELECT', options: [] },
          ...(startDateField
            ? [{ id: 'start-date-field-id', name: 'Start date', dataType: startDateType }]
            : []),
        ],
      },
    },
  },
  repository: {
    issue: {
      id: 'issue-id',
      projectItems: {
        nodes: projectItem
          ? [
              {
                id: 'item-id',
                project: { id: 'project-id' },
                fieldValueByName: { name: 'Inbox', optionId: 'inbox-option-id' },
                startDateValue: startDate === null ? null : { date: startDate },
              },
            ]
          : [],
      },
    },
  },
})

const mockGraphql = (t, resolve) => {
  const requests = []
  const previousToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousToken
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    const request = JSON.parse(options.body)
    requests.push(request)
    return Response.json({ data: resolve(request, requests.length - 1) })
  })
  return requests
}

const withDetails = (summary) =>
  `${summary}\n\n<details><summary>验收与细节</summary>待补充。</details>`

const legalIssue = {
  title: '完成议题管理校验',
  body: withDetails('完成议题管理校验。'),
  assignees: [],
  labels: [],
  type: 'Idea',
  priority: null,
  status: 'In review',
  state: 'open',
  stateReason: null,
}

const canonicalKinds = [
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
]

// Keep an independent oracle rather than importing the implementation's reserved set.
const legacyLabels = [
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
]

const reviewedPull = (labels) => ({
  isDraft: false,
  authorType: 'User',
  reviewRequestCount: 1,
  reviewCount: 0,
  labels,
  references: { all: [2], resolving: [], related: [2] },
  issues: new Map([[2, { priority: null }]]),
})

test('counts only text outside details', () => {
  assert.deepEqual(countVisibleUnits('支持 GitHub Project。<details>隐藏文字</details>'), {
    units: 4,
    balanced: true,
    detailsCount: 1,
    allCollapsed: true,
  })
})

test('requires a balanced default-collapsed details region', () => {
  assert.deepEqual(validateBody({ body: '完成工作。', assignees: [] }), [
    '正文必须包含默认收起的 <details> 区域',
  ])
  assert.deepEqual(
    validateBody({
      body: '完成工作。\n\n<details open><summary>细节</summary>待补充。</details>',
      assignees: [],
    }),
    ['details 必须默认收起，不得设置 open'],
  )
  assert.deepEqual(
    validateBody({ body: '完成工作。\n\n<details><summary>细节</summary>', assignees: [] }),
    ['details 标签必须成对闭合'],
  )
})

test('requires Owner for multiple assignees', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('完成工作。'),
      assignees: ['tianyicui', 'tianyicui-bot'],
    }),
    ['多个 Assignees 时首个非空行必须是 Owner: @login'],
  )
})

test('accepts an intended Owner while assignment permission is pending', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: [],
    }),
    [],
  )
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: ['hubot'],
    }),
    ['零或一个 Assignee 时不得写 Owner 行'],
  )
})

test('allows optional metadata in every open Status', () => {
  assert.deepEqual(validateIssue(legalIssue), [])
  for (const status of ['Inbox', 'Backlog', 'Ready', 'In progress', 'In review']) {
    assert.deepEqual(validateIssue({ ...legalIssue, status }), [])
  }
})

test('rejects metadata prefixes in an Issue title', () => {
  const errors = validateIssue({ ...legalIssue, title: '[Bug] 修复恢复错误' })
  assert.ok(errors.includes('Issue 标题不得带 Type、Priority、Status、area 或 Owner 前缀'))
})

test('reserves PR kind and legacy labels for pull requests', () => {
  for (const label of [
    ...canonicalKinds,
    'kind/experimental',
    ...legacyLabels,
  ]) {
    assert.ok(
      validateIssue({ ...legalIssue, labels: [label] }).some((error) =>
        error.startsWith('Issue 不得使用 PR kind 或旧版标签：'),
      ),
      label,
    )
  }
  assert.deepEqual(validateIssue({ ...legalIssue, labels: ['area/web', 'source/member'] }), [])
})

test('keeps terminal Status aligned with the native close reason', () => {
  assert.deepEqual(
    validateIssue({ ...legalIssue, status: 'Done', state: 'closed', stateReason: 'completed' }),
    [],
  )
  assert.deepEqual(
    validateIssue({
      ...legalIssue,
      status: 'No action',
      state: 'closed',
      stateReason: 'not_planned',
    }),
    [],
  )
  assert.ok(validateIssue({ ...legalIssue, status: 'Done' }).includes('Done 必须对应 Completed 关闭原因'))
})

test('separates resolving and informational references', () => {
  assert.deepEqual(
    parseReferences({
      body: 'Fixes #12\nRelated to #4\nRefs deepseekharness/dsh-test#7',
      repository: 'deepseekharness/dsh-test',
    }),
    { all: [4, 7, 12], resolving: [12], related: [4, 7] },
  )
})

test('converts PR creation timestamps to Shanghai Project dates', () => {
  assert.equal(projectDate('2026-08-27T15:59:59Z', 'Asia/Shanghai'), '2026-08-27')
  assert.equal(projectDate('2026-08-27T16:00:00Z', 'Asia/Shanghai'), '2026-08-28')
  assert.throws(() => projectDate('invalid', 'Asia/Shanghai'), /无效的 PR 创建时间/)
})

test('initializes every referenced Issue only for a PR opened event', async () => {
  const writes = []
  const pull = {
    createdAt: '2026-08-27T16:00:00Z',
    references: { all: [4, 7, 12] },
  }
  const initialize = async (number, date) => writes.push({ number, date })

  await initializePullRequestStartDates(pull, 'opened', initialize)
  assert.deepEqual(writes, [
    { number: 4, date: '2026-08-28' },
    { number: 7, date: '2026-08-28' },
    { number: 12, date: '2026-08-28' },
  ])

  for (const action of ['edited', 'synchronize', 'reopened']) {
    await initializePullRequestStartDates(pull, action, initialize)
  }
  assert.equal(writes.length, 3)
})

test('writes an empty Project Start date with the configured field', async (t) => {
  const requests = mockGraphql(t, (request) => {
    if (request.query.includes('query(')) return projectGraphqlData()
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-id' } } }
  })

  await initializeIssueStartDate(42, '2026-08-28')

  assert.equal(requests.length, 2)
  assert.match(requests[1].query, /value: \{date: \$date\}/)
  assert.deepEqual(requests[1].variables, {
    projectId: 'project-id',
    itemId: 'item-id',
    fieldId: 'start-date-field-id',
    date: '2026-08-28',
  })
})

test('preserves an existing Project Start date', async (t) => {
  const requests = mockGraphql(t, () => projectGraphqlData({ startDate: '2026-08-01' }))

  await initializeIssueStartDate(42, '2026-08-28')

  assert.equal(requests.length, 1)
})

test('adds a referenced Issue to the Project before setting Start date', async (t) => {
  const requests = mockGraphql(t, (request) => {
    if (request.query.includes('query(')) return projectGraphqlData({ projectItem: false })
    if (request.query.includes('addProjectV2ItemById')) {
      return { addProjectV2ItemById: { item: { id: 'new-item-id' } } }
    }
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'new-item-id' } } }
  })

  await initializeIssueStartDate(42, '2026-08-28')

  assert.equal(requests.length, 3)
  assert.deepEqual(requests[1].variables, { projectId: 'project-id', contentId: 'issue-id' })
  assert.equal(requests[2].variables.itemId, 'new-item-id')
})

test('rejects a missing or non-Date Start date field', async (t) => {
  let response = projectGraphqlData({ startDateField: false })
  const requests = mockGraphql(t, () => response)

  await assert.rejects(initializeIssueStartDate(42, '2026-08-28'), /Project 缺少 Start date 字段/)
  response = projectGraphqlData({ startDateType: 'TEXT' })
  await assert.rejects(initializeIssueStartDate(42, '2026-08-28'), /Start date 字段必须为 Date/)
  assert.equal(requests.length, 2)
})

test('does not treat pull request references as Issue associations', () => {
  const references = {
    all: [123, 1180, 1181],
    resolving: [123, 1180],
    related: [1181],
  }
  const issues = new Map([
    [1180, {}],
    [1181, {}],
  ])

  assert.deepEqual(retainIssueReferences(references, issues), {
    all: [1180, 1181],
    resolving: [1180],
    related: [1181],
  })
})

test('allows informational references without cross-object constraints', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/cleanup', 'area/infra'],
    references: { all: [4], resolving: [], related: [4] },
    issues: new Map([[4, { type: 'Bug', priority: 'P0', labels: ['area/web'] }]]),
  })
  assert.deepEqual(errors, [])
})

test('enforces highest resolving Priority without Type or area synchronization', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 1,
    labels: ['kind/cleanup', 'p0', 'area/web'],
    references: { all: [2, 3], resolving: [2, 3], related: [] },
    issues: new Map([
      [2, { type: 'Feature', priority: 'P2', labels: ['area/web'] }],
      [3, { type: 'Bug', priority: 'P0', labels: ['area/session'] }],
    ]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, labels: ['kind/cleanup', 'p2', 'area/web'] }).includes(
      'PR Priority 应为 p0',
    ),
  )
})

test('requires policy only after a human PR enters review', () => {
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 1,
      reviewCount: 0,
    }),
    true,
  )
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 0,
      reviewCount: 0,
    }),
    false,
  )
})

test('maps only explicit review handoffs to review status commands', () => {
  assert.equal(
    resolvingIssueStatusCommand('pull_request', {
      action: 'review_requested',
    }),
    'review-requested',
  )
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
    }),
    'changes-requested',
  )
  for (const state of ['approved', 'commented']) {
    assert.equal(
      resolvingIssueStatusCommand('pull_request_review', {
        action: 'submitted',
        review: { state },
      }),
      null,
    )
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'dismissed',
      review: { state: 'changes_requested' },
    }),
    null,
  )
})

test('keeps ordinary pull request events as forward-only implementation signals', () => {
  for (const action of ['opened', 'edited', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), 'implementation')
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'review_request_removed' }),
    null,
  )
})

test('toggles automation-owned work on request changes and repeated review request', () => {
  for (const status of ['Inbox', 'Backlog', 'Ready']) {
    assert.equal(nextResolvingIssueStatus(status, 'implementation'), 'In progress')
    assert.equal(nextResolvingIssueStatus(status, 'review-requested'), 'In review')
    assert.equal(nextResolvingIssueStatus(status, 'changes-requested'), 'In progress')
  }
  let status = nextResolvingIssueStatus(
    'In review',
    'changes-requested',
    'dsh-issue-management',
  )
  assert.equal(status, 'In progress')
  status = nextResolvingIssueStatus(status, 'review-requested')
  assert.equal(status, 'In review')
})

test('preserves human review status and terminal Issues', () => {
  assert.equal(nextResolvingIssueStatus('In progress', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested', 'tianyicui'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus('Done', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('No action', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus(null, 'review-requested'), null)
})

test('keeps lifecycle projection independent of PR metadata enforcement', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }

  assert.ok(validatePullRequest(pull).length > 0)
  assert.equal(nextResolvingIssueStatus('Inbox', 'review-requested'), 'In review')
})

test('exempts Draft, Bot, and App PRs', () => {
  const invalid = {
    isDraft: false,
    labels: [],
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
    reviewRequestCount: 1,
    reviewCount: 0,
  }
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'Bot' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'App' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'User', isDraft: true }), [])
  assert.ok(validatePullRequest({ ...invalid, authorType: 'User' }).length > 0)
})

test('requires repository PR labels in the enforcement scope', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [], related: [2] },
    issues: new Map([[2, { priority: null }]]),
  })
  assert.ok(errors.includes('PR 必须恰好有一个允许的 kind/*，当前为 0'))
  assert.ok(errors.includes('PR 必须至少有一个 area/*'))
})

test('accepts exactly the canonical kinds with extensible areas', () => {
  for (const kind of canonicalKinds) {
    assert.deepEqual(validatePullRequest(reviewedPull([kind, 'area/future-domain'])), [], kind)
  }
})

test('rejects multiple, unknown, legacy, and Issue-source PR labels', () => {
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'kind/doc', 'area/web']),
    ).includes('PR 必须恰好有一个允许的 kind/*，当前为 2'),
  )
  assert.ok(
    validatePullRequest(reviewedPull(['kind/experimental', 'area/web'])).includes(
      'PR 含不支持的 kind/*：kind/experimental',
    ),
  )
  for (const label of legacyLabels) {
    assert.ok(
      validatePullRequest(reviewedPull(['kind/feature', 'area/web', label])).some((error) =>
        error.startsWith('PR 含旧版标签：'),
      ),
      label,
    )
  }
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'area/web', 'source/internal-pr']),
    ).includes('source/* 仅用于 Issue：source/internal-pr'),
  )
})

test('allows missing Priority only when resolving Issues are also unprioritized', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/feature', 'area/web'],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, issues: new Map([[2, { priority: 'P2' }]]) }).includes(
      'PR Priority 应为 p2',
    ),
  )
  assert.ok(
    validatePullRequest({ ...pull, labels: [...pull.labels, 'p2'] }).includes(
      '有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority',
    ),
  )
})
