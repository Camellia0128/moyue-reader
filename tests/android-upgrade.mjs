import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const adb='F:/MoyueReaderTools/sdk/platform-tools/adb.exe',serial='emulator-5554';
const cmd=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:60000,windowsHide:true}).trim();
function dump(){cmd('shell','uiautomator','dump','/sdcard/moyue-upgrade.xml');return cmd('shell','cat','/sdcard/moyue-upgrade.xml');}
async function wait(test){for(let i=0;i<20;i++){const xml=dump();if(test(xml))return xml;await new Promise(r=>setTimeout(r,300));}throw new Error('Upgrade UI wait failed');}
const beforePackage=cmd('shell','dumpsys','package','cn.moyue.reader');assert.ok(beforePackage.includes('versionName=1.0.0'));
cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');const before=await wait(x=>x.includes('切换阅读进度显示'));
const savedPercent=before.match(/text="(\d+)%"/)?.[1];assert.ok(savedPercent);
assert.ok(cmd('install','-r',path.resolve('app/build/outputs/apk/release/app-release.apk')).includes('Success'));
const afterPackage=cmd('shell','dumpsys','package','cn.moyue.reader');assert.ok(afterPackage.includes('versionName=1.0.1'));
cmd('shell','am','start','-n','cn.moyue.reader/.MainActivity');await wait(x=>x.includes('切换阅读进度显示')&&x.includes(`text="${savedPercent}%"`));
await fs.writeFile('test-results/pdf-fix-release-upgrade.json',JSON.stringify({passed:true,from:'1.0.0',to:'1.0.1',install:'adb install -r (no uninstall or clear data)',savedPercent},null,2));
console.log('PASS Same-signature release update installs over 1.0.0 and preserves reading progress without clearing data');
