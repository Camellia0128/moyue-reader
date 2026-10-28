import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554';
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000,windowsHide:true}).trim();assert.equal(cmd('emu','avd','name').split('\n')[0].trim(),'MoyueTabletAscii');
const checks=[],pass=n=>{checks.push(n);console.log('PASS '+n);},delay=ms=>new Promise(r=>setTimeout(r,ms));
const dump=()=>{for(let i=0;i<3;i++){try{cmd('shell','uiautomator','dump','/sdcard/upgrade-v114.xml');return cmd('shell','cat','/sdcard/upgrade-v114.xml');}catch(e){if(i===2)throw e;}}};
const bounds=(xml,test)=>{for(const m of xml.matchAll(/<node\b[^>]+>/g))if(test(m[0])){const b=m[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(b)return[(+b[1]+ +b[3])/2,(+b[2]+ +b[4])/2];}return null;};
async function tap(p){assert.ok(p);cmd('shell','input','tap',...p.map(n=>String(Math.round(n))));await delay(200);}
async function wait(test){for(let i=0;i<18;i++){let xml=dump();const got=bounds(xml,n=>/text="(Got it|知道了|明白了)"/.test(n));if(got){await tap(got);xml=dump();}if(test(xml))return xml;await delay(300);}throw new Error('Signed upgrade did not reach expected UI');}
const percent=xml=>Number(xml.match(/text="(\d+)%"/)?.[1]||0);
await fs.mkdir('test-results/review-1.1.3/release',{recursive:true});
try{cmd('uninstall','cn.moyue.reader');}catch{}
cmd('install',path.resolve('test-results/review-1.1.3/baseline-release.apk'));cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');
let xml=await wait(x=>x.includes('阅读 山间来信'));await tap(bounds(xml,n=>n.includes('text="阅读 山间来信"')||n.includes('content-desc="阅读 山间来信"')));await wait(x=>x.includes('切换阅读进度显示'));
cmd('shell','input','keyevent','25');xml=await wait(x=>percent(x)>0);const savedPercent=percent(xml);await tap([600,75]);xml=await wait(x=>x.includes('添加书签'));await tap(bounds(xml,n=>n.includes('text="添加书签"')||n.includes('content-desc="添加书签"')));await wait(x=>x.includes('移除书签'));await delay(5500);pass('Baseline signed WorkBuddy 1.1.3 has saved reading progress and a real bookmark');
cmd('shell','am','force-stop','cn.moyue.reader');assert.match(cmd('install','-r',path.resolve('release/墨阅-1.0.0.apk')),/Success/);const pkg=cmd('shell','dumpsys','package','cn.moyue.reader');assert.match(pkg,/versionName=1\.1\.4/);assert.match(pkg,/versionCode=8/);assert.ok(!pkg.includes('android.permission.INTERNET'));assert.ok(!/flags=\[[^\]]*DEBUGGABLE/.test(pkg));pass('Final release updates in place with the original signature and no data clearing');
cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');await wait(x=>x.includes('切换阅读进度显示')&&percent(x)===savedPercent);await tap([600,75]);await wait(x=>x.includes('移除书签'));pass('Signed WorkBuddy 1.1.3 → 1.1.4 upgrade preserves reading position and bookmark');
cmd('shell','screencap','-p','/sdcard/upgrade-v114.png');cmd('pull','/sdcard/upgrade-v114.png','test-results/review-1.1.3/release/upgraded.png');
cmd('shell','am','force-stop','cn.moyue.reader');cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');await wait(x=>x.includes('切换阅读进度显示')&&percent(x)===savedPercent);pass('Upgraded signed APK restores the same location after a cold restart');
await fs.writeFile('test-results/review-1.1.3/release-upgrade.json',JSON.stringify({passed:checks.length,checks,from:'1.1.3',to:'1.1.4',versionCode:8,savedPercent,noUninstallDuringUpgrade:true},null,2));
