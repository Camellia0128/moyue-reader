import {_android} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554';
assert.ok(serial.startsWith('emulator-'));
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:60000,windowsHide:true}).trim();
const checks=[],errors=[];const pass=name=>{checks.push(name);console.log('PASS '+name);};
let device,page;
async function attach(){device=(await _android.devices({omitDriverInstall:true})).find(d=>d.serial()===serial);page=await(await device.webView({pkg:'cn.moyue.reader'},{timeout:30000})).page();page.on('pageerror',e=>errors.push(e.message));}
await fs.mkdir('test-results/pdf-fix',{recursive:true});
// Only this test emulator is reset to construct the actual old-version failure state.
cmd('uninstall','cn.moyue.reader');cmd('install',path.resolve('test-results/baseline-debug-1.0.0.apk'));cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');await attach();
try{
 await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6&&document.querySelector('.library')&&localStorage.getItem('moyue-seeded')==='1');
 await page.evaluate(async()=>{const db=await new Promise(r=>{const req=indexedDB.open('moyue-reader');req.onsuccess=()=>r(req.result);});const pdf=window.ReaderApp.state.books.find(b=>b.kind==='pdf'),epub=window.ReaderApp.state.books.find(b=>b.title==='山间来信');epub.notes=[{id:'retained-note',chapter:0,start:0,end:3,text:'第一章',note:'升级后保留的原有笔记',created:Date.now()}];epub.bookmarks=[{id:'retained-bookmark',locator:{chapter:0,anchor:0,pdfPage:0},label:'保留书签',created:Date.now()}];await new Promise((r,j)=>{const tx=db.transaction(['originals','books'],'readwrite');tx.objectStore('originals').put({id:pdf.id,blob:new Blob(['%PDF-1.7\ninvalid pdf to simulate an unavailable decoder'])});tx.objectStore('books').put(epub);tx.oncomplete=r;tx.onerror=()=>j(tx.error);});localStorage.setItem('moyue-route','reader');localStorage.setItem('moyue-current',pdf.id);db.close();});
 // DOM storage commits to disk asynchronously; let the old WebView finish its commit.
 await page.waitForTimeout(5500);await device.close();cmd('shell','am','force-stop','cn.moyue.reader');cmd('install','-r',path.resolve('app/build/outputs/apk/debug/app-debug.apk'));cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');await attach();
 await page.getByRole('dialog',{name:'未能打开 PDF'}).waitFor({timeout:45000});assert.equal(await page.locator('#reader').count(),0);await page.getByRole('button',{name:'返回首页',exact:true}).click();await page.waitForSelector('.home-title');
 assert.equal(await page.evaluate(()=>window.ReaderApp.state.books.find(b=>b.title==='山间来信').notes[0].note),'升级后保留的原有笔记');pass('Upgrade from a real 1.0.0 failed-resume state returns Home and preserves old notes/bookmarks');
 await page.reload();await page.waitForSelector('.library');assert.equal(await page.getByRole('dialog').count(),0);pass('Cold page reload after failure does not repeat the PDF error');
 const original=Object.entries(unzipSync(await fs.readFile('test-results/baseline-debug-1.0.0.apk'))).find(([name])=>name.startsWith('assets/web/samples/')&&name.endsWith('.pdf'))?.[1];assert.ok(original);
 await page.evaluate(async bytes=>{const db=await new Promise(r=>{const req=indexedDB.open('moyue-reader');req.onsuccess=()=>r(req.result);});const b=window.ReaderApp.state.books.find(b=>b.kind==='pdf');await new Promise((r,j)=>{const tx=db.transaction('originals','readwrite');tx.objectStore('originals').put({id:b.id,blob:new Blob([new Uint8Array(bytes)])});tx.oncomplete=r;tx.onerror=()=>j(tx.error);});db.close();},[...original]);
 await page.getByRole('button',{name:'管理 城市与步行',exact:true}).click();await page.getByRole('button',{name:'用 PDF 兼容模式打开',exact:true}).click();
 await page.waitForFunction(()=>window.ReaderApp.state.pdf?.isNative&&!window.ReaderApp.state.busy,{timeout:45000});await page.waitForSelector('#pdf-host>.pdf-paper img');await page.waitForSelector('#reader-busy',{state:'detached'});assert.ok(await page.locator('#pdf-host>.pdf-paper img').evaluate(n=>n.naturalWidth>100));pass('Native Android PdfRenderer opens and renders a real PDF independently of PDF.js');
 cmd('shell','input','keyevent','25');await page.waitForFunction(()=>window.ReaderApp.state.pdfPage===1&&!window.ReaderApp.state.busy);pass('Compatibility PDF mode supports actual native-key page turns');
 await page.mouse.click(300,40);await page.getByRole('button',{name:'旋转',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.rotation===90&&!window.ReaderApp.state.busy);assert.ok(await page.locator('#pdf-host>.pdf-paper img').evaluate(n=>n.naturalWidth>n.naturalHeight));pass('Native compatibility rendering also supports page rotation');
 cmd('shell','screencap','-p','/sdcard/moyue-compat.png');cmd('pull','/sdcard/moyue-compat.png','test-results/pdf-fix/compatibility.png');
 await page.getByRole('button',{name:'阅读选项',exact:true}).click();await page.getByRole('button',{name:'切换 PDF 标准模式',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.pdf&&!window.ReaderApp.state.pdf.isNative&&!window.ReaderApp.state.busy);await page.waitForSelector('#pdf-host>.pdf-paper canvas');
 await page.evaluate(()=>{window.ReaderApp.state.pdfCache.clear();window.ReaderApp.state.prefetching=true;window.ReaderApp.state.pdf.getPage=async()=>{throw new Error('Forced WebView page decoder failure');};});await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>window.ReaderApp.state.pdf?.isNative&&!window.ReaderApp.state.busy,{timeout:45000});await page.waitForSelector('#pdf-host>.pdf-paper img');assert.equal(await page.evaluate(()=>window.ReaderApp.state.book.pdfMode),'native');pass('A failed standard PDF page automatically falls back to the real platform renderer');
 await page.evaluate(()=>window.ReaderApp.flush());assert.deepEqual(errors,[]);await fs.writeFile('test-results/pdf-fix-android.json',JSON.stringify({passed:checks.length,checks,errors},null,2));
}catch(e){cmd('shell','screencap','-p','/sdcard/moyue-compat-failure.png');cmd('pull','/sdcard/moyue-compat-failure.png','test-results/pdf-fix/failure.png');await fs.writeFile('test-results/pdf-fix-android-failure.json',JSON.stringify({message:e.stack,checks,errors},null,2));throw e;}finally{await device.close();}
