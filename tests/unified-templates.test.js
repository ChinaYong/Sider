import test from 'node:test';
import assert from 'node:assert/strict';
import { presetTemplates, newTemplate, migrateTemplates, validateTemplates, getTemplates, UNIFIED_TEMPLATES_KEY, PROMPT_TEMPLATES_KEY, PRESET_IDS } from '../src/prompt-templates.js';
import { composeTemplatePrompt, expandTemplateItem, normalizeContextSettings, CONTEXT_SETTINGS_KEY } from '../src/context.js';
import { validateConfiguration, exportConfiguration, configurationStorage } from '../src/configuration.js';
import { TemplateDraft } from '../src/content/template-draft.js';

const context = () => ({ tabId: 1, url: 'https://example.test/', title: '标题', selection: { url: 'https://example.test/', content: '长选区'.repeat(8000), context: '附近原文'.repeat(6000) },
  attachments: { page: { url: 'https://example.test/', content: '# 正文\n包含 {{url}}\n尾标记', capturedAt: '2026-10-06T00:00:00Z', metadata: { author: '作者' } } }, templateSelections: {}, explicitTemplates: [] });
const item = patch => newTemplate({ id: 'custom-template-001', name: '自建预设', text: '固定文本', ...patch });

test('migration preserves each old format, default, position, file note, and direct action', () => {
 const settings = normalizeContextSettings({ defaultUrl: true, defaultSelection: false, pageMode: 'file', pageThreshold: 999, pageTemplate: '正文 {{content}}', pageAttachmentTemplate: '读 {{filename}}', selectionPosition: 'append' });
 const templates = migrateTemplates(settings, [{ id: 'old-template-001', name: '旧提问', text: '{{url}}', directSend: true }]);
 assert.equal(templates[0].position, 'append'); assert.equal(templates[0].defaultIncluded, false); assert.equal(templates[1].defaultIncluded, true);
 assert.equal(templates[2].delivery, 'file'); assert.equal(templates[2].threshold, 999); assert.equal(templates[2].attachmentText, '读 {{filename}}'); assert.equal(templates[3].action, 'send');
 assert.equal(templates[3].position, 'append'); assert.equal(templates[3].defaultIncluded, false);
});
test('concurrent first reads migrate once, preserve archives, and ignore old keys afterwards', async () => {
 const local = { [CONTEXT_SETTINGS_KEY]: { defaultUrl: true }, [PROMPT_TEMPLATES_KEY]: [] }; let writes = 0;
 globalThis.chrome = { storage: { local: { async get(keys) { return Object.fromEntries(keys.map(key => [key, local[key]])); }, async set(update) { writes++; Object.assign(local, structuredClone(update)); } } } };
 const [a, b] = await Promise.all([getTemplates(), getTemplates()]); assert.deepEqual(a, b); assert.equal(writes, 1);
 local[CONTEXT_SETTINGS_KEY].defaultUrl = false; assert.equal((await getTemplates())[1].defaultIncluded, true); assert.equal(writes, 1);
 assert.deepEqual(local[PROMPT_TEMPLATES_KEY], []); assert.ok(local[UNIFIED_TEMPLATES_KEY]);
});
test('malformed new storage is rejected without repairing or overwriting it', async () => {
 let writes = 0; globalThis.chrome = { storage: { local: { async get() { return { [UNIFIED_TEMPLATES_KEY]: [] }; }, async set() { writes++; } } } };
 await assert.rejects(getTemplates(), /三条/); assert.equal(writes, 0);
});
test('preset identities cannot disappear, change, or be occupied by custom items', () => {
 assert.throws(() => validateTemplates(presetTemplates().slice(1)), /三条/);
 const items = presetTemplates(); items[0].preset = null; assert.throws(() => validateTemplates(items), /身份/);
 assert.throws(() => validateTemplates([...presetTemplates(), item({ id: PRESET_IDS.url })]), /ID/);
});
test('position and order are shared by all action types', () => {
 const a = item({ id: 'custom-template-001', position: 'prepend', text: '前一', action: 'send' });
 const b = item({ id: 'custom-template-002', position: 'prepend', text: '前二', action: 'append' });
 const c = item({ id: 'custom-template-003', text: '后一' });
 const ctx = context(); ctx.templateSelections = { [a.id]: true, [b.id]: true, [c.id]: true };
 assert.equal(composeTemplatePrompt('问题', [a,b,c], ctx).text, '前一\n\n前二\n\n问题\n\n后一');
 assert.equal(composeTemplatePrompt('问题', [b,a,c], ctx).text, '前二\n\n前一\n\n问题\n\n后一');
});
test('empty drafts can be sent by an explicit template but empty final messages fail', () => {
 const ctx = context(), template = item();
 assert.equal(composeTemplatePrompt('', [template], ctx, { explicitId: template.id }).text, '固定文本');
 assert.deepEqual(composeTemplatePrompt('', [template], ctx, { explicitId: template.id }).errors, []);
 assert.ok(composeTemplatePrompt('', [], ctx).errors.length);
});
test('same-ID explicit and snapshot precedence never remove distinct templates', () => {
 const ctx = context(), a = item({ text: '{{content}}' }), b = item({ id: 'custom-template-002', text: '{{content}}' });
 ctx.templateSelections = { [a.id]: true, [b.id]: true };
 const compiled = composeTemplatePrompt('问题', [a,b], ctx, { explicitId: a.id }); assert.equal(compiled.blocks.length, 2);
 assert.equal(composeTemplatePrompt('已追加内容', [a,b], ctx, { explicitId: a.id, snapshots: [{ id: a.id }] }).blocks.length, 1);
});
test('automatic selection dependencies wait, while explicit choices fail if selection is absent', () => {
 const ctx = context(); ctx.selection = null; const a = item({ text: '{{selection}}' }); ctx.templateSelections[a.id] = true;
 const waiting = composeTemplatePrompt('问题', [a], ctx); assert.deepEqual(waiting.waiting, [a.id]); assert.deepEqual(waiting.errors, []);
 assert.match(composeTemplatePrompt('问题', [a], ctx, { explicitId: a.id }).errors[0], /selection/);
 ctx.explicitTemplates = [a.id]; assert.deepEqual(composeTemplatePrompt('问题', [a], ctx).waiting, [a.id]);
});
test('threshold uses the individual expanded text, with strict greater-than and no question budget', () => {
 const ctx = context(), a = item({ text: '{{title}}', delivery: 'auto', threshold: 2 });
 assert.equal(expandTemplateItem(a, ctx).delivery, 'text'); a.threshold = 1; assert.equal(expandTemplateItem(a, ctx).delivery, 'file');
 ctx.templateSelections[a.id] = true; a.threshold = 2; assert.equal(composeTemplatePrompt('很长的问题'.repeat(10000), [a], ctx).attachments.length, 0);
});

