/** GitHub transport, Issue/Project readers, and Project membership and field writes. */

import process from 'node:process'

import config from './config.json' with { type: 'json' }

const API_VERSION = '2026-03-10'

function token() {
  const value = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!value) throw new Error('GH_TOKEN 或 GITHUB_TOKEN 未设置')
  return value
}

function projectToken() {
  return process.env.PROJECT_TOKEN || token()
}

/**
 * Send one GitHub REST request; HTTP failures retain the method, path, status, and body.
 * @param {string} path API path including any query string.
 * @param {object} options Fetch options; allow404 returns null for a 404.
 * @returns {Promise<object|null>} Decoded JSON, or null for an allowed 404 or a 204.
 */
export async function api(path, options = {}) {
  const { allow404 = false, ...requestOptions } = options
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    ...requestOptions,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'dsh-issue-policy',
      ...options.headers,
    },
  })
  if (allow404 && response.status === 404) return null
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${requestOptions.method ?? 'GET'} ${path}: ${response.status} ${body}`)
  }
  if (response.status === 204) return null
  return response.json()
}

/**
 * Send one Project-authenticated GraphQL request; reject joined GraphQL error messages.
 * @param {string} query GraphQL document.
 * @param {object} variables GraphQL variables.
 * @returns {Promise<object>} GraphQL data.
 */
export async function graphql(query, variables) {
  const result = await api('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
    headers: {
      Authorization: `Bearer ${projectToken()}`,
      'Content-Type': 'application/json',
    },
  })
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '))
  return result.data
}

/**
 * Read one Issue together with its Project planning values.
 * @param {number} number Same-repository Issue number.
 * @param {string|null|undefined} status Optional known Project status.
 * @returns {Promise<object|null>} Issue snapshot, or null when the number identifies a pull request.
 */
export async function issueSnapshot(number, status = undefined) {
  const issue = await api(`/repos/${config.organization}/${config.repository}/issues/${number}`)
  if (issue.pull_request) return null
  const context = await projectContext(number)
  return {
    number,
    nodeId: issue.node_id,
    labels: issue.labels.map((label) => label.name),
    type: issue.type?.name ?? null,
    priority: context.item?.priorityValue?.name ?? null,
    status: status === undefined ? (context.item?.fieldValueByName?.name ?? null) : status,
    state: issue.state,
    stateReason: issue.state_reason ?? null,
  }
}

/**
 * Read and validate the configured Project fields and one Issue’s membership.
 * @param {number} number Same-repository Issue number.
 * @param {boolean} includeStatusActor Include the latest matching status-event actor.
 * @param {boolean} includeStartDate Include and validate the Project Start Date field.
 * @returns {Promise<object>} Project, Issue, fields, optional item, and status actor; never writes.
 */
export async function projectContext(number, includeStatusActor = false, includeStartDate = false) {
  const data = await graphql(
    `query(
      $organization: String!
      $repository: String!
      $number: Int!
      $project: Int!
      $includeStatusActor: Boolean!
      $includeStartDate: Boolean!
      $priorityField: String!
      $startDateField: String!
    ) {
      organization(login: $organization) {
        projectV2(number: $project) {
          id
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
                isIssueField
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                isIssueField
                options { id name }
              }
            }
          }
        }
      }
      repository(owner: $organization, name: $repository) {
        issue(number: $number) {
          id
          timelineItems(last: 100, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT])
            @include(if: $includeStatusActor) {
            nodes {
              ... on ProjectV2ItemStatusChangedEvent {
                actor { login }
                project { id }
                status
              }
            }
          }
          projectItems(first: 20, includeArchived: true) {
            nodes {
              id
              project { id }
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
              }
              priorityValue: fieldValueByName(name: $priorityField) {
                ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
              }
              startDateValue: fieldValueByName(name: $startDateField)
                @include(if: $includeStartDate) {
                ... on ProjectV2ItemFieldDateValue { date }
              }
            }
          }
        }
      }
    }`,
    {
      organization: config.organization,
      repository: config.repository,
      number,
      project: config.projectNumber,
      includeStatusActor,
      includeStartDate,
      priorityField: config.priorityField,
      startDateField: config.startDateField,
    },
  )
  const project = data.organization?.projectV2
  const issue = data.repository?.issue
  if (!project || project.title !== config.projectTitle) throw new Error('目标 Project 不存在或标题不匹配')
  if (!issue) throw new Error(`#${number} 不存在`)
  const statusField = project.fields.nodes.find((field) => field?.name === 'Status')
  if (!statusField) throw new Error('Project 缺少 Status 字段')
  const priorityField = project.fields.nodes.find((field) => field?.name === config.priorityField)
  if (!priorityField) throw new Error(`Project 缺少 ${config.priorityField} 字段`)
  if (priorityField.dataType !== 'SINGLE_SELECT') {
    throw new Error(`Project ${config.priorityField} 字段必须为 Single Select`)
  }
  if (priorityField.isIssueField) {
    throw new Error(`Project ${config.priorityField} 字段必须为 Project custom field`)
  }
  const startDateField = includeStartDate
    ? project.fields.nodes.find((field) => field?.name === config.startDateField)
    : null
  if (includeStartDate && !startDateField) {
    throw new Error(`Project 缺少 ${config.startDateField} 字段`)
  }
  if (startDateField && startDateField.dataType !== 'DATE') {
    throw new Error(`Project ${config.startDateField} 字段必须为 Date`)
  }
  if (startDateField?.isIssueField) {
    throw new Error(`Project ${config.startDateField} 字段必须为 Project Date 字段`)
  }
  const item = issue.projectItems.nodes.find((candidate) => candidate.project.id === project.id)
  const latestStatusEvent = issue.timelineItems?.nodes
    ?.filter((event) => event?.project?.id === project.id)
    .at(-1)
  const statusActor =
    latestStatusEvent && latestStatusEvent.status === item?.fieldValueByName?.name
      ? (latestStatusEvent.actor?.login ?? null)
      : null
  return { project, issue, statusField, priorityField, startDateField, item, statusActor }
}

