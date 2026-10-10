window.probeConfig = {};
window.probeResult = null;
for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => {
  window.probeResult = null;
  chrome.runtime.sendMessage({ type: button.dataset.operation, ...window.probeConfig }).then(result => {
    window.probeResult = result;
  });
});
