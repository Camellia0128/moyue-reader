import {_android} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554';
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000,windowsHide:true}).trim();
assert.equal(cmd('emu','avd','name').split('\n')[0].trim(),'MoyueTabletAscii');
const checks=[],pass=name=>{checks.push(name);console.log('PASS '+name);},delay=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<90&&cmd('shell','getprop','sys.boot_completed')!=='1';i++)await delay(1000);
assert.equal(cmd('shell','getprop','sys.boot_completed'),'1');cmd('shell','mkdir','-p','/sdcard/Download');
await fs.mkdir('test-results/review-1.1.5/dict',{recursive:true});
const definition=Buffer.from('苹果；苹果树。真实离线词条。'),idx=Buffer.concat([Buffer.from('apple\0'),Buffer.alloc(8)]);idx.writeUInt32BE(definition.length,idx.length-4);
const ifo=Buffer.from(`StarDict's dict ifo file\nversion=2.4.2\nwordcount=1\nidxfilesize=${idx.length}\nbookname=Android 实测词典\nsametypesequence=m\n`);
for(const [ext,data] of [['ifo',ifo],['idx',idx],['dict',definition]]){const file='test-results/review-1.1.5/dict/qa-dict.'+ext;await fs.writeFile(file,data);cmd('push',file,'/sdcard/Download/qa-dict.'+ext);cmd('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Download/qa-dict.'+ext);}
if(!process.env.KEEP_TEST_DATA){try{cmd('uninstall','cn.moyue.reader');}catch{}}
cmd('shell','am','force-stop','cn.moyue.reader');cmd('install','-r',path.resolve('app/build/outputs/apk/debug/app-debug.apk'));cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');
const device=(await _android.devices({omitDriverInstall:true})).find(d=>d.serial()===serial),page=await(await device.webView({pkg:'cn.moyue.reader'},{timeout:60000})).page();
async function dump(){for(let i=0;i<6;i++){try{const output=cmd('shell','uiautomator','dump','/sdcard/dict-qa.xml');if(!output.includes('dumped to'))throw Error('Transient UI dump');return cmd('shell','cat','/sdcard/dict-qa.xml');}catch(e){if(i===5)throw e;await delay(500);}}}
function bounds(xml,test){for(const m of xml.matchAll(/<node\b[^>]+>/g))if(test(m[0])){const b=m[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(b)return[(+b[1]+ +b[3])/2,(+b[2]+ +b[4])/2];}return null;}
async function control(test,{long=false}={}){for(let i=0;i<15;i++){const xml=await dump(),p=bounds(xml,test);if(p){if(long)cmd('shell','input','swipe',...p.map(String),...p.map(String),'900');else cmd('shell','input','tap',...p.map(String));await delay(500);return;}await delay(300);}throw Error('Missing dictionary picker control');}
async function selectionCount(n){for(let i=0;i<12;i++){if((await dump()).includes(`text="${n} selected"`))return;await delay(400);}throw Error('Expected '+n+' selected files');}
try{
 await page.waitForFunction(()=>window.ReaderApp?.state.books.length>=6);
 await page.evaluate(()=>Android.pickDictionary());
 await control(n=>n.includes('content-desc="Show roots"'));
 await control(n=>n.includes('resource-id="android:id/title"')&&n.includes('text="Downloads"'));
 await control(n=>n.includes('text="qa-dict.ifo"'),{long:true});await selectionCount(1);
 await control(n=>n.includes('text="qa-dict.idx"'));await selectionCount(2);await control(n=>n.includes('text="qa-dict.dict"'));await selectionCount(3);
 await control(n=>/text="(Select|Open|OPEN|打开)"/.test(n));
 await page.waitForFunction(()=>ReaderApp.state.dicts.some(d=>d.name==='Android 实测词典'));
 const result=await page.evaluate(()=>ReaderApp.lookupWord('apple'));assert.match(result.results[0].definition,/真实离线词条/);
 pass('Android SAF multi-select imports a real three-file StarDict and reads its definition');
 assert.equal(cmd('shell','run-as','cn.moyue.reader','sh','-c',"'find cache -name \"import-*\"'"),'');
 pass('Successful native dictionary import releases every temporary file');
 await page.reload();await page.waitForFunction(()=>ReaderApp?.state.dicts.length>0);
 assert.match((await page.evaluate(()=>ReaderApp.lookupWord('apple'))).results[0].definition,/苹果/);pass('Dictionary persists and remains queryable after WebView restart');
 await page.evaluate(()=>ReaderApp.openBook(ReaderApp.state.books.find(b=>b.title==='山间来信').id));await page.waitForFunction(()=>!ReaderApp.state.opening&&!ReaderApp.state.busy);
 await page.evaluate(()=>ReaderApp.showLookup('apple',{bookId:ReaderApp.state.book.id,bookTitle:ReaderApp.state.book.title,text:'This is an apple.',locator:{chapter:0,anchor:5}}));
 await page.getByRole('button',{name:'加入生词本',exact:true}).click();await page.waitForFunction(()=>ReaderApp.state.vocab.some(v=>v.word==='apple'));
 cmd('shell','input','keyevent','4');await page.getByRole('dialog',{name:'查词'}).waitFor({state:'detached'});assert.equal(await page.locator('#reader').count(),1);pass('Native lookup adds a definition to vocabulary and Back preserves the reading page');
 await page.evaluate(()=>ReaderApp.openImageViewer('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'));cmd('shell','input','keyevent','4');await page.waitForFunction(()=>!ReaderApp.state.imageViewer);assert.equal(await page.locator('#reader').count(),1);pass('Android Back closes the image viewer without leaving the book');
 await page.evaluate(()=>{window.__released=[];window.__originalAndroid=window.Android;window.Android={releaseImport:token=>window.__released.push(token)};NativeEvents('dictfiles',[{name:'incomplete.ifo',token:'part-a'},{name:'unrelated.txt',token:'part-b'}]);});await page.waitForFunction(()=>window.__released?.length===2);await page.evaluate(()=>{window.Android=window.__originalAndroid;});
 pass('Incomplete and unrelated dictionary selections also release all native import tokens');
 const meta=cmd('shell','dumpsys','package','cn.moyue.reader'),expected=JSON.parse(await fs.readFile('package.json','utf8')).version;assert.ok(meta.includes('versionName='+expected));await fs.writeFile('test-results/review-1.1.5/native.json',JSON.stringify({checks,passed:checks.length,android:cmd('shell','getprop','ro.build.version.release')},null,2));
}finally{await device.close();}
