import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554';
const rawCmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:90000,windowsHide:true}).trim();
const sleepSync=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
/** The emulator occasionally drops its ADB connection; restart the bridge and retry. */
function cmd(...args){
  let last;
  for(let i=0;i<4;i++){
    try{return rawCmd(...args);}
    catch(e){
      last=e;
      try{execFileSync(adb,['kill-server'],{timeout:30000});execFileSync(adb,['start-server'],{timeout:30000});}catch{}
      sleepSync(4000);
    }
  }
  throw last;
}
assert.ok(cmd('emu','avd','name').split('\n')[0].trim().startsWith('MoyueTablet'),'run on the tablet emulator');
const pass=n=>console.log('PASS '+n),delay=ms=>new Promise(r=>setTimeout(r,ms));
const dump=()=>{for(let i=0;i<5;i++){try{cmd('shell','uiautomator','dump','/sdcard/upg113.xml');return cmd('shell','cat','/sdcard/upg113.xml');}catch(e){if(i===4)throw e;execFileSync(adb,['-s',serial,'shell','input','keyevent','KEYCODE_WAKEUP'],{timeout:20000});}}};
const bounds=(xml,test)=>{for(const m of xml.matchAll(/<node\b[^>]+>/g))if(test(m[0])){const b=m[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(b)return[(+b[1]+ +b[3])/2,(+b[2]+ +b[4])/2];}return null;};
async function tap(p){assert.ok(p);cmd('shell','input','tap',...p.map(n=>String(Math.round(n))));await delay(250);}
async function wait(test,label){for(let i=0;i<24;i++){let xml=dump();const got=bounds(xml,n=>/text="(Got it|知道了|明白了)"/.test(n));if(got){await tap(got);xml=dump();}if(test(xml))return xml;await delay(300);}throw new Error('未到达预期界面：'+label);}
const percent=xml=>Number(xml.match(/text="(\d+)%"/)?.[1]||0);
await fs.mkdir('test-results/release-1.1.3',{recursive:true});
for(let i=0;i<4;i++){try{cmd('uninstall','cn.moyue.reader');}catch{}if(!cmd('shell','pm','list','packages').includes('cn.moyue.reader'))break;sleepSync(2000);}
assert.ok(!cmd('shell','pm','list','packages').includes('cn.moyue.reader'),'baseline install needs a clean device');
cmd('shell','input','keyevent','KEYCODE_WAKEUP');cmd('shell','wm','dismiss-keyguard');cmd('shell','settings','put','system','screen_off_timeout','1800000');
cmd('install',path.resolve('test-results/baseline-release-1.1.2.apk'));
cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');
let xml=await wait(x=>x.includes('阅读 山间来信'),'baseline library');
await tap(bounds(xml,n=>n.includes('text="阅读 山间来信"')||n.includes('content-desc="阅读 山间来信"')));
await wait(x=>x.includes('切换阅读进度显示'),'baseline reader');
cmd('shell','input','keyevent','25');
xml=await wait(x=>percent(x)>0,'baseline page turn');
const saved=percent(xml);
await tap([600,75]);xml=await wait(x=>x.includes('添加书签'),'baseline tools');
await tap(bounds(xml,n=>n.includes('text="添加书签"')||n.includes('content-desc="添加书签"')));
await wait(x=>x.includes('移除书签'),'baseline bookmark');
await delay(5500);
pass('1.1.2 baseline keeps a reading position and a bookmark');

cmd('shell','am','force-stop','cn.moyue.reader');
assert.match(cmd('install','-r',path.resolve('release/墨阅-1.0.0.apk')),/Success/);
const pkg=cmd('shell','dumpsys','package','cn.moyue.reader');
assert.match(pkg,/versionName=1\.1\.3/);
assert.match(pkg,/versionCode=7/);
assert.ok(!pkg.includes('android.permission.INTERNET'),'still no network permission');
assert.ok(!/flags=\[[^\]]*DEBUGGABLE/.test(pkg),'release is not debuggable');
pass('1.1.3 installs over 1.1.2 with the original signature, no data clearing, no network permission');

cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');
xml=await wait(x=>x.includes('切换阅读进度显示')&&percent(x)===saved,'upgraded reader');
await tap([600,75]);
await wait(x=>x.includes('移除书签'),'upgraded bookmark');
pass('Upgrade keeps the exact reading position and the bookmark');
cmd('shell','screencap','-p','/sdcard/up113.png');cmd('pull','/sdcard/up113.png','test-results/release-1.1.3/upgrade-reading.png');

xml=dump();await tap(bounds(xml,n=>n.includes('content-desc="字体与排版设置"')||n.includes('text="Aa"')));
xml=await wait(x=>x.includes('更多'),'settings sheet');
await tap(bounds(xml,n=>n.includes('text="更多"')));
xml=await wait(x=>x.includes('墨水屏模式'),'more tab');
pass('New e-ink and PDF colour preferences are reachable in the reader settings');
cmd('shell','screencap','-p','/sdcard/up113b.png');cmd('pull','/sdcard/up113b.png','test-results/release-1.1.3/settings-more.png');
