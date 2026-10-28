import {chromium} from 'playwright';
import {zipSync} from 'fflate';
import fs from 'node:fs/promises';
const out='test-results/upgrade-1.1.3';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:800,height:1067},deviceScaleFactor:2,hasTouch:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const enc=new TextEncoder();
const files={
  'mimetype':enc.encode('application/epub+zip'),
  'META-INF/container.xml':enc.encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/content.opf':enc.encode(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>山间来信·注释本</dc:title><dc:creator>本地文档</dc:creator><dc:identifier id="id">moyue-shot</dc:identifier></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
  'OEBPS/ch1.xhtml':enc.encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>第一封信</title></head><body><h1>第一封信</h1><p>山间的风翻过书页，把清晨的凉意留在纸上。写信的人说，他每天早上都会读上几页，读到光从窗棂移到桌面。<a epub:type="noteref" href="ch2.xhtml#fn1">[1]</a></p><p>我们总以为阅读需要一整段安静的时间，其实只要几分钟，句子就会自己接续下去。翻页的动作，比任何提醒都更像一种约定。</p><p>第二段之后还有很长的路要走，纸面上的字迹并不着急，它们只是安静地等在那里。</p></body></html>`),
  'OEBPS/ch2.xhtml':enc.encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>注释</title></head><body><h1>注释</h1><p id="fn1">[1] 出自一封 1936 年的旧信，收信人姓名已不可考。原信存于地方档案馆，此处据影印件录出。</p><p>信件其余部分缺失。</p></body></html>`),
};
const b64=Buffer.from(zipSync(files,{level:6})).toString('base64');
await page.goto('http://127.0.0.1:4173');
await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6,{timeout:90000});
await page.evaluate(async b64=>{const bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);await window.ReaderApp.importBatch([new File([u],'山间来信·注释本.epub',{type:'application/epub+zip'})]);},b64);
await page.waitForFunction(()=>window.ReaderApp.state.books.some(b=>b.title==='山间来信·注释本'),{timeout:60000});
await page.waitForTimeout(1200);
await page.screenshot({path:`${out}/01-library.png`});

await page.getByRole('button',{name:'阅读 山间来信·注释本',exact:true}).click();
await page.waitForFunction(()=>window.ReaderApp.state.doc&&!window.ReaderApp.state.busy,{timeout:60000});
await page.screenshot({path:`${out}/02-reading.png`});

await page.locator('#flow a.noteref').first().click();
await page.waitForSelector('[role="dialog"]');
await page.screenshot({path:`${out}/03-footnote.png`});
await page.getByRole('button',{name:'留在原页'}).click();

await page.mouse.click(400,70);
await page.getByRole('button',{name:'字体与排版设置'}).click();
await page.getByRole('button',{name:'字体',exact:true}).click();
await page.screenshot({path:`${out}/04-settings-font.png`});
await page.getByRole('button',{name:'版式'}).click();
await page.getByRole('button',{name:'仅此书'}).click();
await page.waitForTimeout(400);
await page.screenshot({path:`${out}/05-settings-scope.png`});
await page.getByRole('button',{name:'全局'}).click();
await page.getByRole('button',{name:'关闭'}).click();

await page.evaluate(async()=>{
  const b=window.ReaderApp.state.book,t=b.notes.length?b.notes[0].text:'';
  b.notes.push({id:'shot-note',chapter:0,start:b.notes.length?0:0,end:4,text:window.ReaderApp.state.doc.chapters[0].text.slice(0,4),note:'这里记一笔：注意作者对光的描写。',created:Date.now(),view:'text'});
  await window.ReaderApp.flush();
  await window.ReaderApp.jump({chapter:0,anchor:0});
});
await page.waitForTimeout(600);
if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(400,70);
await page.getByRole('button',{name:'笔记',exact:true}).click();
await page.waitForSelector('[role="dialog"]');
await page.screenshot({path:`${out}/06-annotations.png`});
await page.locator('[data-action="note-delete"]').last().click();
await page.waitForSelector('[role="dialog"]');
await page.screenshot({path:`${out}/07-delete-confirm.png`});
await page.getByRole('button',{name:'取消',exact:true}).click();

if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(400,70);
await page.getByRole('button',{name:'页面预览'}).click();
await page.waitForSelector('.real-preview img',{timeout:30000}).catch(()=>{});
await page.waitForTimeout(1200);
await page.screenshot({path:`${out}/08-preview.png`});
await page.getByRole('button',{name:'返回原页'}).click();

await page.mouse.click(400,70);
await page.getByRole('button',{name:'书库',exact:true}).first().click();
await page.waitForSelector('.library');
await page.getByRole('button',{name:/阅读 城市与步行/}).first().click();
await page.waitForSelector('#pdf-host .pdf-paper',{timeout:60000});
await page.waitForFunction(()=>!window.ReaderApp.state.busy);
if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(400,70);
await page.getByRole('button',{name:/分栏/}).click();
await page.waitForFunction(()=>window.ReaderApp.state.book.pdfView?.column==='lr'&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.turning,{timeout:30000});
await page.screenshot({path:`${out}/09-pdf-column.png`});

await page.mouse.click(400,70);
await page.getByRole('button',{name:'字体与排版设置'}).click();
await page.locator('[data-tab="more"]').click();
await page.getByRole('switch',{name:'墨水屏模式'}).click();
await page.waitForTimeout(400);
await page.screenshot({path:`${out}/10-eink-mode.png`});
await page.getByRole('switch',{name:'墨水屏模式'}).click();
await page.getByRole('button',{name:'关闭'}).click();

console.log('screenshots written, errors:',JSON.stringify(errors));
await browser.close();
