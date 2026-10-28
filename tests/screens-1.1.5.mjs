import {chromium} from 'playwright';
import {zipSync} from 'fflate';
import fs from 'node:fs/promises';
const out='test-results/upgrade-1.1.5';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:800,height:1067},deviceScaleFactor:2,hasTouch:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const enc=new TextEncoder(),b64=b=>Buffer.from(b).toString('base64');
function starDict(entries){
  const dictParts=[],idxParts=[];let offset=0;
  for(const [word,definition] of entries.sort((a,b)=>a[0].localeCompare(b[0],'en'))){
    const body=Buffer.from(definition,'utf8');
    const head=Buffer.alloc(4);head.writeUInt32BE(offset);
    const tail=Buffer.alloc(4);tail.writeUInt32BE(body.length);
    idxParts.push(Buffer.from(word+'\0','utf8'),head,tail);dictParts.push(body);offset+=body.length;
  }
  const idx=Buffer.concat(idxParts),dict=Buffer.concat(dictParts);
  const ifo=Buffer.from(`StarDict's dict ifo file\nversion=2.4.2\nwordcount=${entries.length}\nidxfilesize=${idx.length}\nbookname=汉英小词典\nauthor=moyue\nsametypesequence=m\n`,'utf8');
  return {ifo,idx,dict};
}
const D=starDict([['mountain','山；山脉；大量'],['wind','风；气流'],['page','页；书页'],['reading','阅读；读物']]);
const png=b64(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
const figEpub=(()=>{
  const files={'mimetype':enc.encode('application/epub+zip'),
    'META-INF/container.xml':enc.encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf':enc.encode(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>图表测试</dc:title><dc:creator>测试</dc:creator><dc:identifier id="id">fig</dc:identifier></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="pic.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    'OEBPS/ch1.xhtml':enc.encode('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>插图</title></head><body><h1>插图</h1><p>下面是一张示意图片，可以单独放大查看。</p><p><img src="pic.png" alt="示意图"/></p><p>后面的段落用来确认关闭图片后回到原来的句子。</p></body></html>'),
    'OEBPS/pic.png':Uint8Array.from(Buffer.from(png,'base64'))};
  return Buffer.from(zipSync(files,{level:6})).toString('base64');
})();
const shot=name=>page.screenshot({path:`${out}/${name}.png`});
async function ensureLibrary(){
  if(await page.locator('.library').count())return;
  if(await page.locator('.modal-backdrop').count())await page.keyboard.press('Escape');
  for(let i=0;i<4;i++){if(await page.locator('#reader-tools').isVisible())break;await page.mouse.click(400,30);await page.waitForTimeout(160);}
  await page.getByRole('button',{name:'书库',exact:true}).first().click();
  await page.waitForSelector('.library .book-card');
}
async function openBook(name){
  await ensureLibrary();
  await page.getByRole('button',{name:`阅读 ${name}`,exact:true}).first().click();
  await page.waitForFunction(()=>window.ReaderApp.state.doc&&!window.ReaderApp.state.busy,{timeout:60000});
}
await page.goto('http://127.0.0.1:4173');
await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6,{timeout:90000});

// dictionary + figure book
await page.evaluate(async files=>{await window.ReaderApp.importDictionary(Object.entries(files).map(([name,b])=>({name,data:()=>{const bin=atob(b),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer;}})));},{'mini.ifo':b64(D.ifo),'mini.idx':b64(D.idx),'mini.dict':b64(D.dict)});
await page.waitForFunction(()=>window.ReaderApp.state.dicts.length===1);
await page.evaluate(async b64=>{const bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);await window.ReaderApp.importBatch([new File([u],'图表测试.epub',{type:'application/epub+zip'})]);},figEpub);
await page.waitForFunction(()=>window.ReaderApp.state.books.some(b=>b.title==='图表测试'));

