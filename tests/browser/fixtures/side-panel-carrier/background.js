globalThis.carrierProbe = { events: [], documents: {}, activationAttempt: null, attemptOnActivation: false };
chrome.sidePanel.onOpened.addListener(info => carrierProbe.events.push({ type: 'opened', ...info, at: Date.now() }));
chrome.sidePanel.onClosed.addListener(info => carrierProbe.events.push({ type: 'closed', ...info, at: Date.now() }));
chrome.tabs.onActivated.addListener(info => {
  carrierProbe.events.push({ type: 'activated', ...info, at: Date.now() });
  if (!carrierProbe.attemptOnActivation) return;
  carrierProbe.attemptOnActivation = false;
  chrome.sidePanel.open({ windowId: info.windowId }).then(() => {
    carrierProbe.activationAttempt = { ok: true, ...info };
  }).catch(error => { carrierProbe.activationAttempt = { ok: false, error: error.message, ...info }; });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'CARRIER_REPORT') {
    const previous = carrierProbe.documents[message.instanceId];
    carrierProbe.documents[message.instanceId] = { ...message, documentId: previous?.documentId, documentUrl: sender.url };
    // Extension-page MessageSender omits documentId in Chromium. Correlate the
    // new fixture instance with the as-yet-unclaimed native SIDE_PANEL context.
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).then(contexts => {
      const claimed = new Set(Object.values(carrierProbe.documents).map(value => value.documentId).filter(Boolean));
      const candidates = contexts.filter(context => context.documentUrl === sender.url && !claimed.has(context.documentId));
      if (!carrierProbe.documents[message.instanceId].documentId && candidates.length === 1)
        carrierProbe.documents[message.instanceId].documentId = candidates[0].documentId;
      respond({ ok: true });
    });
    return true;
  }
  // Call within the genuine extension button gesture, before unrelated awaits.
  const action = {
    OPEN_GLOBAL: () => chrome.sidePanel.open({ windowId: message.windowId }),
    OPEN_TAB: () => chrome.sidePanel.open({ tabId: message.tabId }),
    CLOSE_GLOBAL: () => chrome.sidePanel.close({ windowId: message.windowId }),
    CLOSE_TAB: () => chrome.sidePanel.close({ tabId: message.tabId }),
  }[message.type];
  if (!action) return false;
  action().then(() => respond({ ok: true })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
