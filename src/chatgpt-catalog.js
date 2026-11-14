export const CHATGPT_CATALOG_KEY = 'sider.chatgptCatalog.v1';
export const CHATGPT_CATALOG_ATTRIBUTE = 'data-sider-chatgpt-catalog';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const label = value => typeof value === 'string' && value.trim() && value.length <= 160 ? value.trim() : null;
export const isChatGPTId = value => typeof value === 'string' && ID.test(value);
export const chatgptModelValue = id => `version:${id}`;
export const chatgptModelId = value => typeof value === 'string' && value.startsWith('version:') && isChatGPTId(value.slice(8)) ? value.slice(8) : null;
export const chatgptPresetValue = preset => `preset:${preset.slug}:${preset.effort || ''}`;

export function chatgptPresetParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^preset:([a-zA-Z0-9][a-zA-Z0-9._-]{0,119}):([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})?$/.exec(value);
  return match ? { slug: match[1], effort: match[2] || null } : null;
}

// Only the public chat picker versions are exposed, not internal or Work models
// that may also appear in the account's model response.
export function extractChatGPTCatalog(data) {
  if (!data || !Array.isArray(data.versions) || !Array.isArray(data.models)
    || !data.versions.length || data.versions.length > 80 || data.models.length > 500) return null;
  const models = new Map();
  for (const model of data.models) {
    if (!isChatGPTId(model?.slug) || models.has(model.slug)) return null;
    models.set(model.slug, model);
  }
  const versions = [];
  const ids = new Set();
  for (const version of data.versions) {
    const name = label(version?.display_text_for_intelligence) || label(version?.display_text_full) || label(version?.display_text);
    if (!isChatGPTId(version?.id) || !name || ids.has(version.id)
      || !Array.isArray(version.slugs) || !Array.isArray(version.intelligence_presets)
      || version.slugs.length > 100 || version.intelligence_presets.length > 50) return null;
    ids.add(version.id);
    const presets = [], seen = new Set();
    for (const raw of version.intelligence_presets) {
      const slug = raw?.model_slug, effort = raw?.thinking_effort ?? null, name = label(raw?.title);
      if (!isChatGPTId(slug) || (effort !== null && !isChatGPTId(effort)) || !name) return null;
      const model = models.get(slug);
      if (!version.slugs.includes(slug) || !model || model.is_work_mode_model === true || (Array.isArray(model.tags) && model.tags.includes('hidden'))) continue;
      const value = chatgptPresetValue({ slug, effort });
      if (seen.has(value)) return null;
      seen.add(value);
      presets.push({ slug, effort, label: name, available: version.enabled === true && raw.preset_type === 'available' });
    }
    if (presets.length) versions.push({ id: version.id, label: name, available: version.enabled === true, presets });
  }
  return versions.length ? validateChatGPTCatalog({ versions }) : null;
}

export function validateChatGPTCatalog(raw) {
  if (!raw || !Array.isArray(raw.versions) || !raw.versions.length || raw.versions.length > 80) return null;
  const versions = [], ids = new Set();
  for (const candidate of raw.versions) {
    const name = label(candidate?.label);
    if (!isChatGPTId(candidate?.id) || !name || typeof candidate.available !== 'boolean' || ids.has(candidate.id)
      || !Array.isArray(candidate.presets) || !candidate.presets.length || candidate.presets.length > 50) return null;
    ids.add(candidate.id);
    const presets = [], seen = new Set();
    for (const preset of candidate.presets) {
      const name = label(preset?.label), effort = preset?.effort ?? null;
      if (!isChatGPTId(preset?.slug) || (effort !== null && !isChatGPTId(effort)) || !name || typeof preset.available !== 'boolean') return null;
      const value = chatgptPresetValue(preset);
      if (seen.has(value)) return null;
      seen.add(value);
      presets.push({ slug: preset.slug, effort, label: name, available: preset.available && candidate.available });
    }
    versions.push({ id: candidate.id, label: name, available: candidate.available, presets });
  }
  return { versions };
}
