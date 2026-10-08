// Parse our syntax before expanding variables. Source material stays literal.
export function parseAttachmentRegion(text) {
  const input = String(text);
  const tokens = [...input.matchAll(/\\?<\/?attachment>/g)];
  const literal = value => value.replace(/\\(<\/?attachment>)/g, '$1');
  const active = tokens.filter(match => !match[0].startsWith('\\'));
  if (!active.length) return { marked: false, before: '', material: literal(input), after: '' };
  if (active.length !== 2 || active[0][0] !== '<attachment>' || active[1][0] !== '</attachment>') {
    throw new Error('附件区域须为一对 <attachment>…</attachment>，不支持嵌套或多个区域。');
  }
  const [open, close] = active;
  const material = literal(input.slice(open.index + open[0].length, close.index));
  if (!material.trim()) throw new Error('附件区域不能为空，请填写变量或材料。');
  return { marked: true, before: literal(input.slice(0, open.index)), material, after: literal(input.slice(close.index + close[0].length)) };
}

// Older versions had no marker syntax; preserve every literal slash and tag.
export function escapeLegacyAttachmentMarkers(text) {
  return String(text).replace(/(\\*)<\/?attachment>/g, match => '\\' + match);
}

export function renderAttachmentDescription(block, description) {
  return block.regions.before + description + block.regions.after;
}
