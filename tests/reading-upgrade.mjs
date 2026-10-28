import {chromium} from 'playwright';
import {zipSync} from 'fflate';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:800,height:1067},hasTouch:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const pass=name=>console.log('PASS '+name);
const enc=new TextEncoder();

/* A minimal EPUB whose first chapter links to a footnote in the second chapter. */
function footnoteEpub(){
  const files={
    'mimetype':enc.encode('application/epub+zip'),
    'META-INF/container.xml':enc.encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf':enc.encode(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>脚注测试</dc:title><dc:creator>测试</dc:creator><dc:identifier id="id">moyue-footnote-test</dc:identifier><dc:language>zh-CN</dc:language></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/ch1.xhtml':enc.encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>第一章</title></head><body><h1>第一章</h1><p>山间的风翻过书页，这是一段用于测试的正文。<a epub:type="noteref" href="ch2.xhtml#fn1">[1]</a>后面还有一句话，用来确认阅读位置不会因为预览注释而改变。</p><p>第二段继续说明排版与定位的关系，保证分页之后仍有足够多的文字可以测量。</p></body></html>`),
    'OEBPS/ch2.xhtml':enc.encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>注释</title></head><body><h1>注释</h1><p id="fn1">[1] 这是注释原文：出自某本旧书的边注，用于验证脚注预览。</p><p>正文结束。</p></body></html>`),
  };
  return Buffer.from(zipSync(files,{level:6})).toString('base64');
}
const epub=footnoteEpub();

async function openBookByName(name){
  if(await page.locator('#reader').count()){
    const title=await page.evaluate(()=>window.ReaderApp.state.book?.title);
    if(title===name){await page.waitForFunction(()=>!window.ReaderApp.state.busy,{timeout:60000});return;}
    await showTools();
    await page.getByRole('button',{name:'书库',exact:true}).first().click();
  }
  await page.waitForSelector('.library .book-card');
  await page.getByRole('button',{name:`阅读 ${name}`,exact:true}).first().click();
  await page.waitForFunction(()=>window.ReaderApp.state.doc&&!window.ReaderApp.state.busy,{timeout:60000});
}
async function showTools(){
  if(!await page.locator('#reader-tools').isVisible())await page.mouse.click(400,70);
  await page.waitForSelector('#reader-tools:not([hidden])');
}

