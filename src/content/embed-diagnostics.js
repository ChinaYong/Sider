import { installEmbedDiagnostics } from '../embed-diagnostics.js';

if (!globalThis.__siderEmbedDiagnosticsInstalled) {
  globalThis.__siderEmbedDiagnosticsInstalled = true;
  installEmbedDiagnostics({ window, chrome });
}
