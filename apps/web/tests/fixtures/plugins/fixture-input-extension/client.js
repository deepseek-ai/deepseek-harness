/** A published-protocol consumer of composer activities and bundle activation guidance. */
window.__ModuleLoader__.load({
  id: '@fixture/input-extension',
  factory(require) {
    const React = require('react')
    const { Button, Modal, IconApiOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const labels = {
          start: 'Input activity', cancel: 'Cancel activity', insert: 'Insert result', stale: 'Draft changed',
          setup: 'Input plugin setup', details: 'Open setup', later: 'Later', config: 'Input plugin configuration',
        }
        ctx.effect(() => ctx.locale.register('fixtureInput', { en: labels, zh: labels }))
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
          name: 'conversation.input.activity', locale: 'fixtureInput',
        }, ({ inputActions, onActiveChange, locked, t }) => {
          const [span, setSpan] = React.useState(null)
          const [stale, setStale] = React.useState(false)
          React.useEffect(() => () => onActiveChange(false), [onActiveChange])
          const close = () => { setSpan(null); setStale(false); onActiveChange(false) }
          return span === null
            ? h(Button, { disabled: locked, 'aria-label': t('start'), style: { width: 32, height: 32, padding: 0 }, onClick: () => {
              setSpan(inputActions.captureInsertion()); onActiveChange(true)
            } }, h(IconApiOutlineRegular, { size: 16 }))
            : h('div', null,
              h(Button, { onClick: close }, t('cancel')),
              h(Button, { onClick: () => {
                if (inputActions.insertText(' from plugin', span)) close()
                else setStale(true)
              } }, t('insert')),
              stale ? h('span', { role: 'status' }, t('stale')) : null)
        }))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@fixture/input-extension', locale: 'fixtureInput',
        }, ({ t }) => h('p', null, t('config'))))
        ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
          name: 'plugins.bundle.activation', key: '@fixture/input-extension', locale: 'fixtureInput',
        }, ({ onDismiss, onOpenDetails, t }) => h(Modal, {
          open: true, title: t('setup'), closeLabel: t('later'), onClose: onDismiss,
        }, h(Button, { onClick: onDismiss }, t('later')), h(Button, { onClick: onOpenDetails }, t('details')))))
      },
    }
  },
})
