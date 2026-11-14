export const GEMINI_CATALOG_KEY = 'sider.geminiCatalog.v1';
export const GEMINI_CATALOG_ATTRIBUTE = 'data-sider-gemini-catalog';

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const LEGACY_LEVELS = Object.freeze({ low: 1, medium: 4, high: 2 });
const cleanText = (value, limit = 100) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';

export function isGeminiModelId(value) { return typeof value === 'string' && MODEL_ID.test(value); }
export function geminiModelValue(id) { return `id:${id}`; }
export function geminiModelId(value) { return typeof value === 'string' && value.startsWith('id:') && isGeminiModelId(value.slice(3)) ? value.slice(3) : null; }
export function geminiLevelNumber(value) {
  if (Object.hasOwn(LEGACY_LEVELS, value)) return LEGACY_LEVELS[value];
  if (typeof value !== 'string' || !/^level:[1-9]\d{0,3}$/.test(value)) return null;
  return Number(value.slice(6));
}

// Retained only to resolve settings saved before model IDs were available.
export function legacyGeminiFamily(value) {
  const text = String(value || '');
  if (/flash\s*[- ]?\s*lite/i.test(text)) return 'flash-lite';
  if (/\bflash\b/i.test(text)) return 'flash';
  if (/\bpro\b/i.test(text)) return 'pro';
  if (/\bargon\b/i.test(text)) return 'argon';
  return null;
}

export function resolveGeminiModel(models, selected) {
  const id = geminiModelId(selected);
  if (id) return models.find(model => model.id === id) || null;
  const unchanged = models.find(model => model.available && model.id === selected);
  if (unchanged) return unchanged;
  const matches = models.filter(model => model.available && legacyGeminiFamily(model.label) === selected);
  return matches.length === 1 ? matches[0] : null;
}

// This is metadata from the page, not a trusted configuration or account data.
export function validateGeminiCatalog(raw) {
  if (!raw || !Array.isArray(raw.models) || !raw.models.length || raw.models.length > 50) return null;
  const models = [], ids = new Set();
  for (const candidate of raw.models) {
    const id = candidate?.id, label = cleanText(candidate?.label);
    if (!isGeminiModelId(id) || !label || typeof candidate.available !== 'boolean' || ids.has(id)
      || !Array.isArray(candidate.levels) || candidate.levels.length > 20) return null;
    const levels = [], seen = new Set();
    for (const level of candidate.levels) {
      const label = cleanText(level?.label);
      if (!Number.isSafeInteger(level?.id) || level.id < 1 || level.id > 9999 || !label || seen.has(level.id)) return null;
      seen.add(level.id); levels.push({ id: level.id, label });
    }
    ids.add(id); models.push({ id, label, available: candidate.available, levels });
  }
  return { models };
}

function choiceLevels(choice) {
  const levels = [], seen = new Set();
  for (const item of Array.isArray(choice?.[1]) ? choice[1] : []) {
    const id = item?.[0], name = cleanText(item?.[1]), description = cleanText(item?.[2]);
    if (!Number.isSafeInteger(id) || id < 1 || id > 9999 || !name || seen.has(id)) continue;
    seen.add(id); levels.push({ id, label: description ? `${name}（${description}）` : name });
  }
  return levels;
}

export function geminiChoiceModelId(choice, bases) {
  const descriptor = choice?.[0];
  if (!Array.isArray(descriptor) || !Array.isArray(bases)) return null;
  const name = cleanText(descriptor[4]), category = descriptor[1], variant = descriptor[3];
  if (!name) return null;
  if (isGeminiModelId(variant)) return variant;
  if (isGeminiModelId(descriptor[0])) return descriptor[0];
  const matches = bases.filter(base => Array.isArray(base) && isGeminiModelId(base[0])
    && cleanText(base[1]).toLowerCase() === name.toLowerCase()
    && (category == null || base[17] == null || base[17] === category));
  return matches.length === 1 ? matches[0][0] : null;
}

// The live status contains base models and menu entries, including variants
// whose ID is the variant name and upgrade entries that are not selectable.
export function extractGeminiCatalog(data) {
  const bases = data?.[15], choices = data?.[24]?.[1];
  if (!Array.isArray(bases) || !Array.isArray(choices) || bases.length > 100 || choices.length > 100) return null;
  const models = [], seen = new Set();
  for (const choice of choices) {
    const descriptor = choice?.[0];
    if (!Array.isArray(descriptor) || !Array.isArray(choice?.[1])) continue;
    const surfaces = choice[3];
    if (Array.isArray(surfaces) && surfaces.length && !surfaces.includes(1)) continue;
    const name = cleanText(descriptor[4]);
    if (!name) continue;
    const id = geminiChoiceModelId(choice, bases);
    if (!id || seen.has(id)) continue;
    const base = bases.find(item => Array.isArray(item) && item[0] === id);
    const title = cleanText(descriptor[5]) || cleanText(base?.[2]) || name;
    const description = cleanText(descriptor[12]);
    const label = description && description !== title ? `${title}（${description}）` : title;
    const available = !descriptor[14];
    models.push({ id, label, available, levels: choiceLevels(choice) }); seen.add(id);
  }
  // Some models have no thinking menu at all. Preserve those base models
  // without inventing levels, but do not guess when an existing choice is
  // ambiguous or restricted to a different surface.
  for (const base of bases) {
    if (!Array.isArray(base) || !isGeminiModelId(base[0]) || seen.has(base[0])) continue;
    const name = cleanText(base[1]);
    if (!name || bases.filter(item => Array.isArray(item) && item[0] === base[0]).length !== 1) continue;
    if (choices.some(choice => Array.isArray(choice?.[0]) && cleanText(choice[0][4]).toLowerCase() === name.toLowerCase()
      && (choice[0][1] == null || base[17] == null || choice[0][1] === base[17]))) continue;
    const title = cleanText(base[2]) || name, description = cleanText(base[11]);
    models.push({ id: base[0], label: description && description !== title ? `${title}（${description}）` : title, available: true, levels: [] });
    seen.add(base[0]);
  }
  return validateGeminiCatalog({ models });
}
