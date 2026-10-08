/** Track only blocks we wrote. Edits inside a block make it user-owned. */
export class TemplateDraft {
  constructor() { this.records = new Map(); this.text = ''; this.editor = null; this.session = null; }
  reset(editor, session, text = '') { this.records.clear(); this.editor = editor; this.session = session; this.text = text; }
  reconcile(text, editor, session) {
    if (editor !== this.editor || session !== this.session || !text.trim()) { this.reset(editor, session, text); return; }
    const previous = this.text;
    if (previous === text) return;
    let from = 0;
    while (from < previous.length && from < text.length && previous[from] === text[from]) from++;
    let oldEnd = previous.length, newEnd = text.length;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
    const delta = newEnd - oldEnd;
    for (const record of this.records.values()) {
      if (oldEnd <= record.start && !(from === oldEnd && from > record.start && from < record.end)) { record.start += delta; record.end += delta; }
      else if (from < record.end && oldEnd > record.start || from === oldEnd && from > record.start && from < record.end) record.edited = true;
    }
    this.text = text;
  }
  removable(id, text) {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.edited || text.slice(record.start, record.end) !== record.block) throw new Error('这条预设的写入内容已被编辑，草稿已保留。请先移除该快照再重试。');
    return record;
  }
  /** Our known edit has exact offsets; repeated text must not confuse diffing. */
  applyEdit(start, end, replacement) {
    const delta = replacement.length - (end - start);
    for (const record of this.records.values()) {
      if (record.start >= end) { record.start += delta; record.end += delta; }
      else if (record.end > start) record.edited = true;
    }
    this.text = this.text.slice(0, start) + replacement + this.text.slice(end);
  }
  add(record, start, block) { this.records.set(record.id, { ...record, start, end: start + block.length, block, edited: false }); }
  snapshots() { return [...this.records.values()]; }
}