/**
 * Read Project membership and add the Issue when absent.
 * @param {number} number Same-repository Issue number.
 * @param {boolean} includeStartDate Include and validate the Project Start Date field.
 * @returns {Promise<object>} Project context with an existing or newly added item.
 */
export async function ensureProjectItem(number, includeStartDate = false) {
  const context = await projectContext(number, false, includeStartDate)
  if (context.item) return context
  const data = await graphql(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
        item { id }
      }
    }`,
    { projectId: context.project.id, contentId: context.issue.id },
  )
  return {
    ...context,
    item: {
      id: data.addProjectV2ItemById.item.id,
      fieldValueByName: null,
      priorityValue: null,
      startDateValue: null,
    },
  }
}

/**
 * Initialize one Issue's Project Start Date when it is empty.
 * @param {number} number Same-repository Issue number.
 * @param {string} date Date in YYYY-MM-DD form.
 * @returns {Promise<void>} Resolves after the conditional Project update.
 */
export async function initializeIssueStartDate(number, date) {
  const context = await ensureProjectItem(number, true)
  if (context.item.startDateValue?.date) return
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: {date: $date}
      }) { projectV2Item { id } }
    }`,
    {
      projectId: context.project.id,
      itemId: context.item.id,
      fieldId: context.startDateField.id,
      date,
    },
  )
}

/**
 * Write the named Status option unless the supplied item already has it.
 * @param {object} context Project context with an item and Status options.
 * @param {string} status Configured Status option name.
 * @returns {Promise<void>} Resolves after the optional update; rejects an unknown option.
 */
export async function updateStatus(context, status) {
  const option = context.statusField.options.find((candidate) => candidate.name === status)
  if (!option) throw new Error(`Status 不存在：${status}`)
  if (context.item.fieldValueByName?.name === status) return
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: {singleSelectOptionId: $optionId}
      }) { projectV2Item { id } }
    }`,
    {
      projectId: context.project.id,
      itemId: context.item.id,
      fieldId: context.statusField.id,
      optionId: option.id,
    },
  )
}

/**
 * Ensure Project membership before updating an Issue’s Status.
 * @param {number} number Same-repository Issue number.
 * @param {string} status Configured Status option name.
 * @returns {Promise<void>} Resolves after membership and Status updates.
 */
export async function setStatus(number, status) {
  await updateStatus(await ensureProjectItem(number), status)
}
