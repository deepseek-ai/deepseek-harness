// @vitest-environment jsdom
/** Image capability defaults, explicit choices, and hidden model metadata. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelImageInput } from '../src/client/ModelImageInput.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe.each(['inputModalities', 'input'] as const)('%s image input', (field) => {
  it.each([
    [undefined, 'default'],
    [[], 'default'],
    [['text'], 'disabled'],
    [['text', 'image'], 'enabled'],
    [['image'], 'enabled'],
  ] as const)('displays %j without materializing an override', (modalities, selected) => {
    const onChange = vi.fn()
    render(<ModelImageInput model={{ id: 'preview', [field]: modalities }} field={field} position={2} disabled={false} t={key => en[key]} onChange={onChange} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: `${en.modelImageInput} 2` }).value).toBe(selected)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('enables images and keeps unrelated metadata', () => {
    const onChange = vi.fn()
    const model = { id: 'preview', contextWindow: 123456, systemPromptUpdate: 'in-history' }
    render(<ModelImageInput model={model} field={field} position={1} disabled={false} t={key => en[key]} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'enabled' } })
    expect(onChange).toHaveBeenCalledWith({ ...model, [field]: ['text', 'image'] })
    expect(model).not.toHaveProperty(field)
  })

  it.each(['disabled', 'default'])('selects %s without leaving invalid DeepSeek image limits', (choice) => {
    const onChange = vi.fn()
    const model = { id: 'vision', [field]: ['image'], description: 'kept', imagePixelBudget: 'low', imageMaxBytes: 12345 }
    render(<ModelImageInput model={model} field={field} position={1} disabled={false} t={key => en[key]} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: choice } })
    expect(onChange).toHaveBeenCalledWith({
      id: 'vision', description: 'kept',
      ...choice === 'disabled' ? { [field]: ['text'] } : {},
      ...field === 'input' ? { imagePixelBudget: 'low', imageMaxBytes: 12345 } : {},
    })
    expect(model[field]).toEqual(['image'])
  })

  it('disables the selector while read-only or saving', () => {
    render(<ModelImageInput model={{ id: 'preview' }} field={field} position={1} disabled t={key => en[key]} onChange={vi.fn()} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true)
  })
})
