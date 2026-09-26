/**
 * The task tab type's registry definition: the identity its body and title
 * register under, and the chip label it reads from the active locale.
 */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SCHEDULE_TASK_ID, SCHEDULE_TASK_KIND, scheduleTaskDefinition } from '../src/client/definition.ts'
import { en } from '../src/client/task-manager-locales.ts'

describe('scheduleTaskDefinition', () => {
  it('registers the builtin task type and names its chip through the bound translate', () => {
    const definition = scheduleTaskDefinition(makeTranslate(en))
    expect(definition.id).toBe(SCHEDULE_TASK_ID)
    expect(definition.kind).toBe(SCHEDULE_TASK_KIND)
    expect(definition.priority).toBe('builtin')
    expect(definition.title('schedule-task')).toBe(en['detail.label'])
  })
})
