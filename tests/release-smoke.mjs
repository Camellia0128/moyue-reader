import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb=process.env.ADB_PATH||'F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial=process.env.ANDROID_SERIAL||'emulator-5554';
assert.ok(serial.startsWith('emulator-'),'This clean-install test is restricted to an emulator.');
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:60000,windowsHide:true}).trim();
const checks=[];const done=name=>{checks.push(name);console.log('PASS '+name);};
await fs.mkdir('test-results/release',{recursive:true});
try{cmd('uninstall','cn.moyue.reader');}catch{}
assert.ok(cmd('install',path.resolve('release/墨阅-1.0.0.apk')).includes('Success'));done('Final signed release APK installs successfully');
cmd('logcat','-c');cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function dump(){for(let attempt=0;attempt<3;attempt++){try{cmd('shell','uiautomator','dump','/sdcard/moyue-release.xml');return cmd('shell','cat','/sdcard/moyue-release.xml');}catch(error){if(attempt===2)throw error;}}}
function bounds(xml,test){for(const match of xml.matchAll(/<node\b[^>]+>/g)){if(test(match[0])){const b=match[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(b)return[(+b[1]+ +b[3])/2,(+b[2]+ +b[4])/2];}}return null;}
async function waitFor(test){for(let i=0;i<20;i++){let xml=dump();let got=bounds(xml,n=>/text="(Got it|知道了|明白了)"/.test(n));if(got){cmd('shell','input','tap',...got.map(String));await delay(250);xml=dump();}if(test(xml))return xml;await delay(500);}throw new Error('Release UI did not reach the expected state');}
async function shot(name){await delay(300);cmd('shell','screencap','-p','/sdcard/moyue-release.png');cmd('pull','/sdcard/moyue-release.png','test-results/release/'+name+'.png');}
let xml=await waitFor(x=>x.includes('山间来信')&&x.includes('书库'));await shot('01-library');done('Release cold launch loads the real offline library');
const open=bounds(xml,n=>n.includes('content-desc="阅读 山间来信"'))||bounds(xml,n=>n.includes('text="阅读 山间来信"'));assert.ok(open);cmd('shell','input','tap',...open.map(n=>String(Math.round(n))));
xml=await waitFor(x=>x.includes('第一章 山路')&&x.includes('0%'));await shot('02-reading');done('Release opens EPUB and renders the Chinese reading page');
const percent=x=>Number(x.match(/text="(\d+)%"/)?.[1]||0);
cmd('shell','input','keyevent','25');xml=await waitFor(x=>percent(x)>0);const savedPercent=percent(xml);done('Release native volume key advances the page');
await delay(400);cmd('shell','am','force-stop','cn.moyue.reader');cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');xml=await waitFor(x=>percent(x)===savedPercent&&x.includes('切换阅读进度显示'));await shot('03-restored');done('Final release restores reading location after Android force-stop');
const pkg=cmd('shell','dumpsys','package','cn.moyue.reader');assert.ok(!pkg.includes('android.permission.INTERNET'));assert.ok(!/flags=\[[^\]]*DEBUGGABLE/.test(pkg));done('Release has no network permission and is not debuggable');
const log=cmd('logcat','-d','--pid='+cmd('shell','pidof','cn.moyue.reader'),'-s','AndroidRuntime:E','*:S');assert.ok(!log.includes('FATAL EXCEPTION'));await fs.writeFile('test-results/release/runtime.log',log);await fs.writeFile('test-results/release-smoke.json',JSON.stringify({passed:checks.length,checks,android:'15',webview:'124.0.6367.219',package:'cn.moyue.reader'},null,2));console.log('Release smoke checks complete.');
