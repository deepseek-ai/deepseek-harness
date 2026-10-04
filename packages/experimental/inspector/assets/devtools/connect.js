/** Select the authenticated Inspector connection relative to this deployed frontend entry. */
const entry = new URL(window.location.href)
if (entry.searchParams.get('disableLocaleInfoBar') === 'true') {
  window.localStorage.setItem('disable-locale-info-bar', 'true')
}
if (!entry.searchParams.has('ws') && !entry.searchParams.has('wss')) {
  const endpoint = new URL('cdp', entry)
  for (const sourceId of entry.searchParams.getAll('clientSourceId')) endpoint.searchParams.append('clientSourceId', sourceId)
  entry.searchParams.set(entry.protocol === 'https:' ? 'wss' : 'ws', endpoint.host + endpoint.pathname + endpoint.search)
}
if (!entry.searchParams.has('panel')) entry.searchParams.set('panel', 'console')
window.history.replaceState(window.history.state, '', entry)
