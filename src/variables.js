// One registry drives parsing, validation, and the visible variable directory.
const all = ['reference', 'shortcut', 'attachment'];
export const VARIABLES = Object.freeze([
  { name: 'url', description: '来源网页地址', example: 'https://example.com/article', places: all, requirement: '无需开启 URL 引用', timing: '展开时的当前来源' },
  { name: 'title', description: '来源网页标题', example: '一篇文章', places: all, requirement: '来源网页须有标题', timing: '展开时的当前来源' },
  { name: 'url.host', description: '来源网址的主机名', example: 'example.com', places: all, requirement: '有效来源 URL', timing: '展开时的当前来源' },
  { name: 'selection', description: '当前划词', example: '选中的词', places: all, requirement: '先在来源网页划词；引用关闭时仍可使用当前缓存', timing: '展开时的划词缓存' },
  { name: 'selection.context', description: '划词附近原文', example: '包含选中词的段落', places: all, requirement: '须采集到划词附近原文', timing: '展开时的划词缓存' },
  { name: 'context', alias: 'selection.context', description: '划词附近原文的兼容别名', example: '包含选中词的段落', places: all, requirement: '同 selection.context', timing: '展开时的划词缓存' },
  { name: 'date', description: '本机日期', example: '2026-10-05', places: all, requirement: '本机时区', timing: '展开时刻，YYYY-MM-DD' },
  { name: 'time', description: '本机时间', example: '14:05:09', places: all, requirement: '本机时区', timing: '展开时刻，HH:mm:ss' },
  { name: 'datetime', description: '本机日期时间', example: '2026-10-05 14:05:09', places: all, requirement: '本机时区', timing: '展开时刻，YYYY-MM-DD HH:mm:ss' },
  { name: 'page.author', description: '正文作者', example: '张三', page: true, places: all, requirement: '页面须提供作者；快捷预设按需采集，不启用正文引用', timing: '正文快照的元信息' },
  { name: 'page.publishedAt', description: '正文发布时间', example: '2026-10-01', page: true, places: all, requirement: '页面须提供发布时间', timing: '正文快照的元信息' },
  { name: 'page.capturedAt', description: '正文采集时间', example: '2026-10-05T06:05:09Z', page: true, places: all, requirement: '须取得正文快照', timing: '正文快照记录的采集时刻' },
  { name: 'content', description: '完整 Markdown 正文', example: '# 文章标题\n完整原文', page: true, places: ['reference', 'shortcut'], requirement: '引用格式使用已引用正文；快捷预设按需采集，不启用正文引用', timing: '追加时快照；后续手动发送不重写已追加的原文' },
  { name: 'page.content', alias: 'content', description: '完整正文的别名', example: '# 文章标题\n完整原文', page: true, places: ['reference', 'shortcut'], requirement: '同 content', timing: '同 content' },
  { name: 'filename', description: '实际附件文件名', example: '资料-预设-sider-1234567890abcdef.txt', places: ['attachment'], requirement: '仅附件说明可用，生成附件前无值', timing: '附件生成时' },
  { name: 'template.name', description: '当前预设名称', example: '网页正文', places: ['shortcut', 'reference', 'attachment'], requirement: '正在展开的预设', timing: '本次操作使用的预设名称' },
].map(Object.freeze));

export function variablesIn(text) { return [...String(text).matchAll(/\{\{([^{}]*)\}\}/g)].map(match => match[1].trim()); }
export function needsPageVariables(text) { return variablesIn(text).some(name => VARIABLES.find(item => item.name === name)?.page); }
export function hasInlinePage(text) { return variablesIn(text).some(name => ['content', 'page.content'].includes(name)); }
export function needsSelectionVariables(text) { return variablesIn(text).some(name => ['selection', 'selection.context', 'context'].includes(name)); }
export function needsTemplateSelection(template) { return needsSelectionVariables(template.text) || template.delivery !== 'text' && needsSelectionVariables(template.attachmentText); }
export function validateVariables(text, place = 'shortcut') {
  return [...new Set(variablesIn(text).filter(name => !VARIABLES.some(item => item.name === name && item.places.includes(place))))];
}

export function expandVariables(text, context, { page = context?.attachments?.page, filename, templateName, now = new Date(), place = 'shortcut' } = {}) {
  const pad = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let host; try { host = new URL(context?.url).hostname; } catch {}
  const values = { url: context?.url, title: context?.title, 'url.host': host, selection: context?.selection?.content,
    'selection.context': context?.selection?.context, context: context?.selection?.context,
    date, time, datetime: `${date} ${time}`, content: page?.content, 'page.content': page?.content,
    'page.author': page?.metadata?.author, 'page.publishedAt': page?.metadata?.publishedAt, 'page.capturedAt': page?.capturedAt, filename, 'template.name': templateName };
  const errors = [];
  const expanded = String(text).replace(/\{\{([^{}]*)\}\}/g, (token, expression) => {
    const name = expression.trim(); const variable = VARIABLES.find(item => item.name === name && item.places.includes(place));
    if (!variable) { errors.push(`未知变量 {{${name}}}，请查看全部变量并修改。`); return token; }
    const value = values[name];
    if (value === undefined || !String(value).trim()) { errors.push(`变量 {{${name}}} 缺少内容：${variable.requirement}。`); return token; }
    return String(value);
  });
  return { text: expanded, errors: [...new Set(errors)] };
}
