/** Future cross-tab preset contract; not wired into the current composer. */
function identity(source) {
  if (!Number.isSafeInteger(source?.tabId) || source.tabId < 0) throw new Error('Snapshot requires a source tab.');
  let url; try { url = new URL(source.url); } catch { throw new Error('Snapshot requires a source URL.'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Snapshot requires an HTTP(S) source.');
  return { tabId: source.tabId, url: url.href };
}

/** Re-append matching uses the preset and source; ownership uses snapshotId. */
export function presetSourceKey(templateId, source) {
  if (typeof templateId !== 'string' || !templateId) throw new Error('Snapshot requires a preset ID.');
  const { tabId, url } = identity(source);
  return JSON.stringify([templateId, tabId, url]);
}

export function createPresetSnapshotIdentity(templateId, source, snapshotId) {
  if (typeof snapshotId !== 'string' || !snapshotId) throw new Error('Snapshot requires an independent snapshot ID.');
  const normalized = identity(source);
  return { id: snapshotId, templateId, source: { ...normalized, title: String(source.title || ''), version: source.version },
    sourceKey: presetSourceKey(templateId, normalized), attachmentId: snapshotId };
}

/** Only current-source snapshots may suppress current-source preset expansion. */
export function currentSourcePresetIds(snapshots, source) {
  let normalized; try { normalized = identity(source); } catch { return new Set(); }
  return new Set(snapshots.filter(snapshot => snapshot.sourceKey === presetSourceKey(snapshot.templateId, normalized))
    .map(snapshot => snapshot.templateId));
}

export function captureSourceToken(sessionId, source) {
  if (typeof sessionId !== 'string' || !sessionId || source?.available !== true
    || !Number.isSafeInteger(source.version) || source.version < 0
    || !Number.isSafeInteger(source.epoch) || source.epoch < 0) throw new Error('No confirmed readable source binding.');
  return { sessionId, ...identity(source), version: source.version, epoch: source.epoch };
}

export function isSourceTokenCurrent(token, sessionId, source) {
  try {
    const current = captureSourceToken(sessionId, source);
    return ['sessionId', 'tabId', 'url', 'version', 'epoch'].every(key => token?.[key] === current[key]);
  } catch { return false; }
}
