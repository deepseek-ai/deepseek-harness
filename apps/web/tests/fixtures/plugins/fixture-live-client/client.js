/** Test package using the published registration protocol, locale and slots. */
window.__ModuleLoader__.load({
  id: '@fixture/live-client',
  factory(require) {
    const React = require('react')
    const style = document.createElement('style')
    style.dataset.plugin = '@fixture/live-client'
    style.textContent = '[data-live-client] { color: rgb(12, 34, 56); position: absolute; bottom: 20px; right: 20px; }'
    document.head.append(style)
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const counters = document.documentElement.dataset
        counters.liveMounts = String(Number(counters.liveMounts ?? 0) + 1)
        ctx.effect(() => ctx.locale.register('fixtureLive', { zh: { active: '动态插件已启用' }, en: { active: 'Live plugin enabled' } }))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'fixture-live-client', locale: 'fixtureLive',
        }, ({ t }) => React.createElement('div', { 'data-live-client': '' }, t('active'))))
        ctx.effect(() => {
          const ping = () => { counters.liveHits = String(Number(counters.liveHits ?? 0) + 1) }
          window.addEventListener('dsh-fixture-ping', ping)
          return async () => {
            window.removeEventListener('dsh-fixture-ping', ping)
            await Promise.resolve()
            counters.liveDisposals = String(Number(counters.liveDisposals ?? 0) + 1)
          }
        })
      },
    }
  },
})
