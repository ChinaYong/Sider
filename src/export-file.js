export function downloadText(document, text, name, type = 'text/plain;charset=utf-8') {
  const view = document.defaultView;
  const url = view.URL.createObjectURL(new view.Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title, suffix = '.md') {
  const stem = String(title || '网页正文').replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 96).replace(/[. ]+$/g, '');
  return (stem || '网页正文') + suffix;
}
