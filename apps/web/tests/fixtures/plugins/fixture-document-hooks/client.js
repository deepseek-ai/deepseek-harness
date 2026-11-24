/** Slot consumer whose execution realm is distinct from the renderer mount document. */
window.__ModuleLoader__.load({
  id: '@fixture/document-hooks',
  meta() {
    return { stylesheets: { 'scope.css': { text: () => `
      [data-scope-probe] { --scope-answer: none; }
      @scope ([data-plugin="outer"]) to ([data-plugin]) {
        [data-scope-probe] { --scope-answer: outer; }
      }
      @scope ([data-plugin="inner"]) to ([data-plugin]) {
        [data-scope-probe] { --scope-answer: inner; }
      }
    ` } } }
  },
  factory(require) {
    const { createElement: h, useRef, useState } = require('react')

    function Probe({ useDocumentPortal, useDocumentViewport }) {
      const Portal = useDocumentPortal()
      const viewport = useDocumentViewport()
      const [saved, save] = useState(null)
      const [open, setOpen] = useState(true)
      const log = useRef(null)
      const record = (phase, event) => {
        const output = log.current
        const doc = output.ownerDocument
        if (event.key === 'q') {
          const target = event.currentTarget === doc ? 'document' : 'other'
          const type = event instanceof doc.defaultView.KeyboardEvent ? 'keyboard' : 'other'
          output.textContent += `${phase}:${event.eventPhase}:${target}:${type};`
        }
      }
      const sample = name => h('span', { 'data-scope-probe': name }, name)
      return h('section', { 'data-plugin': 'outer' },
        h('output', { 'data-viewport': '', 'data-saved': saved === null ? '' : String(saved === viewport) },
          `${viewport.width}x${viewport.height}`),
        h('button', { onClick: () => save(viewport) }, 'Remember viewport'),
        h('button', { onClick: () => setOpen(!open) }, open ? 'Close portal' : 'Open portal'),
        h('button', { onKeyDown: event => { if (event.key === 'q') log.current.textContent += 'target;' } }, 'Outside portal'),
        h('output', { ref: log, 'data-key-log': '' }),
        open && h('div', { 'data-plugin': 'inner' },
          h(Portal, {
            onKeyDownCapture: event => record('capture', event),
            onKeyDown: event => record('bubble', event),
          }, sample('owned'), h(Portal, null, sample('nested'))),
          h('div', { 'data-plugin': '' }, h(Portal, null, sample('empty')))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Boot has captured #root but has not mounted React. Only the mount moves; both plugins still execute here.
        ctx.effect(() => {
          const mount = document.getElementById('root')
          const frame = document.createElement('iframe')
          frame.title = 'Rendered document'
          frame.width = '960'
          frame.height = '640'
          mount.replaceWith(frame)
          frame.contentDocument.body.append(mount)
          return () => frame.replaceWith(mount)
        })
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'document-hooks' }, Probe))
      },
    }
  },
})
