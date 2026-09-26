/** Operator-controlled qualification using the real workspace; synthetic payloads never execute. */
import { app, BrowserWindow, Menu, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Keep the private workspace open until the operator closes the control window or exits the application.
 * @param {object} options Real workspace and fixture-owned delivery, task, and installation controls.
 * @returns {Promise<void>} Resolves after operator exit and removal of control listeners.
 */
export async function runInteractiveUpdates({ mainWindow, server, fixture, checkMenu, control, root }) {
  const panel = new BrowserWindow({ title: '本地升级验收控制', width: 640, height: 460,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  const finished = Promise.withResolvers()
  const finish = () => finished.resolve()
  panel.once('closed', finish)
  app.once('before-quit', finish)
  let closing = false
  const originalInstall = fixture.updater.quitAndInstall
  fixture.updater.quitAndInstall = (...args) => {
    fixture.installations.push(args)
    void dialog.showMessageBox(panel, { type: 'info', title: '本地验收结束',
      message: '已完成下载、校验、安装确认和任务收尾。',
      detail: '安装器调用已拦截，未安装或重启到新版本。确认后退出本轮演练；重新运行命令可开始下一轮。',
      buttons: ['结束演练'] }).then(finish).catch(finish)
  }
  const action = (label, operation) => ({ label, click: () => {
    if (closing) return
    void Promise.resolve().then(operation).catch(error => {
      console.error(error)
      if (!panel.isDestroyed()) dialog.showErrorBox('本地验收操作失败', String(error))
    })
  } })
  const select = mode => server.select(mode, '0.1.6-nightly.1')
  select('hold-download')
  const check = () => checkMenu.click()
  panel.setMenu(Menu.buildFromTemplate([
    { label: '更新场景', submenu: [
      action('普通更新（点击下载后保持进度）', () => { server.policy('clear'); select('hold-download'); check() }),
      action('强制更新（点击下载后保持进度）', () => { server.policy('force'); select('hold-download'); check() }),
      action('放行当前下载 → 校验与安装确认', () => server.release()),
      { type: 'separator' },
      action('下一次下载：校验失败', () => select('corrupt')),
      action('下一次下载：404 失败', () => select('download-404')),
      action('下一次下载：恢复正常', () => select('healthy')),
      action('检查失败', () => { select('feed-404'); check() }),
      action('没有可用更新（未下载前使用）', () => { server.select('healthy', '0.1.5-rc.1'); check() }),
      action('解除强更阻塞', () => { server.policy('clear'); check() }),
    ] },
    { label: '任务状态', submenu: [
      action('添加排队任务', () => control('queue')),
      action('清空排队任务', () => control('clear')),
      action('模拟任务停止失败（本轮有效）', () => control('hold-shutdown')),
    ] },
    { label: '窗口', submenu: [
      action('返回应用', () => { mainWindow.restore(); mainWindow.show(); mainWindow.focus() }),
      action('结束演练', finish),
    ] },
  ]))
  try {
    await panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN">
      <meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>body{font:16px/1.8 system-ui;padding:24px;color:#222}h2{margin-top:0}strong{color:#165dff}</style>
      <h2>手动升级验收 · 不执行安装器</h2>
      <p>使用本窗口顶部的<strong>更新场景</strong>菜单选择普通更新或强制更新，再到应用里点击下载。</p>
      <p>下载会保持进度，供你查看。回到这里选择<strong>放行当前下载</strong>，才会进入校验和安装确认。</p>
      <p>用<strong>任务状态</strong>菜单添加排队任务，查看安装前的任务警告。失败模式须在下载前选择。</p>
      <p>数据和更新服务器均为本地隔离测试。下载地址为示例地址。关闭此窗口结束演练；重跑命令重置状态。</p>
      </html>`)}`)
    console.log(`Interactive updater ready: ${root}`)
    await finished.promise
    closing = true
    await writeFile(join(root, 'interactive-result.json'), JSON.stringify({ installerExecuted: false,
      interceptedInstallations: fixture.installations.length, phases: fixture.states.map(state => state.phase) }, null, 2) + '\n')
  } finally {
    closing = true
    fixture.updater.quitAndInstall = originalInstall
    app.off('before-quit', finish)
    panel.off('closed', finish)
    if (!panel.isDestroyed()) panel.destroy()
  }
}
