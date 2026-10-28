import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const checks=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function context(){const c=await browser.newContext({viewport:{width:800,height:1067}});const p=await c.newPage();await p.goto('http://127.0.0.1:4173');await p.waitForFunction(()=>window.ReaderApp?.state.books.length===6);return{c,p};}
async function alter(p,store,operation){await p.evaluate(async({store,operation})=>{const db=await new Promise((r,j)=>{const o=indexedDB.open('moyue-reader');o.onsuccess=()=>r(o.result);o.onerror=()=>j(o.error);});const book=window.ReaderApp.state.books.find(b=>b.kind==='pdf');await new Promise((r,j)=>{const tx=db.transaction(store,'readwrite'),s=tx.objectStore(store);if(operation==='corrupt')s.put({id:book.id,blob:new Blob(['%PDF-1.7\nnot a valid document'])});else if(operation==='delete')s.delete(book.id);tx.oncomplete=r;tx.onerror=()=>j(tx.error);});db.close();},{store,operation});}
try{
 {
  const{c,p}=await context();await alter(p,'originals','corrupt');await p.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await p.getByRole('dialog',{name:'未能打开 PDF'}).waitFor();
  assert.equal(await p.locator('#reader').count(),0);assert.equal(await p.locator('.library').count(),1);assert.equal(await p.evaluate(()=>window.ReaderApp.state.busy),false);assert.equal(await p.evaluate(()=>localStorage.getItem('moyue-route')),'library');pass('PDF opening failure immediately restores a usable library instead of a blank reader');
  await p.getByRole('button',{name:'返回首页',exact:true}).click();await p.waitForSelector('.home-title');pass('Failure dialog has a working explicit Home action');
  await p.reload();await p.waitForSelector('.library');assert.equal(await p.getByRole('dialog').count(),0);assert.equal(await p.evaluate(()=>localStorage.getItem('moyue-opening')),null);pass('Restart after failure never auto-opens the failed PDF or repeats its error');
  await p.getByRole('button',{name:'阅读 山间来信',exact:true}).click();await p.waitForSelector('#flow p');await p.waitForFunction(()=>!window.ReaderApp.state.busy);pass('Other books still open after the PDF error');await c.close();
 }
 {
  const{c,p}=await context();await alter(p,'originals','corrupt');await p.evaluate(()=>{const b=window.ReaderApp.state.books.find(b=>b.kind==='pdf');localStorage.setItem('moyue-current',b.id);localStorage.setItem('moyue-route','reader');});await p.reload();await p.getByRole('dialog',{name:'未能打开 PDF'}).waitFor();await p.getByRole('button',{name:'返回书库',exact:true}).click();await p.reload();await p.waitForSelector('.library');assert.equal(await p.getByRole('dialog').count(),0);pass('Existing 1.0.0 resume state recovers automatically without clearing any app data');await c.close();
 }
 {
  const{c,p}=await context();await alter(p,'originals','delete');await p.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await p.getByRole('dialog',{name:'未能打开 PDF'}).waitFor();assert.ok((await p.locator('.error-detail').first().textContent()).includes('未找到应用内的 PDF 文件副本'));await p.getByRole('button',{name:'返回书库',exact:true}).click();assert.equal(await p.locator('.book-card').count(),6);pass('Missing original file is diagnosed and does not trap navigation');await c.close();
 }
 {
  const{c,p}=await context();await alter(p,'documents','delete');await p.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await p.getByRole('dialog',{name:'未能打开 PDF'}).waitFor();await p.getByRole('button',{name:'返回首页',exact:true}).click();await p.waitForSelector('.home-title');pass('Missing document metadata before reader creation also recovers safely');await c.close();
 }
 {
  const{c,p}=await context();await p.evaluate(()=>{const b=window.ReaderApp.state.books.find(b=>b.kind==='pdf');localStorage.setItem('moyue-current',b.id);localStorage.setItem('moyue-route','reader');localStorage.setItem('moyue-opening',JSON.stringify({id:b.id,time:Date.now()}));});await p.reload();await p.waitForSelector('.library');assert.equal(await p.locator('#reader').count(),0);assert.equal(await p.getByRole('dialog').count(),0);pass('A previous crash or force-stop while opening is quarantined on the next launch');await c.close();
 }
 {
  const{c,p}=await context();await p.evaluate(async()=>{window.Android={beginPdf:()=> 'slow-session',appendPdf:()=>true,openPdf:()=>{},releasePdf:()=>{},setKeyTurns:()=>{},keepScreenOn:()=>{}};const b=window.ReaderApp.state.books.find(b=>b.kind==='pdf');b.pdfMode='native';});await p.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await p.locator('#reader-busy').waitFor();await p.getByRole('button',{name:'返回书库',exact:true}).click();await p.waitForSelector('.library');await p.getByRole('button',{name:'阅读 山间来信',exact:true}).click();await p.waitForSelector('#flow p');assert.equal(await p.evaluate(()=>window.ReaderApp.state.book.title),'山间来信');pass('An unresponsive PDF opening can be cancelled and does not block another book');await c.close();
 }
 {
  const{c,p}=await context();await p.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await p.waitForSelector('#pdf-host>.pdf-paper canvas');await p.waitForSelector('#reader-busy',{state:'detached'});
  await p.evaluate(()=>{const doc=window.ReaderApp.state.pdf,getPage=doc.getPage.bind(doc);doc.getPage=async n=>{const page=await getPage(n);page.getTextContent=async()=>{throw new Error('Simulated unsupported text layer');};return page;};});
  await p.keyboard.press('ArrowRight');await p.waitForFunction(()=>window.ReaderApp.state.pdfPage===1&&!window.ReaderApp.state.busy);assert.equal(await p.locator('#pdf-host>.pdf-paper canvas').count(),1);assert.equal(await p.getByRole('dialog').count(),0);pass('An unsupported PDF text layer does not prevent viewing a successfully rendered page');await c.close();
 }
 {
  const{c,p}=await context();await p.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await p.waitForSelector('#pdf-host>.pdf-paper canvas');await p.waitForSelector('#reader-busy',{state:'detached'});
  await p.evaluate(()=>{window.ReaderApp.state.pdf.getPage=async()=>{throw new Error('Simulated unsupported page decoder');};});await p.keyboard.press('ArrowRight');await p.getByRole('dialog',{name:'未能打开 PDF'}).waitFor();await p.getByRole('button',{name:'返回书库',exact:true}).click();await p.waitForSelector('.library');await p.reload();await p.waitForSelector('.library');assert.equal(await p.getByRole('dialog').count(),0);pass('A later-page rendering failure also exits safely and disables automatic resume');await c.close();
 }
 await fs.writeFile('test-results/pdf-recovery-tests.json',JSON.stringify({passed:checks.length,checks},null,2));
}finally{await browser.close();}