test('default items with selection-dependent file notes wait, while explicit use identifies the missing note variable', () => {
 const ctx = context(); ctx.selection = null;
 const a = item({ delivery: 'file', attachmentText: '{{selection.context}} {{filename}}' }); ctx.templateSelections[a.id] = true;
 const automatic = composeTemplatePrompt('问题', [a], ctx); assert.deepEqual(automatic.waiting, [a.id]); assert.equal(automatic.attachments.length, 0);
 assert.match(composeTemplatePrompt('问题', [a], ctx, { explicitId: a.id }).errors[0], /selection.context/);
});
for (const text of ['{{selection}}', '{{selection.context}}', '{{context}}', '固定内容'.repeat(3000)]) test('long non-body template can upload: ' + text.slice(0, 30), () => {
 const block = expandTemplateItem(item({ text, delivery: 'auto' }), context()); assert.equal(block.delivery, 'file'); assert.ok(block.attachment.content.length > 10000);
});
test('one time snapshot and single-pass variables remain fixed when substituting actual filenames', () => {
 const ctx = context(); const now = new Date(2026, 9, 6, 12, 34, 56);
 const a = item({ text: '{{content}}\n{{datetime}}', delivery: 'file', attachmentText: '{{template.name}} {{filename}} {{datetime}}' });
 const block = expandTemplateItem(a, ctx, { now }); assert.ok(block.content.includes('{{url}}')); assert.ok(block.content.includes('2026-10-06 12:34:56'));
 assert.equal(block.text, '自建预设 自建预设-预设.txt 2026-10-06 12:34:56');
});
test('each file has a separate explanation and remains at its own configured position', () => {
 const ctx = context(), a = item({ delivery: 'file', position: 'prepend' }), b = item({ id: 'custom-template-002', name: '第二项', delivery: 'file', attachmentText: '读《{{filename}}》' });
 ctx.templateSelections = { [a.id]: true, [b.id]: true }; const result = composeTemplatePrompt('问题', [a,b], ctx);
 assert.equal(result.attachments.length, 2); assert.ok(result.text.startsWith('预设“自建预设”')); assert.ok(result.text.endsWith('读《第二项-预设.txt》'));
});
test('unsupported uploads fall back only in auto mode, with full content and a notice', () => {
 const a = item({ text: '全文'.repeat(9000), delivery: 'auto' });
 const block = expandTemplateItem(a, context(), { supportsAttachments: false }); assert.equal(block.text, a.text); assert.ok(block.notice); assert.equal(block.attachment, null);
 a.delivery = 'file'; assert.match(expandTemplateItem(a, context(), { supportsAttachments: false }).errors[0], /尚未支持附件/);
});
test('source mismatch and expanded content overflow never silently truncate', () => {
 const ctx = context(); ctx.attachments.page.url = 'https://other.test/'; assert.match(expandTemplateItem(item({ text: '{{content}}' }), ctx).errors[0], /来源/);
 ctx.selection.content = 'x'.repeat(1000001); assert.match(expandTemplateItem(item({ text: '{{selection}}' }), ctx).errors[0], /100 万/);
});
test('file descriptions reject body variables but unused text-mode descriptions survive', () => {
 const items = [...presetTemplates(), item({ attachmentText: '{{content}}' })]; assert.equal(validateTemplates(items).length, 4);
 items[3].delivery = 'file'; assert.throws(() => validateTemplates(items), /附件说明/);
});
test('draft ranges shift around outside edits and become protected after edits inside a block', () => {
 const ledger = new TemplateDraft(), editor = {}; ledger.reset(editor, 'session', '前\n预设\n后'); ledger.add({ id: 'one' }, 2, '预设');
 ledger.reconcile('新增前\n预设\n后', editor, 'session'); assert.equal(ledger.removable('one', ledger.text).start, 4);
 ledger.reconcile('新增前\n模改板\n后', editor, 'session'); assert.throws(() => ledger.removable('one', ledger.text), /已被编辑/);
 ledger.reconcile('', editor, 'session'); assert.equal(ledger.records.size, 0);
});
test('draft records disappear when the native editor or session changes', () => {
 const ledger = new TemplateDraft(), editor = {}; ledger.reset(editor, 'a', '预设'); ledger.add({ id: 'one' }, 0, '预设');
 ledger.reconcile('新草稿', editor, 'b'); assert.equal(ledger.records.size, 0);
});
test('version 1 backup imports into version 3 with complete replacement and archives excluded', () => {
 const old = { format: 'sider-configuration', version: 1, configuration: { references: normalizeContextSettings(), aiWeb: { activeSiteId: 'chatgpt', customSites: [] }, templates: [{ id: 'legacy-template-001', name: '旧预设', text: '{{url}}', directSend: false }], enabledOrigins: [] } };
 const backup = validateConfiguration(old); assert.equal(backup.version, 3); assert.equal(backup.configuration.templates.length, 4);
 const stored = configurationStorage(backup); assert.equal(Object.hasOwn(stored, CONTEXT_SETTINGS_KEY), false); assert.deepEqual(exportConfiguration(stored).configuration, backup.configuration);
 assert.throws(() => validateConfiguration({ ...old, configuration: { ...old.configuration, references: {} } }), /缺失/);
});
