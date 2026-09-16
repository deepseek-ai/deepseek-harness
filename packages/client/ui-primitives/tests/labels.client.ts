import type {
  DiffBlockLabels,
  JsonTreeLabels,
  MarkdownLabels,
  ReadBlockLabels,
  SearchBlockLabels,
  TerminalBlockLabels,
  WebBlockLabels,
} from '../src/index.ts'

export const markdownLabels: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '复制成功' },
  footnotes: 'Footnotes',
}

export const diffBlockLabels: DiffBlockLabels = {
  copy: '复制', copied: '复制成功', collapseAria: '收起差异',
  expandAria: hidden => `展开其余 ${hidden} 行差异`,
  collapse: '收起', expand: hidden => `… 其余 ${hidden} 行`,
  files: count => `${count} ${count === 1 ? 'file' : 'files'}`,
}

export const readBlockLabels: ReadBlockLabels = {
  window: (shown, total) => `显示 ${shown} / ${total} 行`,
  copy: '复制', copied: '复制成功', collapseAria: '收起内容',
  expandAria: hidden => `展开其余 ${hidden} 行`,
  collapse: '收起', expand: hidden => `… 其余 ${hidden} 行`,
}

export const searchBlockLabels: SearchBlockLabels = {
  pathsSummary: (shown, total, truncated) => truncated
    ? `显示 ${shown} / 共 ${total} 个路径`
    : `${shown} 个路径`,
  matchesSummary: (shown, total, files, truncated) => truncated
    ? `显示 ${shown} / 共 ${total} 处匹配 · ${files} 个文件`
    : `${shown} 处匹配 · ${files} 个文件`,
  copy: '复制', copied: '复制成功', noResults: '无结果',
  collapseAria: '收起结果',
  expandAria: hidden => `展开其余 ${hidden} 行结果`,
  collapse: '收起', expand: hidden => `… 其余 ${hidden} 行`,
}

export const terminalBlockLabels: TerminalBlockLabels = {
  signal: signal => `信号 ${signal}`,
  exitCode: code => `退出码 ${code}`,
  noExitCode: '未正常退出',
  running: '运行中', failed: '失败', done: '已完成',
  copy: '复制', copied: '复制成功', noOutput: '无输出',
  collapseAria: '收起输出', collapse: '收起',
  expandAria: hidden => `展开其余 ${hidden} 行输出`,
  expand: hidden => `… 其余 ${hidden} 行`,
}

export const jsonTreeLabels: JsonTreeLabels = {
  copyValue: 'Copy value', copyJson: 'Copy JSON', copyPath: 'Copy property path',
  copyPrettyJson: 'Copy pretty JSON', copyCompactJson: 'Copy compact JSON',
  copied: 'Copied', copyFailed: 'Copy failed',
  collapseNode: 'Collapse JSON node', expandNode: 'Expand JSON node',
  copyButtonTitle: action => `${action}; right-click for copy options`,
}

export const webBlockLabels: WebBlockLabels = {
  noResults: '未找到结果', sourcesTruncated: '来源列表已截断',
  http: 'HTTP', contentTruncated: '内容已截断', markdown: markdownLabels,
}
