import {_android} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554',pkg='cn.moyue.reader';
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000,windowsHide:true}).trim();assert.equal(cmd('emu','avd','name').split('\n')[0].trim(),'MoyueTabletAscii');
let device,page;const checks=[],errors=[],pass=name=>{checks.push(name);console.log('PASS '+name);};
async function attach(){device=(await _android.devices({omitDriverInstall:true})).find(d=>d.serial()===serial);page=await(await device.webView({pkg},{timeout:30000})).page();page.on('pageerror',e=>{if(!/crash|closed/i.test(e.message))errors.push(e.message);});}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
await fs.mkdir('test-results/stability/android',{recursive:true});
try{cmd('uninstall',pkg);}catch{}cmd('install',path.resolve('app/build/outputs/apk/debug/app-debug.apk'));cmd('shell','am','start','-n',pkg+'/.MainActivity');await attach();
try{
 await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6&&document.querySelector('.library'));
 await page.getByRole('button',{name:'阅读 山间来信',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.paginator&&!window.ReaderApp.state.opening&&!window.ReaderApp.state.busy);
 const bookId=await page.evaluate(async()=>{const a=window.ReaderApp;await a.turn(1);a.state.book.notes.push({id:'crash-note',text:'保留记录',note:'进程恢复后仍应存在',chapter:0,start:0,end:4,created:Date.now()});await a.flush();return a.state.book.id;});
 const pid=cmd('shell','pidof',pkg);const cdp=await page.context().newCDPSession(page);
 await Promise.race([cdp.send('Page.crash').catch(()=>{}),delay(2500)]);await device.close();await delay(1500);await attach();await page.waitForSelector('.library',{timeout:45000});assert.equal(cmd('shell','pidof',pkg),pid);assert.match(page.url(),/recover=renderer/);assert.equal(await page.evaluate(id=>window.ReaderApp.state.books.find(b=>b.id===id).notes.find(n=>n.id==='crash-note').note,bookId),'进程恢复后仍应存在');assert.equal(await page.evaluate(()=>window.ReaderApp.state.backgroundWorkDisabled),true);pass('A forced real WebView renderer crash returns to Library without killing the host or losing saved notes');
 await page.getByRole('button',{name:'阅读 山间来信',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.paginator&&!window.ReaderApp.state.opening&&!window.ReaderApp.state.busy);assert.ok(await page.locator('#flow mark[data-note="crash-note"]').count());pass('The original book and highlight remain usable after renderer recovery');
 await page.evaluate(()=>{Android.saveText('first','first.md');Android.saveText('second','second.md');});await delay(500);cmd('shell','uiautomator','dump','/sdcard/export-race.xml');let xml=cmd('shell','cat','/sdcard/export-race.xml');assert.match(xml,/first\.md/);assert.ok(!xml.includes('text="second.md"'));cmd('shell','input','keyevent','4');await delay(300);await page.evaluate(()=>Android.saveText('third','third.md'));await delay(500);cmd('shell','uiautomator','dump','/sdcard/export-race.xml');xml=cmd('shell','cat','/sdcard/export-race.xml');assert.match(xml,/third\.md/);cmd('shell','input','keyevent','4');pass('Double export opens one picker; cancelling releases it for the next export');
 cmd('shell','run-as',pkg,'touch','cache/import-11111111-1111-1111-1111-111111111111');await device.close();cmd('shell','am','force-stop',pkg);cmd('shell','am','start','-n',pkg+'/.MainActivity');await attach();await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6);assert.ok(!cmd('shell','run-as',pkg,'ls','cache').includes('import-11111111-1111-1111-1111-111111111111'));pass('Cold launch removes abandoned import cache files without deleting the library');
 assert.deepEqual(errors,[]);cmd('shell','screencap','-p','/sdcard/crash-recovery.png');cmd('pull','/sdcard/crash-recovery.png','test-results/stability/android/recovered.png');await fs.writeFile('test-results/stability/android-crash.json',JSON.stringify({passed:checks.length,checks,errors,environment:'Android 15 emulator / WebView 124'},null,2));
}catch(error){await fs.writeFile('test-results/stability/android-crash-failure.json',JSON.stringify({message:error.stack,checks,errors},null,2));throw error;}finally{await device.close().catch(()=>{});}
