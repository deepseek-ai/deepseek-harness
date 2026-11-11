/**
 * Client half of the forge extension fixture: the title of the Host lens, and notes pinned through every forge slot —
 * a comment form action pins a line note, a file menu row pins a file note, each note shows as a line annotation, a
 * toolbar toggle hides them, and a card button opens the change request's changes view with the lens chosen.
 */
window.__ModuleLoader__.load({
  id: '@fixture/forge-extension',
  factory(require) {
    const React = require('react')
    const { Button, MenuItemButton, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'fixtureForge'
    return {
      inject: ['slots', 'locale', 'forgeChanges'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            lens: '导出', pin: '钉为笔记', pinFile: '钉上文件笔记', fileNote: '已看过此文件', notes: '笔记 {count}', toggle: '显示或隐藏笔记',
            note: '笔记', remove: '移除', open: '打开导出视图',
          },
          en: {
            lens: 'Exports', pin: 'Pin as note', pinFile: 'Pin a file note', fileNote: 'Looked at this file', notes: 'Notes {count}',
            toggle: 'Show or hide notes', note: 'Note', remove: 'Remove', open: 'Open the exports view',
          },
        }))
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.forgeChanges.describeLens({ id: 'fixture/exports', title: () => t('lens') }))

        // Notes of each changes view by address; the observable a view reads publishes nothing while its notes hide.
        const views = new Map()
        let sequence = 0
        const viewOf = (target) => {
          const address = ctx.forgeChanges.address(target)
          let view = views.get(address)
          if (view === undefined) {
            const listeners = new Set()
            const state = { notes: [], shown: true, snapshot: new Map() }
            const publish = () => {
              const byPath = new Map()
              if (state.shown) {
                for (const note of state.notes) byPath.set(note.path, [...(byPath.get(note.path) ?? []), note.annotation])
              }
              state.snapshot = byPath
              for (const listener of [...listeners]) listener()
            }
            view = {
              state,
              observable: {
                getSnapshot: () => state.snapshot,
                subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
              },
              add(path, place, text) {
                sequence += 1
                state.notes = [...state.notes, { path, text, annotation: { key: `note-${sequence}`, place, version: 1 } }]
                publish()
              },
              remove(key) {
                state.notes = state.notes.filter(note => note.annotation.key !== key)
                publish()
              },
              toggle() {
                state.shown = !state.shown
                publish()
              },
              textOf: key => state.notes.find(note => note.annotation.key === key)?.text ?? '',
              listeners,
            }
            views.set(address, view)
          }
          return view
        }
        ctx.effect(() => ctx.forgeChanges.registerAnnotations({ id: 'fixture-notes', observe: target => viewOf(target).observable }))

        function useNotes(target) {
          const view = viewOf(target)
          React.useSyncExternalStore(view.observable.subscribe, view.observable.getSnapshot)
          return view
        }
        function NotesToggle({ target, form, close }) {
          const view = useNotes(target)
          const label = t('notes', { count: view.state.notes.length })
          if (form === 'menu') return h(MenuItemButton, { onSelect: () => { view.toggle(); close() } }, label)
          return h(Tooltip, { label: t('toggle'), side: 'bottom' },
            h('button', { type: 'button', 'data-fixture-notes-toggle': '', 'aria-pressed': view.state.shown, onClick: () => { view.toggle() },
              style: { height: 28, padding: '0 8px', border: 0, borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' } }, label))
        }
        function PinNote({ target, selection, empty, busy, send }) {
          return h(Button, { size: 'sm', variant: 'outline', disabled: empty || busy, 'data-fixture-pin': '',
            onClick: () => { send(async (body) => { viewOf(target).add(selection.path, { side: selection.side, startLine: selection.startLine, endLine: selection.endLine }, body); return undefined }) } },
          t('pin'))
        }
        function NoteBody({ target, annotation }) {
          const view = useNotes(target)
          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }, 'data-fixture-note': annotation.key },
            h('strong', { style: { fontWeight: 500 } }, t('note')),
            h('span', { style: { flex: 1, minWidth: 0 } }, view.textOf(annotation.key)),
            h(Button, { size: 'sm', variant: 'outline', onClick: () => { view.remove(annotation.key) } }, t('remove')))
        }
        function PinFileNote({ target, file, dismiss }) {
          return h(MenuItemButton, { onSelect: () => { viewOf(target).add(file.path, 'file', t('fileNote')); dismiss() } }, t('pinFile'))
        }
        function OpenExports({ url, ref, sessionId }) {
          if (ref === null) return null
          return h(Tooltip, { label: t('open'), side: 'top' },
            h('button', { type: 'button', 'aria-label': t('open'), 'data-fixture-open-exports': '',
              onClick: () => { ctx.forgeChanges.open({ sessionId, source: { kind: 'change', url } }, { lens: 'fixture/exports' }) },
              style: { width: 24, height: 24, border: 0, borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '⎇'))
        }
        ctx.slots.inject('forge.changes.toolbar', () => ctx.slots.register({ name: 'forge.changes.toolbar', id: 'fixture-notes', locale: NS }, NotesToggle))
        ctx.slots.inject('forge.diff.comment.actions', () => ctx.slots.register({ name: 'forge.diff.comment.actions', id: 'fixture-notes', locale: NS }, PinNote))
        ctx.slots.inject('forge.diff.line.annotation', () => ctx.slots.register({ name: 'forge.diff.line.annotation', key: 'fixture-notes', locale: NS }, NoteBody))
        ctx.slots.inject('forge.changes.file.menu', () => ctx.slots.register({ name: 'forge.changes.file.menu', id: 'fixture-notes', locale: NS }, PinFileNote))
        ctx.slots.inject('forge.change-request.card.actions', () => ctx.slots.register({ name: 'forge.change-request.card.actions', id: 'fixture-notes', locale: NS }, OpenExports))
      },
    }
  },
})
