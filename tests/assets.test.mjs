import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

test('Packaged CSP allows the bundled WebAssembly decoders',async()=>{
  const html=await readFile('web/index.html','utf8');
  assert.match(html,/script-src[^;]*'wasm-unsafe-eval'/, 'CSP must permit WebAssembly, otherwise the shipped wasm/ directory is dead weight');
  assert.match(html,/default-src 'self'/, 'remote resources stay blocked');
  assert.match(html,/object-src 'none'/, 'plugins stay blocked');
});

test('Page-turn styling keeps a single live implementation',async()=>{
  const css=await readFile('web/style.css','utf8');
  for(const name of ['turn-ghost','@keyframes next','@keyframes prev','@keyframes flash','preview-page']) assert.ok(!css.includes(name),`dead CSS still present: ${name}`);
  assert.ok(css.includes('.paper-clear'),'the live page-turn layer is still styled');
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length,'unbalanced CSS braces');
  assert.equal(css.split('@media(max-width:550px)').length-1,1,'small-screen media query is not duplicated');
  assert.equal(css.split(':root{').length-1,1,'root variables are declared once');
});

test('Bundled fonts are woff2 only',async()=>{
  let files;
  try { files=await readdir('app/src/main/assets/web/fonts'); } catch { return; }
  assert.ok(files.length>0,'font assets were built');
  const legacy=files.filter(name=>name.endsWith('.woff'));
  assert.deepEqual(legacy,[],'woff fallbacks should not be packaged');
});
