/** The selected package owns the Factory body, not its list occupants. */
window.__ModuleLoader__.load({
  id: '@fixture/style-scope-addon',
  meta: () => ({ stylesheets: { 'addon.css': {
    text: () => '[data-style-probe] { margin-left: 23px; } :scope[data-slot-factory] [data-style-same] { scroll-margin-right: 9px; }',
  } } }),
  factory(require) {
    const { createElement: h } = require('react')
    function Panel({ renderSlot }) {
      return h('div', { 'data-style-probe': 'middle' }, renderSlot('fixture.styleScope.rows', {}),
        renderSlot('fixture.styleScope.same', {}))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        // A derived plugin can share the page's slots without seeing its modules service.
        const slots = ctx.isolate('modules').slots
        slots.registerFactory({
          name: 'fixture.styleScope.panel', scope: 'root',
          children: {
            'fixture.styleScope.rows': { kind: 'list', scope: 'root' }, 'fixture.styleScope.same': { kind: 'single', scope: 'root' },
          },
        }, Panel)
        slots.register({ name: 'fixture.styleScope.same' }, () => h('button', {
          'data-style-same': '', onClick: () => require.async('./client.details.js'),
        }, 'Load details'))
      },
    }
  },
})