// 07 themes
await openBook('山间来信');
await page.mouse.click(400,30);
await page.getByRole('button',{name:'字体与排版设置'}).click();
await page.locator('[data-tab="theme"]').click();
await page.getByRole('button',{name:/管理主题/}).click();
await page.fill('#theme-name','我的小说排版');
await page.getByRole('button',{name:/保存当前排版/}).click();
await page.waitForSelector('.theme-row');
await shot('01-themes');

// 11 dictionary lookup
await page.keyboard.press('Escape');
await page.evaluate(()=>window.ReaderApp.showLookup('mountain',{text:'山里的时间很慢，慢得足够让人把一口气呼吸完整。',bookId:window.ReaderApp.state.book.id,bookTitle:'山间来信',locator:{chapter:0,anchor:0}}));
await page.waitForSelector('.lookup-entry');
await shot('02-dictionary');
await page.getByRole('button',{name:/加入生词本/}).click();
await page.waitForFunction(()=>window.ReaderApp.state.vocab.length===1);

// 14 vocabulary card
await page.evaluate(()=>window.ReaderApp.showVocab());
await page.waitForSelector('.vocab-row');
await shot('03-vocab-list');
await page.getByRole('button',{name:'开始卡片复习'}).click();
await page.waitForSelector('.card-word');
await shot('04-vocab-card');
await page.getByRole('button',{name:'显示释义'}).click();
await shot('05-vocab-answer');
await page.keyboard.press('Escape');

// 32 adjust range
await page.evaluate(async()=>{
  const book=window.ReaderApp.state.book,text=window.ReaderApp.state.doc.chapters[0].text;
  const at=text.indexOf('山间')>=0?text.indexOf('山间'):0;
  book.notes.push({id:'shot-adjust',chapter:0,start:at,end:at+6,text:text.slice(at,at+6),note:'这里记一笔：注意作者怎么写出安静。',created:Date.now(),view:'text'});
  await window.ReaderApp.flush();
  await window.ReaderApp.jump({chapter:0,anchor:at});
});
await page.mouse.click(400,30);
await page.getByRole('button',{name:'笔记',exact:true}).click();
await page.locator('[data-action="note-adjust"]').first().click();
await page.waitForSelector('.adjust-preview mark');
await page.getByRole('button',{name:/终点扩到句末/}).click();
await shot('06-adjust-range');
await page.getByRole('button',{name:'取消',exact:true}).click();

// 33 cross-page selection
await page.evaluate(()=>window.ReaderApp.selectRange(0,10));
await page.getByRole('button',{name:'扩到下一页'}).click();
await page.waitForFunction(()=>window.ReaderApp.state.selected.end>10&&!window.ReaderApp.state.turning&&!window.ReaderApp.state.busy,{timeout:30000});
await page.waitForTimeout(250);
await shot('07-cross-page-selection');
await page.getByRole('button',{name:'取消',exact:true}).click();

// 34 note search
await page.mouse.click(400,30);
await page.getByRole('button',{name:'笔记',exact:true}).click();
await page.getByRole('button',{name:/搜索批注/}).click();
await page.fill('#note-search-input','安静');
await page.getByRole('button',{name:'搜索',exact:true}).click();
await page.waitForSelector('#note-search-results .search-result');
await shot('08-note-search');
await page.keyboard.press('Escape');

// 39 library full-text search
await ensureLibrary();
await page.getByRole('button',{name:'搜索全部书籍正文'}).click();
await page.fill('#library-fulltext','山间');
await page.getByRole('button',{name:'搜索',exact:true}).click();
await page.waitForFunction(()=>window.ReaderApp.state.libraryResults?.length>0,{timeout:60000});
await shot('09-library-search');

// 10 image viewer
await page.keyboard.press('Escape');
await openBook('图表测试');
await page.locator('#flow img').first().click();
await page.waitForSelector('.image-viewer');
await page.waitForTimeout(300);
await shot('10-image-zoom');
await page.getByRole('button',{name:'关闭',exact:true}).last().click();

console.log('screens done, errors:',JSON.stringify(errors));
await browser.close();
