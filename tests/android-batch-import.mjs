import {_android} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554',pkg='cn.moyue.reader';
const cmd=(...a)=>execFileSync(adb,['-s',serial,...a],{encoding:'utf8',timeout:90000,windowsHide:true}).trim();assert.equal(cmd('emu','avd','name').split('\n')[0].trim(),'MoyueTabletAscii');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function dump(){cmd('shell','uiautomator','dump','/sdcard/wb-batch.xml');return cmd('shell','cat','/sdcard/wb-batch.xml');}
function point(xml,predicate){for(const m of xml.matchAll(/<node\b[^>]+>/g))if(predicate(m[0])){const b=m[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(b)return[(+b[1]+ +b[3])/2,(+b[2]+ +b[4])/2];}return null;}
async function tap(p){assert.ok(p,'Expected picker control missing');cmd('shell','input','tap',...p.map(n=>String(Math.round(n))));await delay(250);}
await fs.mkdir('test-results/workbuddy-review/batch',{recursive:true});for(let i=1;i<=12;i++)await fs.writeFile('test-results/workbuddy-review/batch/wb-'+String(i).padStart(2,'0')+'.txt','独立批量导入测试，第 '+i+' 本。\n'+('慢速读取时不能提前删除待处理文件。'.repeat(40)));
cmd('shell','mkdir','-p','/sdcard/Download/wb-batch');cmd('push','test-results/workbuddy-review/batch/.','/sdcard/Download/wb-batch/');for(let i=1;i<=12;i++)cmd('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Download/wb-batch/wb-'+String(i).padStart(2,'0')+'.txt');
try{cmd('uninstall',pkg);}catch{}cmd('install',path.resolve(process.env.REVIEW_BASELINE?'test-results/baseline-debug-workbuddy-1.1.1.apk':'app/build/outputs/apk/debug/app-debug.apk'));cmd('shell','am','start','-n',pkg+'/.MainActivity');
const device=(await _android.devices({omitDriverInstall:true})).find(d=>d.serial()===serial),page=await(await device.webView({pkg},{timeout:30000})).page();
try{
 await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6&&document.querySelector('.library'));
 await page.evaluate(()=>{const original=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/import/'))await new Promise(r=>setTimeout(r,350));return original(...args);};});
 await page.getByRole('button',{name:'导入',exact:true}).click();await delay(500);let xml=dump();let folder=point(xml,n=>n.includes('text="wb-batch"'));
 if(!folder){await tap(point(xml,n=>/content-desc="(Show roots|显示根目录|显示侧边栏|打开导航抽屉)"/.test(n)));xml=dump();await tap(point(xml,n=>/text="(Downloads|下载内容|下载)"/.test(n)));xml=dump();folder=point(xml,n=>n.includes('text="wb-batch"'));}
 await tap(folder);await delay(1500);xml=dump();const first=point(xml,n=>n.includes('text="wb-01.txt"'));assert.ok(first);cmd('shell','input','swipe',...first.map(String),...first.map(String),'900');await delay(300);xml=dump();await tap(point(xml,n=>/content-desc="(More options|更多选项)"/.test(n)));xml=dump();await tap(point(xml,n=>/text="(Select all|全选)"/.test(n)));xml=dump();await tap(point(xml,n=>/text="(OPEN|Open|打开|Select|SELECT|选择)"/.test(n)));
 await page.waitForTimeout(7000);await page.waitForFunction(()=>!document.querySelector('.import-status'),null,{timeout:90000});const result=await page.evaluate(()=>({imported:window.ReaderApp.state.books.filter(b=>b.filename.startsWith('wb-')).length,errors:document.querySelector('.error-detail')?.textContent||''}));
 await fs.writeFile(process.env.REVIEW_BASELINE?'test-results/workbuddy-review/native-batch-baseline.json':'test-results/workbuddy-review/native-batch.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.equal(result.imported,12);assert.equal(result.errors,'');console.log('PASS Twelve real SAF files import successfully despite deliberately delayed consumption');
}finally{await device.close();}
