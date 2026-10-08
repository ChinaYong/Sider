import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAttachmentRegion, renderAttachmentDescription, escapeLegacyAttachmentMarkers } from '../src/attachment-region.js';
import { presetTemplates, newTemplate, migrateUnifiedTemplates, validateTemplates, getTemplates, UNIFIED_TEMPLATES_KEY, LEGACY_UNIFIED_TEMPLATES_KEY } from '../src/prompt-templates.js';
import { expandTemplateItem, applyAttachmentFilename } from '../src/context.js';
import { validateConfiguration, configurationStorage, exportConfiguration } from '../src/configuration.js';

const context = { url: 'https://source.test/', title: '标题', attachments: { page: { url: 'https://source.test/', content: '<attachment>{{url}}</attachment> 原文尾标记', title: '标题' } } };
const item = patch => newTemplate({ id: 'region-preset-001', name: '总结', text: '总结网页。\n网页内容：<attachment>{{content}}</attachment>\n请用中文回答。', delivery: 'file', ...patch });

test('only the marked material is uploaded while instructions and file note keep their original position', () => {
  const block = expandTemplateItem(item(), context, { filename: '实际文件.txt' });
  assert.ok(block.text.startsWith('总结网页。\n网页内容：预设“总结”'));
  assert.ok(block.text.endsWith('\n请用中文回答。'));
  assert.ok(block.text.includes('实际文件.txt')); assert.ok(!block.text.includes('原文尾标记'));
  assert.ok(block.attachment.content.includes(context.attachments.page.content));
  assert.ok(!block.attachment.content.includes('总结网页。')); assert.ok(!block.attachment.content.includes('请用中文回答。'));
  assert.ok(block.attachment.content.includes('来源 URL：https://source.test/'));
  assert.equal(block.characterCount, context.attachments.page.content.length);
  assert.equal(renderAttachmentDescription(block, '实际名称说明'), '总结网页。\n网页内容：实际名称说明\n请用中文回答。');
});

test('auto threshold counts only expanded material and equality stays inline', () => {
  const a = item({ text: '指令'.repeat(3000) + '<attachment>{{title}}</attachment>结尾', delivery: 'auto', threshold: 2 });
  const inline = expandTemplateItem(a, context); assert.equal(inline.delivery, 'text'); assert.equal(inline.characterCount, 2);
  assert.equal(inline.text, '指令'.repeat(3000) + '标题结尾');
  const file = expandTemplateItem({ ...a, threshold: 1 }, context); assert.equal(file.delivery, 'file'); assert.equal(file.attachment.content, '标题');
});

test('upload and retry substitute only actual filename slots without re-expanding source values or time',()=>{
 const source={...context,title:'原始 {{filename}} 标题'}, now=new Date(2026,9,6,12,0,0);
 const block=expandTemplateItem(item({attachmentText:'{{title}} {{ filename }} {{datetime}}'}),source,{now});
 source.title='后来修改的标题';applyAttachmentFilename(block,'第一次.txt');applyAttachmentFilename(block,'重试.txt');
 assert.ok(block.text.includes('原始 {{filename}} 标题 重试.txt 2026-10-06 12:00:00'));assert.ok(!block.text.includes('后来修改'));assert.ok(!block.text.includes('第一次.txt'));
});

test('text mode strips syntax; raw source markers and variables are never parsed again', () => {
  const block = expandTemplateItem(item({ delivery: 'text' }), context);
  assert.equal(block.attachment, null); assert.ok(block.text.includes(context.attachments.page.content));
  assert.ok(!block.text.includes('<attachment><attachment>'));
  assert.ok(block.text.startsWith('总结网页。')); assert.ok(block.text.endsWith('请用中文回答。'));
});

test('unmarked fixed content still uploads as a complete item; auto fallback preserves all instructions', () => {
  assert.equal(expandTemplateItem(item({ text: '固定材料' }), context).attachment.content, '固定材料');
  const block = expandTemplateItem(item({ delivery: 'auto', threshold: 1 }), context, { supportsAttachments: false });
  assert.equal(block.delivery, 'text'); assert.ok(block.text.includes('总结网页。')); assert.ok(block.text.includes(context.attachments.page.content)); assert.ok(block.notice);
});

for (const text of ['<attachment>x', '</attachment>x', '<attachment></attachment>', '<attachment> \n </attachment>', '<attachment><attachment>x</attachment></attachment>', '<attachment>x</attachment><attachment>y</attachment>']) {
  test('invalid region is rejected before any expansion: ' + text, () => {
    assert.throws(() => validateTemplates([...presetTemplates(), item({ text })]), /附件区域/);
    assert.match(expandTemplateItem(item({ text }), context).errors[0], /附件区域/);
  });
}

test('literal marker escaping preserves existing slashes and old content', () => {
  for (const text of ['<attachment>{{title}}</attachment>', '\\<attachment>x\\</attachment>', '\\\\<attachment>x</attachment>']) {
    const parsed = parseAttachmentRegion(escapeLegacyAttachmentMarkers(text)); assert.equal(parsed.marked, false); assert.equal(parsed.material, text);
  }
  assert.equal(parseAttachmentRegion('\\<attachment>x\\</attachment>').material, '<attachment>x</attachment>');
});

const oldItems = () => presetTemplates().map((item, index) => ({ ...item, action: index ? 'fill' : 'attach', text: index === 2 ? '旧指令 <attachment>{{content}}</attachment>' : item.text }));
test('v2 migration preserves literal content, stable identities, order and attachment settings', () => {
  const old = oldItems(); old[2].threshold = 998; old[2].attachmentText = '旧说明 {{filename}}';
  const next = migrateUnifiedTemplates(old); assert.deepEqual(next.map(item => item.id), old.map(item => item.id));
  assert.ok(next.every(item => item.action === 'append')); assert.equal(next[2].threshold, 998); assert.equal(next[2].attachmentText, old[2].attachmentText);
  assert.ok(expandTemplateItem(next[2], context).content.includes('<attachment>' + context.attachments.page.content + '</attachment>'));
  assert.throws(() => validateTemplates(old), /点击行为/);
});

test('concurrent migration writes v3 once and never reads old archives as runtime settings again', async () => {
  const local = { [LEGACY_UNIFIED_TEMPLATES_KEY]: oldItems() }; let writes = 0;
  globalThis.chrome = { storage: { local: { async get(keys) { return Object.fromEntries(keys.map(key => [key, local[key]])); }, async set(value) { writes++; Object.assign(local, structuredClone(value)); } } } };
  const [a,b] = await Promise.all([getTemplates(),getTemplates()]); assert.deepEqual(a,b); assert.equal(writes,1);
  local[LEGACY_UNIFIED_TEMPLATES_KEY][0].name = '档案后来修改'; assert.deepEqual(await getTemplates(), a); assert.equal(writes,1);
  assert.ok(local[UNIFIED_TEMPLATES_KEY]); assert.equal(local[LEGACY_UNIFIED_TEMPLATES_KEY][0].action,'attach');
});

test('v2 backups convert to v3 and v3 keeps functional region syntax through a roundtrip', () => {
  const old = { format: 'sider-configuration', version: 2, configuration: { templates: oldItems(), aiWeb: { activeSiteId: 'chatgpt', customSites: [] }, enabledOrigins: [] } };
  const next = validateConfiguration(old); assert.equal(next.version,3); assert.equal(next.configuration.templates[0].action,'append');
  next.configuration.templates.push(item({ action:'replace' }));
  const restored = exportConfiguration(configurationStorage(next)); assert.deepEqual(restored.configuration,next.configuration); assert.equal(restored.version,3);
});
