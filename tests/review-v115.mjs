import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:800,height:1067},hasTouch:true});
const checks=[];
async function check(name,fn){try{await fn();checks.push({name,ok:true});console.log('PASS '+name);}catch(e){checks.push({name,ok:false,error:e.message});console.log('FAIL '+name+': '+e.message);}}
async function settled(){await page.waitForFunction(()=>ReaderApp.state.route==='reader'&&!ReaderApp.state.busy&&!ReaderApp.state.opening&&!ReaderApp.state.turning);}
async function act(action,extra={}){await page.evaluate(({action,extra})=>{const b=document.createElement('button');b.dataset.action=action;Object.assign(b.dataset,extra);document.body.append(b);b.click();b.remove();},{action,extra});}
async function library(){await page.keyboard.press('Escape');if(await page.locator('#reader').count())await act('exit-reader');await page.waitForSelector('.library');}
async function openSample(){await library();await page.evaluate(()=>ReaderApp.openBook(ReaderApp.state.books.find(b=>b.title==='山间来信').id));await settled();}
try{
 await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6);
 await openSample();
 await check('Image viewer back closes only the viewer',async()=>{
  await page.evaluate(()=>ReaderApp.openImageViewer('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'));
  await page.keyboard.press('Escape');assert.equal(await page.locator('.image-viewer').count(),0);assert.equal(await page.locator('#reader').count(),1);
 });
 await openSample();
 await check('Cancelling selection removes the temporary highlight',async()=>{
  await page.evaluate(()=>ReaderApp.selectRange(0,8));assert.ok(await page.locator('.mark-preview').count());
  await act('cancel-selection');assert.equal(await page.locator('.mark-preview').count(),0);assert.equal(await page.evaluate(()=>ReaderApp.state.selected),null);
 });
 await openSample();
 await check('Applying a font-free theme clears the per-book custom font',async()=>{
  await act('typeset-mode',{value:'book'});await page.getByRole('dialog',{name:'阅读设置'}).waitFor();await page.keyboard.press('Escape');await settled();
  await page.evaluate(async()=>{ReaderApp.state.book.typeset.values.customFont='missing-font';ReaderApp.settings.customFont='missing-font';ReaderApp.saveThemes([{id:'plain',name:'普通',values:{size:25,font:'serif'}}]);await ReaderApp.applyThemeById('plain');});
  assert.equal(await page.evaluate(()=>ReaderApp.state.book.typeset.values.customFont||''),'');
 });
 await library();
 await page.locator('#file-picker').setInputFiles({name:'单段落.html',mimeType:'text/html',buffer:Buffer.from('<title>单段落</title><p>'+('长段落甲乙丙丁戊己庚辛壬癸。'.repeat(700))+'</p>')});
 await page.waitForFunction(()=>ReaderApp.state.books.some(b=>b.title==='单段落'));
 await page.evaluate(()=>ReaderApp.openBook(ReaderApp.state.books.find(b=>b.title==='单段落').id));await settled();
 await check('Cross-page extension handles a paragraph spanning many pages',async()=>{
  const expected=await page.evaluate(()=>{const p=ReaderApp.state.paginator;let i=0;while(i<p.length&&p.pageAt(i)<2)i++;return i;});
  await page.evaluate(()=>ReaderApp.selectRange(0,8));await act('extend-forward');await settled();
  const v=await page.evaluate(()=>({end:ReaderApp.state.selected?.end,page:ReaderApp.state.paginator.page}));assert.equal(v.page,1);assert.equal(v.end,expected);
 });
 await openSample();
 await check('A searched note returns to the same search results',async()=>{
  await page.evaluate(async()=>{const a=ReaderApp,b=a.state.book;b.notes.push({id:'return-note',chapter:0,start:1,end:9,text:a.state.doc.chapters[0].text.slice(1,9),note:'回归检索',created:1});await a.flush();});
  await act('note-search-open');await page.fill('#note-search-input','回归检索');await act('note-search-run');await page.locator('#note-search-results .search-result').click();await settled();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#note-search-input').inputValue(),'回归检索');assert.equal(await page.locator('#note-search-results .search-result').count(),1);
 });
 await library();
 await check('Deleted books disappear from the cached full-text index',async()=>{
  await page.evaluate(()=>ReaderApp.showLibrarySearch());await page.fill('#library-fulltext','长段落');await page.evaluate(()=>ReaderApp.runLibrarySearch());
  const id=await page.evaluate(()=>ReaderApp.state.books.find(b=>b.title==='单段落').id);await page.keyboard.press('Escape');
  await act('delete-book',{id});await act('confirm-delete');await page.waitForFunction(id=>!ReaderApp.state.books.some(b=>b.id===id),id);
  await page.evaluate(()=>ReaderApp.showLibrarySearch());await page.fill('#library-fulltext','长段落');await page.evaluate(()=>ReaderApp.runLibrarySearch());
  assert.equal(await page.evaluate(id=>ReaderApp.state.libraryResults.filter(r=>r.bookId===id).length,id),0);
 });
 await page.keyboard.press('Escape');
 await check('A text PDF is no longer incorrectly listed as unsupported in an empty search',async()=>{
  await page.evaluate(()=>ReaderApp.showLibrarySearch());await page.fill('#library-fulltext','zzzz-absent');await page.evaluate(()=>ReaderApp.runLibrarySearch());assert.doesNotMatch(await page.locator('#library-search-status').innerText(),/未索引/);
 });
}finally{await fs.mkdir('test-results/review-1.1.5',{recursive:true});await fs.writeFile('test-results/review-1.1.5/'+(process.env.BASELINE?'baseline-browser':'fixed-browser')+'.json',JSON.stringify(checks,null,2));await browser.close();}
if(checks.some(c=>!c.ok))process.exitCode=1;