try{
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6,{timeout:90000});
  await page.evaluate(async b64=>{
    const bin=atob(b64),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    await window.ReaderApp.importBatch([new File([bytes],'脚注测试.epub',{type:'application/epub+zip'})]);
  },epub);
  await page.waitForSelector('.library .book-card');
  await page.waitForFunction(()=>window.ReaderApp.state.books.some(b=>b.title==='脚注测试'),{timeout:60000});

  /* 1. footnote preview keeps the reading position */
  await openBookByName('脚注测试');
  const before=await page.evaluate(()=>({chapter:window.ReaderApp.state.chapter,page:window.ReaderApp.state.paginator.page,anchor:window.ReaderApp.state.book.locator.anchor}));
  assert.equal(await page.locator('#flow a.noteref').count(),1,'the footnote marker survives sanitising');
  await page.locator('#flow a.noteref').first().click();
  await page.waitForSelector('[role="dialog"]');
  const dialog=await page.locator('[role="dialog"]').innerText();
  assert.match(dialog,/脚注预览|注释原文/);
  await page.getByRole('button',{name:'留在原页'}).click();
  const after=await page.evaluate(()=>({chapter:window.ReaderApp.state.chapter,page:window.ReaderApp.state.paginator.page}));
  assert.deepEqual(after,{chapter:before.chapter,page:before.page},'preview does not move the reader');
  pass('EPUB footnote opens as a preview without changing the reading position');

  /* 2. jump to the note and come back through history */
  await page.locator('#flow a.noteref').first().click();
  await page.getByRole('button',{name:'跳到注释原文'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.chapter===1&&!window.ReaderApp.state.busy);
  await showTools();
  await page.getByRole('button',{name:'返回上一个位置'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.chapter===0&&!window.ReaderApp.state.busy);
  pass('Footnote jump is reversible through the in-book history');

  /* 3. delete a highlight from the book list, with persistence */
  await page.evaluate(async()=>{
    const state=window.ReaderApp.state,book=state.book;
    const text=state.doc.chapters[0].text;
    const a=text.indexOf('山间'),b=text.indexOf('后面');
    book.notes.push({id:'note-a',chapter:0,start:a,end:a+4,text:text.slice(a,a+4),note:'删除测试',created:Date.now(),view:'text'});
    book.notes.push({id:'note-b',chapter:0,start:b,end:b+4,text:text.slice(b,b+4),note:'',created:Date.now(),view:'text'});
    await window.ReaderApp.flush();
    await window.ReaderApp.jump({chapter:0,anchor:0});
  });
  await page.waitForFunction(()=>document.querySelectorAll('mark[data-note]').length===2);
  await showTools();
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.waitForSelector('[role="dialog"]');
  const buttons=page.locator('[data-action="note-delete"]');
  assert.equal(await buttons.count(),2,'both annotations are listed with a delete entry');
  await buttons.first().click();
  await page.waitForSelector('[role="dialog"]');
  assert.match(await page.locator('[role="dialog"]').innerText(),/附有笔记/,'deleting a note explains that the note body goes too');
  await page.getByRole('button',{name:'删除',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('mark[data-note="note-a"]').length===0);
  assert.equal(await page.locator('mark[data-note="note-b"]').count(),1,'the neighbouring highlight is untouched');
  await page.reload();
  await openBookByName('脚注测试');
  await page.waitForFunction(()=>window.ReaderApp.state.paginator);
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.book.notes.length),1,'deletion survives a restart');
  assert.equal(await page.locator('mark[data-note="note-a"]').count(),0);
  pass('Deleting one highlight removes its mark, keeps its neighbour and survives a reload');

  /* 4. cancel leaves the record alone */
  await showTools();
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.locator('[data-action="note-delete"]').first().click();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('mark[data-note]').length===1);
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.book.notes.length),1);
  pass('Cancelling the delete dialog keeps the highlight');

  /* 5. bookmarks can be removed from the list */
  await showTools();
  await page.getByRole('button',{name:'添加书签'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.book.bookmarks.length===1);
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.locator('[data-action="bookmarks"]').click();
  await page.getByRole('button',{name:'删除书签'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.book.bookmarks.length===0&&document.querySelector('#toast')?.textContent==='已删除书签');
  await page.reload();
  await openBookByName('脚注测试');
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.book.bookmarks.length),0,'bookmark deletion persists');
  pass('Bookmarks can be deleted from the list and stay deleted');

  /* 6. per-book typography does not leak into other books */
  await showTools();
  await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.getByRole('button',{name:'版式'}).click();
  await page.getByRole('button',{name:'仅此书'}).click();
  await page.getByRole('button',{name:'字体',exact:true}).click();
  await page.getByRole('button',{name:'增大字号'}).click();
  const bookSize=await page.evaluate(()=>window.ReaderApp.settings.size);
  assert.ok(bookSize>23);
  await page.getByRole('button',{name:'关闭'}).click();
  await showTools();
  await page.getByRole('button',{name:'书库',exact:true}).first().click();
  await page.waitForSelector('.library');
  const globalSize=await page.evaluate(()=>JSON.parse(localStorage.getItem('moyue-settings')).size);
  assert.equal(globalSize,23,'the global profile keeps its own size');
  await openBookByName('脚注测试');
  assert.equal(await page.evaluate(()=>window.ReaderApp.settings.size),bookSize,'the book remembers its own size');
  await showTools();
  await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.getByRole('button',{name:'版式'}).click();
  await page.getByRole('button',{name:'全局'}).click();
  await page.waitForFunction(()=>window.ReaderApp.settings.size===23);
  pass('Per-book typography stays with the book and can be reset to global');

  /* 7. reading-time estimate refuses to fake precision */
  await page.getByRole('button',{name:'关闭'}).click();
  await page.evaluate(()=>{localStorage.removeItem('moyue-speed');window.ReaderApp.settings.progress=4;});
  await page.evaluate(()=>window.ReaderApp.requestReflow());
  await page.waitForFunction(()=>document.querySelector('#progress-label')?.textContent.includes('学习中'),null,{timeout:10000});
  pass('Reading-time progress states "learning" until enough samples exist');

  /* 7b. e-ink mode removes decoration but keeps the selected state readable */
  await showTools();
  await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.locator('[data-tab="more"]').click();
  await page.getByRole('switch',{name:'墨水屏模式'}).click();
  await page.waitForFunction(()=>document.documentElement.classList.contains('eink'));
  const decorated=await page.evaluate(()=>getComputedStyle(document.querySelector('.sheet')).boxShadow);
  assert.equal(decorated,'none','e-ink mode drops decorative shadows');
  await page.getByRole('switch',{name:'墨水屏模式'}).click();
  await page.waitForFunction(()=>!document.documentElement.classList.contains('eink'));
  await page.getByRole('button',{name:'关闭'}).click();
  pass('E-ink mode is a real rendering switch that leaves the reading surface intact');

  /* 8. PDF column mode splits a page into two readable halves */
  await page.getByRole('button',{name:'书库',exact:true}).first().click().catch(async()=>{await showTools();await page.getByRole('button',{name:'书库',exact:true}).first().click();});
  await page.waitForSelector('.library');
  await page.getByRole('button',{name:/阅读 城市与步行/}).first().click();
  await page.waitForSelector('#pdf-host .pdf-paper',{timeout:60000});
  await page.waitForFunction(()=>!window.ReaderApp.state.busy);
  await showTools();
  await page.getByRole('button',{name:/分栏/}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.book.pdfView?.column==='lr'&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.turning);
  const geometry=await page.evaluate(()=>{const paper=document.querySelector('#pdf-host .pdf-paper');return{full:Number(paper.dataset.fullWidth),width:paper.getBoundingClientRect().width,host:document.querySelector('#pdf-host').clientWidth};});
  assert.ok(geometry.full>geometry.width*1.6,'the visible half is roughly half of the page');
  assert.ok(Math.abs(geometry.width-geometry.host)<12,'the column fills the viewport width');
  for(let i=0;i<12&&await page.evaluate(()=>ReaderApp.state.pdfColumnIndex===0);i++){await page.keyboard.press('ArrowRight');await page.waitForTimeout(250);}
  await page.waitForFunction(()=>window.ReaderApp.state.pdfColumnIndex===1&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.turning);
  for(let i=0;i<12&&await page.evaluate(()=>ReaderApp.state.pdfPage===0);i++){await page.keyboard.press('ArrowRight');await page.waitForTimeout(250);}
  await page.waitForFunction(()=>window.ReaderApp.state.pdfPage===1&&window.ReaderApp.state.pdfColumnIndex===0&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.turning);
  pass('PDF column mode shows one half at a time and advances column by column');

  /* 9. odd/even crop settings are remembered separately */
  await page.evaluate(()=>{window.ReaderApp.state.pdfPage=0;window.ReaderApp.state.pdfColumnIndex=0;});
  await showTools();
  for(let i=0;i<3;i++){
    if(await page.evaluate(()=>window.ReaderApp.state.book.pdfView?.column==='off'))break;
    await page.getByRole('button',{name:/分栏/}).click();
    await page.waitForFunction(()=>!window.ReaderApp.state.busy&&!window.ReaderApp.state.turning);
    await showTools();
  }
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.book.pdfView?.column),'off','column mode can be switched off again');
  await showTools();
  await page.getByRole('button',{name:/裁白边/}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.book.pdfView?.cropOdd===true);
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.book.pdfView.cropEven),false,'the even pages keep their own setting');
  pass('Crop is stored separately for odd and even pages');

  assert.deepEqual(errors,[],'no uncaught page errors');
  pass('No uncaught application errors in the 1.1.3 reading upgrade');
} finally {
  await context.close();await browser.close();
}
