const instanceId = crypto.randomUUID(), name = new URL(location.href).searchParams.get('name');
const site = new URL(location.href).searchParams.get('site'), frame = document.querySelector('iframe');
let ai = null;
function report() {
  chrome.runtime.sendMessage({ type: 'CARRIER_REPORT', instanceId, name, ai, visibility: document.visibilityState }).catch(() => {});
}
window.addEventListener('message', event => {
  if (!site || event.source !== frame.contentWindow || event.origin !== new URL(site).origin || event.data?.type !== 'AI_REPORT') return;
  ai = event.data.state; report();
});
document.addEventListener('visibilitychange', report);
chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'SEED_CARRIER' || message.instanceId !== instanceId || !site) return false;
  frame.contentWindow.postMessage({ type: 'SEED_AI', ...message.seed }, new URL(site).origin);
  return false;
});
if (site) frame.src = site;
report();
