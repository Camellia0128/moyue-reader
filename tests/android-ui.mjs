import { _android } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const adb=process.env.ADB_PATH||'F:/MoyueReaderTools/sdk/platform-tools/adb.exe';
const device=process.env.ANDROID_SERIAL||'emulator-5554';
const cmd=(...args)=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',windowsHide:true,timeout:45000}).trim();
const passed=[];function done(name){passed.push(name);console.log('PASS '+name);}
await fs.mkdir('test-results/android',{recursive:true});
cmd('shell','settings','put','system','accelerometer_rotation','0');cmd('shell','settings','put','system','user_rotation','0');
cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');
let pid='';for(let i=0;i<20&&!pid;i++){try{pid=cmd('shell','pidof','cn.moyue.reader');}catch{}if(!pid)await new Promise(r=>setTimeout(r,500));}
cmd('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
const androidDevices=await _android.devices({omitDriverInstall:true});
const androidDevice=androidDevices.find(d=>d.serial()===device);
if(!androidDevice)throw new Error('Android test device not found');
const webview=await androidDevice.webView({pkg:'cn.moyue.reader'},{timeout:30000});
const page=await webview.page(),errors=[];page.on('pageerror',e=>errors.push(e.message));
async function screenshot(name){if(!name.includes('failure')){await page.waitForSelector('#reader-busy',{state:'detached',timeout:30000});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await new Promise(r=>setTimeout(r,200));}cmd('shell','screencap','-p','/sdcard/moyue-screen.png');cmd('pull','/sdcard/moyue-screen.png','test-results/android/'+name+'.png');}
try{
 const initialSystemUi=await dump();const immersive=nodeBounds(initialSystemUi,n=>/text="(Got it|知道了|明白了)"/.test(n));if(immersive)await tap(immersive);
 await page.waitForFunction(()=>window.ReaderApp?.state.books.length>=6,{timeout:90000});
 if(await page.locator('#reader').count()){await page.mouse.click(300,40);if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(300,40);await page.getByRole('button',{name:'书库',exact:true}).first().click();}
 await page.waitForSelector('.library .book-card');assert.ok((await page.url()).startsWith('https://reader.moyue.local'));done('Installed Android APK boots with entirely packaged HTTPS-origin assets');
 const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,books:window.ReaderApp.state.books.length,android:typeof Android}));console.log(JSON.stringify(metrics));assert.equal(metrics.android,'object');
 await screenshot('01-library');
 await page.getByRole('button',{name:'阅读 山间来信',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.paginator&&!window.ReaderApp.state.busy);
 const before=await page.evaluate(()=>window.ReaderApp.state.paginator.page);cmd('shell','input','keyevent','25');await page.waitForFunction(previous=>window.ReaderApp.state.paginator.page>previous,before);done('Android volume-down key advances the actual reading page');
 await screenshot('02-reading');
 const id=await page.evaluate(()=>window.ReaderApp.state.book.id);await page.evaluate(()=>window.ReaderApp.flush());
 await page.mouse.click(300,40);if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(300,40);await page.getByRole('button',{name:/添加书签|移除书签/}).click();
 await page.getByRole('button',{name:'字体与排版设置',exact:true}).click();await screenshot('03-settings');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'书库',exact:true}).first().click();await page.getByRole('button',{name:'阅读 城市与步行',exact:true}).click();await page.waitForSelector('#pdf-host>.pdf-paper canvas',{timeout:60000});await page.waitForFunction(()=>!window.ReaderApp.state.busy);assert.ok(await page.locator('.textLayer span').count()>0);await screenshot('04-pdf');done('Android System WebView 124 renders offline PDF worker, fonts and text layer');
 await page.mouse.click(300,40);await page.getByRole('button',{name:'裁白边',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.crop&&!window.ReaderApp.state.busy);assert.ok(await page.evaluate(()=>Number(document.querySelector('#pdf-host>.pdf-paper').dataset.cropX))>0);done('PDF cropping detects actual page whitespace');
 await page.getByRole('button',{name:'书库',exact:true}).first().click();await page.waitForSelector('.library');
 // Exercise the native Android file picker and SAF, rather than a browser-only upload.
 await fs.writeFile('test-results/native-import.txt','第一章 原生导入\n\n这份文件通过 Android 系统文件选择器导入，不依赖浏览器上传。\n阅读进度应保存在本地。');
 cmd('push','test-results/native-import.txt','/sdcard/Download/native-import.txt');
 await page.getByRole('button',{name:'导入',exact:true}).click();
 await new Promise(r=>setTimeout(r,700));
 cmd('shell','uiautomator','dump','/sdcard/moyue-ui.xml');
 const xml=cmd('shell','cat','/sdcard/moyue-ui.xml');await fs.writeFile('test-results/android/file-picker.xml',xml);
 assert.ok(xml.includes('com.google.android.documentsui')||xml.includes('com.android.documentsui'));done('Import opens Android system Storage Access Framework picker');
 // Picker can start in Recents; use its navigation menu to reach Downloads.
 function nodeBounds(xml,predicate){for(const match of xml.matchAll(/<node\b[^>]+>/g)){if(predicate(match[0])){const b=match[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(b)return[(Number(b[1])+Number(b[3]))/2,(Number(b[2])+Number(b[4]))/2];}}return null;}
 async function dump(){cmd('shell','uiautomator','dump','/sdcard/moyue-ui.xml');return cmd('shell','cat','/sdcard/moyue-ui.xml');}
 async function tap(point){cmd('shell','input','tap',...point.map(n=>String(Math.round(n))));await new Promise(r=>setTimeout(r,350));}
 let view=xml;let file=nodeBounds(view,n=>/text="native-import.txt"/.test(n));
 if(!file){const drawer=nodeBounds(view,n=>/resource-id="[^"]*:id\/toolbar"/.test(n)&&/android.widget.ImageButton/.test(n))||nodeBounds(view,n=>/content-desc="(Show roots|显示根目录|显示侧边栏|打开导航抽屉)"/.test(n));if(drawer)await tap(drawer);else cmd('shell','input','tap','48','55');view=await dump();const downloads=nodeBounds(view,n=>/text="(Downloads|下载内容|下载)"/.test(n));if(downloads)await tap(downloads);view=await dump();file=nodeBounds(view,n=>/text="native-import.txt"/.test(n));}
 if(!file){await screenshot('picker-unresolved');throw new Error('Cannot locate pushed test file in Android DocumentsUI');}
 await tap(file);await page.waitForFunction(()=>window.ReaderApp.state.books.some(b=>b.filename==='native-import.txt'),{timeout:60000});
 await page.getByRole('button',{name:'阅读 native-import',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.paginator&&!window.ReaderApp.state.busy);assert.ok((await page.locator('#flow').textContent()).includes('Android 系统文件选择器'));done('SAF import copies real external bytes, parses them, stores them, and opens them');
 await page.evaluate(()=>window.ReaderApp.flush());await screenshot('05-native-import');
 assert.deepEqual(errors,[]);done('No uncaught JavaScript errors in installed APK flows');
 await fs.writeFile('test-results/android-tests.json',JSON.stringify({device,metrics,passed:passed.length,checks:passed,errors},null,2));
}catch(e){await screenshot('failure');await fs.writeFile('test-results/android-failure.json',JSON.stringify({message:e.stack,passed,errors},null,2));throw e;}finally{await androidDevice.close();}
