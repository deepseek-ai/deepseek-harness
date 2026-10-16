/** Explain why retained debugging packages cannot enter either publication environment. */

/**
 * Return rebuilding instructions for debugging packages.
 * @param {string} qualification Recorded package qualification.
 * @returns {string | undefined} Diagnostic, or undefined for a non-debugging qualification.
 */
export function desktopPublishQualificationError(qualification) {
  const remedy = qualification === 'unsigned'
    ? '该包未签名（unsigned）。请重新运行 Windows 打包并选择 signing=signed。'
    : qualification === 'unnotarized'
      ? '该包跳过了公证（unnotarized）。请重新运行 macOS 打包，取消勾选“跳过公证”，完成公证和 stapling。'
      : undefined
  return remedy && `desktop publish: ${remedy}当前产物仅限内部调试，不能发布到 test 或 production，也不能用于自动更新。打包成功后使用新的 run ID / attempt 发布；重跑当前发布任务无效。`
}
