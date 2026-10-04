import { describe, expect, it } from 'vitest'
import { findAll, isUiElement, renderText, serializeTree, treeProblem, uiElements } from '../src/elements.ts'

describe('elements', () => {
  const { Box, Text, Button } = uiElements()

  it('builds frozen elements the host recognizes, and validates what a hook returns', () => {
    const text = Text({ color: 'yellow', bold: true, children: 'Clear' })
    expect(text).toMatchObject({ type: 'Text', props: { color: 'yellow', bold: true, children: 'Clear' } })
    expect(Object.isFrozen(text) && Object.isFrozen(text.props)).toBe(true)
    expect(isUiElement(text)).toBe(true)
    expect(isUiElement({ type: 'Text', props: {} })).toBe(false)
    expect(treeProblem(Box({ children: [text, 'plain', 3, null, undefined, false, [Button({ label: 'Go' })]] }))).toBeUndefined()
    expect(treeProblem({ type: 'Text', props: {} } as never)).toBe('a tree node is object, not an element, text, or a list of them')
    expect(treeProblem(Button({ label: 42 as never }))).toBe('a Button needs a string label')
    expect(treeProblem(Box({ children: Button({ label: 'x', onPress: 'nope' as never }) }))).toBe('a Button onPress must be a function')
    expect(treeProblem(null)).toBeUndefined()
  })

  it('serializes scalars and children, replacing each onPress with a held action id', () => {
    const held: (() => unknown)[] = []
    const onPress = (): void => {}
    const tree = Box({
      flexDirection: 'row', paddingX: 1, border: true,
      children: [Text({ dimColor: true, color: undefined, children: ['a', 'b'] }), Button({ label: 'Proceed', hotkey: '1', onPress }), Button({ label: 'Plain' }), '', 'tail'],
    })
    expect(serializeTree(tree, (callback) => { held.push(callback); return `action-${held.length}` })).toEqual([{
      type: 'Box',
      props: { flexDirection: 'row', paddingX: 1, border: true },
      children: [
        { type: 'Text', props: { dimColor: true }, children: ['a', 'b'] },
        { type: 'Button', props: { label: 'Proceed', hotkey: '1' }, children: [], actionId: 'action-1' },
        { type: 'Button', props: { label: 'Plain' }, children: [] },
        'tail',
      ],
    }])
    expect(held).toEqual([onPress])
  })

  it('finds elements by type, drawn text, and button label, and renders the drawn text', () => {
    const tree = [
      Box({ children: [Text({ children: '☀  Clear' }), Text({ children: '  18% of context' })] }),
      Box({ flexDirection: 'row', children: [Button({ label: 'Proceed', hotkey: '1' }), Button({ label: 'Cancel', hotkey: '2' })] }),
    ]
    expect(findAll(tree, { type: 'Text', text: /Clear/ }).map(element => element.props['children'])).toEqual(['☀  Clear'])
    expect(findAll(tree, { type: 'Text', text: '18%' })).toHaveLength(1)
    expect(findAll(tree, { label: /Cancel/ }).map(element => element.props['hotkey'])).toEqual(['2'])
    expect(findAll(tree, { type: 'Button', label: 'Proceed' })).toHaveLength(1)
    expect(findAll(tree, { type: 'Box' })).toHaveLength(2)
    expect(findAll(tree, { text: 'Clear' }).map(element => element.type)).toEqual(['Box', 'Text'])
    expect(renderText(tree)).toBe('☀  Clear  18% of context\nProceedCancel')
    expect(renderText('just text')).toBe('just text')
  })
})
