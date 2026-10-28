import {_android} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554';
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000,windowsHide:true}).trim();
assert.equal(cmd('emu','avd','name').split('\n')[0].trim(),'MoyueTabletAscii');
const checks=[],pass=n=>{checks.push(n);console.log('PASS '+n);};
const device=(await _android.devices({omitDriverInstall:true})).find(d=>d.serial()===serial);
const page=await(await device.webView({pkg:'cn.moyue.reader'},{timeout:30000})).page();
try{
 await page.waitForFunction(()=>window.ReaderApp&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.opening);
 const paths={wasm:'wasm/openjpeg.wasm',chunk:'chunks/'+(await fs.readdir('app/src/main/assets/web/chunks')).find(n=>/\-[A-Z0-9]{8}\.js$/.test(n)),font:'fonts/'+(await fs.readdir('app/src/main/assets/web/fonts')).find(n=>n.endsWith('.woff2'))};
 const assets=await page.evaluate(async paths=>{const results={};for(const [key,path] of Object.entries(paths)){const r=await fetch('./'+path,{cache:'reload'});results[key]={ok:r.ok,cache:r.headers.get('cache-control')};if(key==='wasm'){await WebAssembly.compile(await r.arrayBuffer());results[key].compiled=true;}}return results;},paths);
 assert.equal(assets.wasm.compiled,true);assert.equal(assets.wasm.cache,'no-cache');assert.match(assets.chunk.cache,/immutable/);assert.match(assets.font.cache,/immutable/);pass('Packaged WebView compiles OpenJPEG WASM under CSP and applies upgrade-safe cache headers');
 await page.evaluate(()=>window.ReaderApp.openBook(window.ReaderApp.state.books.find(b=>b.title==='山间来信').id));
 await page.waitForFunction(()=>window.ReaderApp.state.paginator&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.opening);
 await page.mouse.click(300,40);await page.getByRole('button',{name:'字体与排版设置'}).click();
 cmd('shell','input','keyevent','4');await page.getByRole('dialog',{name:'阅读设置'}).waitFor({state:'detached'});assert.equal(await page.locator('#reader').count(),1);
 cmd('shell','input','keyevent','4');await page.waitForFunction(()=>!window.ReaderApp.state.tools);assert.equal(await page.locator('#reader').count(),1);
 cmd('shell','input','keyevent','4');await page.waitForSelector('.library');pass('Android 15 native Back closes one layer per press: panel, toolbar, then Library');
 await page.getByRole('button',{name:'管理 城市与步行',exact:true}).click();await page.getByRole('button',{name:'用 PDF 兼容模式打开',exact:true}).click();
 await page.waitForFunction(()=>window.ReaderApp.state.pdf?.isNative&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.opening);
 const text=await page.evaluate(async()=>{const events=window.NativeEvents;window.NativeEvents=(type,value)=>{if(type==='pdf'&&Array.isArray(value.items))value={...value,supported:false,items:[]};events(type,value);};try{const a=window.ReaderApp;if(a.state.pdfBytes!==null)throw new Error('Source bytes retained');const p=await a.state.pdf.getPage(1);return(await p.getTextContent()).items.map(i=>i.str).join(' ');}finally{window.NativeEvents=events;}});
 assert.match(text,/walking/i);pass('Native PDF releases source bytes and lazily reloads an independent text engine when platform text is unavailable');
 await fs.writeFile('test-results/workbuddy-review/native-controls.json',JSON.stringify({passed:checks.length,checks,assets,environment:'Android 15 emulator / WebView 124'},null,2));
}finally{await device.close();}
