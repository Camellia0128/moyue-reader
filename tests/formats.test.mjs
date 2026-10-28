import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, decodeText, extractDoc } from '../web/formats.js';
import { makeLegacyDoc } from '../scripts/samples.mjs';
import { readFile } from 'node:fs/promises';
test('EPUB relative resource paths preserve book root and Unicode',()=>{
  assert.equal(resolvePath('OEBPS/Text/ch1.xhtml','../Images/cover.png'),'OEBPS/Images/cover.png');
  assert.equal(resolvePath('OEBPS/nav.xhtml','Text/%E5%B1%B1.xhtml#part'),'OEBPS/Text/山.xhtml');
  assert.throws(()=>resolvePath('book.xhtml','../../outside'));
});
test('Chinese plain text supports UTF-8, UTF-16 and legacy GBK',()=>{
  assert.equal(decodeText(new TextEncoder().encode('山间来信')),'山间来信');
  assert.equal(decodeText(Uint8Array.from([255,254,113,92,244,149])),'山间');
  assert.equal(decodeText(Uint8Array.from([0xd6,0xd0,0xce,0xc4])),'中文');
});
test('Word 97 piece table extracts actual Chinese text and paragraph boundaries',()=>{
  const text='这是一份旧版 Word 文档。\r第二段有 English 和数字 123。\r';
  assert.equal(extractDoc(new Uint8Array(makeLegacyDoc(text))),text.replaceAll('\r','\n'));
});
test('Invalid legacy Word file fails instead of displaying binary data',()=>{
  assert.throws(()=>extractDoc(new TextEncoder().encode('not a Word document')));
});
test('Real Apache POI Word document extracts paragraphs from independently produced data',async()=>{
  const bytes=await readFile(new URL('./fixtures/apache-sample.doc',import.meta.url));
  const text=extractDoc(new Uint8Array(bytes));
  assert.ok(text.includes('I am a test document'));
  assert.ok(text.includes('This is page two'));
  assert.ok(text.includes('Arial Black'));
});
