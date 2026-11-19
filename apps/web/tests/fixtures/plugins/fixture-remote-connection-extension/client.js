/** Additive settings using the shared invitation and component-local display preference. */
window.__ModuleLoader__.load({
  id: '@fixture/remote-connection-extension',
  factory(require) {
    const { createElement: h, useState } = require('react')
    const { Button, Checkbox } = require('@deepseek-ai/dsh-client-ui-primitives')
    const stylesheet = `
      .remoteOptions_card {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-width: 0;
        box-sizing: border-box;
        padding: 16px;
        border: 0.5px solid var(--dsw-alias-settings-card-stroke);
        border-radius: var(--dsw-radius-xl);
        background: var(--dsw-alias-settings-card-fill);
        color: var(--dsw-alias-label-primary);
      }
      .remoteOptions_header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        min-width: 0;
      }
      .remoteOptions_title {
        margin: 0;
        font-size: 14px;
        line-height: 22px;
        font-weight: 500;
      }
      .remoteOptions_option {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .remoteOptions_card .remoteOptions_checkbox {
        align-items: flex-start;
        font-size: 13px;
        line-height: 20px;
      }
      .remoteOptions_checkbox input { margin-top: 2px; }
      .remoteOptions_description {
        margin: 0 0 0 22px;
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        line-height: 20px;
        overflow-wrap: anywhere;
      }
      .remoteOptions_details {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: baseline;
        gap: 8px 16px;
        margin: 0;
        font-size: 13px;
        line-height: 20px;
      }
      .remoteOptions_details dt { color: var(--dsw-alias-label-secondary); }
      .remoteOptions_details dd { min-width: 0; margin: 0; }
      .remoteOptions_details code {
        font-size: 12px;
        line-height: 20px;
        overflow-wrap: anywhere;
      }
    `

    function Extension({ t, useRemoteConnection, reload }) {
      const [details, setDetails] = useState(false)
      const { phase, ticket } = useRemoteConnection(state => state)
      const busy = phase === 'loading' || phase === 'creating' || phase === 'cancelling'
      return h('section', { className: 'remoteOptions_card', 'aria-label': t('title') },
        h('header', { className: 'remoteOptions_header' },
          h('h3', { className: 'remoteOptions_title' }, t('title')),
          h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: reload }, t('reload'))),
        h('div', { className: 'remoteOptions_option' },
          h(Checkbox, { className: 'remoteOptions_checkbox', checked: details, onChange: setDetails, label: t('details') }),
          h('p', { className: 'remoteOptions_description' }, t('description'))),
        details ? h('dl', { className: 'remoteOptions_details' },
          h('dt', null, t('phase')),
          h('dd', null, h('span', { role: 'status' }, t(phase))),
          h('dt', null, t('invitationLabel')),
          h('dd', null, h('code', null, h('output', { 'aria-label': t('invitation') }, ticket?.id ?? t('none'))))) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@fixture/remote-connection-extension'
          style.textContent = stylesheet
          document.head.append(style)
          return () => style.remove()
        })
        ctx.effect(() => ctx.locale.register('fixtureRemoteConnectionExtension', {
          zh: {
            title: '连接选项', details: '显示邀请详情', description: '在此浏览器查看当前邀请的状态和编号',
            invitationLabel: '邀请编号', none: '暂无邀请',
            invitation: '附加选项中的邀请编号', phase: '邀请状态', reload: '刷新连接状态',
            loading: '正在读取', ready: '尚未创建', creating: '正在创建', pending: '等待扫码', cancelling: '正在取消',
            used: '已使用', expired: '已过期', cancelled: '已取消', replaced: '已替换', error: '读取失败',
          },
          en: {
            title: 'Remote connection options', details: 'Show invitation details', description: 'View the current invitation status and ID in this browser',
            invitationLabel: 'Invitation ID', none: 'No invitation',
            invitation: 'Invitation ID in additional options', phase: 'Invitation state', reload: 'Refresh connection status',
            loading: 'Loading', ready: 'Not created', creating: 'Creating', pending: 'Waiting for scan', cancelling: 'Cancelling',
            used: 'Used', expired: 'Expired', cancelled: 'Cancelled', replaced: 'Replaced', error: 'Read failed',
          },
        }))
        ctx.slots.inject('settings.remoteConnection.extensions', () => ctx.slots.register({
          name: 'settings.remoteConnection.extensions', id: 'invitation-details',
          order: 10, locale: 'fixtureRemoteConnectionExtension',
        }, Extension))
      },
    }
  },
})
