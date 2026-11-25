/** An unscoped sidebar layer calls another package's Factory and fills its list. */
window.__ModuleLoader__.load({
  id: '@fixture/style-scope-global',
  meta: () => ({ stylesheets: { 'global.css': { text: () => '[data-style-probe] { padding-left: 7px; }' } } }),
  factory(require) {
    const { createElement: h, Fragment, useState } = require('react')
    function Outer({ children, renderFactorySlot }) {
      return h(Fragment, null, children,
        h('div', { 'data-style-probe': 'outer' }, renderFactorySlot('fixture.styleScope.panel', {})))
    }
    function Inner() {
      const [count, setCount] = useState(0)
      return h('button', {
        type: 'button', 'data-style-probe': 'inner', onClick: () => setCount(value => value + 1),
      }, count)
    }
    return {
      inject: ['slots', 'modules'],
      apply(ctx) {
        ctx.effect(() => {
          Object.defineProperty(window, '__styleScopeGraph', { configurable: true, get: () => ctx.modules.manifest.rev })
          return () => { delete window.__styleScopeGraph }
        })
        ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
          name: 'sidebar.session.action', id: 'style-scope',
        }, Outer))
        ctx.slots.inject('fixture.styleScope.rows', () => ctx.slots.register({
          name: 'fixture.styleScope.rows', id: 'inner',
        }, Inner))
      },
    }
  },
})
