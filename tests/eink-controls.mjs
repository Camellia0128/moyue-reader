import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:800,height:1067},hasTouch:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const pass=name=>console.log('PASS '+name);
const settle=()=>page.waitForFunction(()=>!window.ReaderApp.state.turning&&!window.ReaderApp.state.busy);
const rootVar=name=>page.evaluate(key=>getComputedStyle(document.documentElement).getPropertyValue(key).trim(),name);
try{
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6,{timeout:90000});
  // A stub host: the real APK implements refreshScreen in Java, the browser only records calls.
  await page.evaluate(()=>{window.__refresh=0;window.Android={refreshScreen:full=>{if(full)window.__refresh++;},keepScreenOn:()=>{},setKeyTurns:()=>{},brightness:()=>{}};});
  await page.getByRole('button',{name:'阅读 山间来信',exact:true}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.paginator?.pages>2&&!window.ReaderApp.state.busy);

  // 1. Full refresh every N turns.
  await page.evaluate(()=>window.ReaderApp.settings.refreshEvery);
  await page.mouse.click(400,70);await page.waitForSelector('#reader-tools:not([hidden])');
  await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.getByRole('button',{name:'更多',exact:true}).last().click();
  await page.selectOption('select[data-key="refreshEvery"]','5');
  await page.getByRole('button',{name:'关闭'}).click();
  await page.waitForFunction(()=>!document.querySelector('.modal-backdrop'));
  assert.equal(await page.evaluate(()=>window.ReaderApp.settings.refreshEvery),5);
  for(let i=0;i<4;i++){await page.keyboard.press('ArrowRight');await settle();}
  assert.equal(await page.evaluate(()=>window.__refresh),0,'no refresh before the configured page count');
  await page.keyboard.press('ArrowRight');await settle();
  assert.equal(await page.evaluate(()=>window.__refresh),1,'the fifth turn asks the host for a full panel refresh');
  pass('Every N page turns triggers one full panel refresh through the host bridge');

  // 2. Stroke weight.
  await page.mouse.click(400,70);await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.getByRole('button',{name:'字体',exact:true}).click();
  const before=await rootVar('--reader-stroke');
  await page.getByRole('switch',{name:'字迹加深'}).click();
  assert.equal(await page.evaluate(()=>window.ReaderApp.settings.stroke),true);
  assert.notEqual(await rootVar('--reader-stroke'),before);
  assert.equal(await rootVar('--reader-stroke'),'0.35px');
  pass('Ink weight toggle thickens glyphs through a CSS variable');
  await page.getByRole('switch',{name:'字迹加深'}).click();

  // 3. System font scale.
  await page.evaluate(()=>{window.Android.systemFontScale=()=>1.5;});
  await page.getByRole('switch',{name:'跟随系统字体大小'}).click();
  await page.getByRole('switch',{name:'跟随系统字体大小'}).click();
  const scaled=await rootVar('--reader-size');
  assert.equal(scaled,'34.50px','23px base size follows the 1.5x system scale');
  await page.getByRole('switch',{name:'跟随系统字体大小'}).click();
  assert.equal(await rootVar('--reader-size'),'23.00px','turning it off restores the base size');
  pass('Reader font size follows the Android fontScale and can be switched off');
  await page.getByRole('button',{name:'关闭'}).click();

  // 4. Paper dwell is a real preference, not a constant.
  const dwellBefore=await page.evaluate(()=>window.ReaderApp.settings.dwell);
  assert.equal(dwellBefore,125);
  await page.mouse.click(400,70);await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.getByRole('button',{name:'更多',exact:true}).last().click();
  await page.selectOption('select[data-key="dwell"]','60');
  assert.equal(await page.evaluate(()=>window.ReaderApp.settings.dwell),60);
  await page.getByRole('button',{name:'关闭'}).click();
  await page.keyboard.press('ArrowRight');await settle();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('moyue-settings')).dwell),60,'dwell is persisted with the rest of the preferences');
  pass('Page-turn dwell is configurable and persisted');

  // 5. PDF contrast.
  await page.evaluate(()=>ReaderApp.flush());
  await page.waitForFunction(()=>!window.ReaderApp.state.turning);
  if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(400,70);
  await page.waitForSelector('#reader-tools:not([hidden])');
  await page.getByRole('button',{name:'书库',exact:true}).click();
  await page.waitForSelector('.library');
  await page.getByRole('button',{name:/阅读 城市与步行/}).first().click();
  await page.waitForSelector('#pdf-host .pdf-paper',{timeout:60000});
  await page.waitForFunction(()=>!window.ReaderApp.state.busy);
  if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(400,70);
  await page.waitForSelector('#reader-tools:not([hidden])');
  const baseContrast=await rootVar('--pdf-contrast');
  await page.getByRole('button',{name:/对比度/}).click();
  assert.equal(await rootVar('--pdf-contrast'),'1.25');
  await page.getByRole('button',{name:/对比度/}).click();
  assert.equal(await rootVar('--pdf-contrast'),'1.5');
  await page.getByRole('button',{name:/对比度/}).click();
  assert.equal(await rootVar('--pdf-contrast'),'1');
  assert.equal(baseContrast,'1');
  pass('PDF contrast cycles through three levels and returns to the neutral value');

  assert.deepEqual(errors,[],'no uncaught page errors');
  pass('No uncaught application errors in the e-ink controls');
} finally {
  await context.close();await browser.close();
}
