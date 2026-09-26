// @vitest-environment jsdom
/** Input-type defaults, nonempty selections, and hidden model metadata. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelInputTypes } from '../src/client/ModelInputTypes.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe.each(['inputModalities', 'input'] as const)('%s input types', (field) => {
  it('edits the inherited selection without losing its image capability', () => {
    const onChange = vi.fn()
    render(<ModelInputTypes
      model={{ id: 'vision' }} field={field} position={1} fallback={['text', 'image']}
      disabled={false} t={key => en[key]} onChange={onChange}
    />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.modelInputText }))
    expect(onChange).toHaveBeenCalledWith({ id: 'vision', [field]: ['image'] })
  })

  it.each([
    [undefined, true, false],
    [[], true, false],
    [['text'], true, false],
    [['text', 'image'], true, true],
    [['image'], false, true],
  ] as const)('displays %j without materializing an override', (modalities, text, image) => {
    const onChange = vi.fn()
    render(<ModelInputTypes model={{ id: 'preview', [field]: modalities }} field={field} position={2} disabled={false} t={key => en[key]} onChange={onChange} />)
    expect(screen.getByRole('group', { name: `${en.modelInputTypes} 2` })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText }).checked).toBe(text)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(image)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('enables images and keeps unrelated metadata', () => {
    const onChange = vi.fn()
    const model = { id: 'preview', contextWindow: 123456, systemPromptUpdate: 'in-history' }
    render(<ModelInputTypes model={model} field={field} position={1} disabled={false} t={key => en[key]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: en.modelInputImage }))
    expect(onChange).toHaveBeenCalledWith({ ...model, [field]: ['text', 'image'] })
    expect(model).not.toHaveProperty(field)
  })

  it('removes DeepSeek image limits when images are unchecked', () => {
    const onChange = vi.fn()
    const model = { id: 'vision', [field]: ['text', 'image'], description: 'kept', imagePixelBudget: 'low', imageMaxBytes: 12345 }
    render(<ModelInputTypes model={model} field={field} position={1} disabled={false} t={key => en[key]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: en.modelInputImage }))
    expect(onChange).toHaveBeenCalledWith({
      id: 'vision', description: 'kept', [field]: ['text'],
      ...field === 'input' ? { imagePixelBudget: 'low', imageMaxBytes: 12345 } : {},
    })
    expect(model[field]).toEqual(['text', 'image'])
  })

  it('allows image-only input without discarding image limits', () => {
    const onChange = vi.fn()
    const model = { id: 'vision', [field]: ['text', 'image'], imagePixelBudget: 'low' }
    render(<ModelInputTypes model={model} field={field} position={1} disabled={false} t={key => en[key]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: en.modelInputText }))
    expect(onChange).toHaveBeenCalledWith({ ...model, [field]: ['image'] })
  })

  it.each(['text', 'image'])('keeps the last selected type %s', (modality) => {
    const onChange = vi.fn()
    render(<ModelInputTypes model={{ id: 'preview', [field]: [modality] }} field={field} position={1} disabled={false} t={key => en[key]} onChange={onChange} />)
    const selected = screen.getByRole<HTMLInputElement>('checkbox', { checked: true })
    expect(selected.disabled).toBe(true)
    selected.click()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables both checkboxes while read-only or saving', () => {
    const onChange = vi.fn()
    render(<ModelInputTypes model={{ id: 'preview', [field]: ['text', 'image'] }} field={field} position={1} disabled t={key => en[key]} onChange={onChange} />)
    for (const checkbox of screen.getAllByRole<HTMLInputElement>('checkbox')) {
      expect(checkbox.disabled).toBe(true)
      checkbox.click()
    }
    expect(onChange).not.toHaveBeenCalled()
  })
})
