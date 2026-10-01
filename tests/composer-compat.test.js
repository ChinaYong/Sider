import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findComposer, fillComposer } from '../src/content/composer.js';

function page(html) {
  const dom = new JSDOM(html, { url: 'https://chatgpt.com/', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getClientRects = function() { return this.isConnected ? [{}] : []; };
  return dom;
}

test('the current ChatGPT home textarea is supported before the main composer hydrates', async () => {
  const dom = page('<div><textarea id="pending-home-input" aria-label="Ask ChatGPT"></textarea></div>');
  const result = await fillComposer(dom.window.document, '第一行\n第二行');
  assert.equal(result.ok, true);
  assert.equal(dom.window.document.querySelector('textarea').value, '第一行\n第二行');
  dom.window.close();
});

test('a composer body can identify a textbox without a prompt-textarea ID', () => {
  const dom = page('<div data-composer-body><div contenteditable="true" role="textbox">草稿</div></div>');
  assert.equal(findComposer(dom.window.document)?.textContent, '草稿');
  dom.window.close();
});

test('the fallback rejects ambiguous textboxes instead of editing an arbitrary field', () => {
  const dom = page('<div contenteditable="true" role="textbox"></div><div contenteditable="true" role="textbox"></div>');
  assert.equal(findComposer(dom.window.document), null);
  dom.window.close();
});
