/** Materialized only when the user opens the Factory's details. */
window.__ModuleLoader__.load({
  id: '@fixture/style-scope-addon', chunk: 'client.details.js', factory: () => ({}),
  meta: () => ({ stylesheets: { 'details.css': { text: () => '[data-style-probe] { outline-offset: 13px; }' } } }),
})
