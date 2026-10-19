/**
 * Web-search settings page, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the page
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. The `web`, `web-search-deepseek`, and `web-deepseek-api`
 * namespaces the page edits are registered by their plugins, so this package
 * registers no namespace of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
