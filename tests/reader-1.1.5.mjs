import {chromium} from 'playwright';
import {zipSync, gzipSync} from 'fflate';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const context=await browser.newContext({viewport:{width:800,height:1067},hasTouch:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const pass=name=>console.log('PASS '+name);
const enc=new TextEncoder();
const b64=bytes=>Buffer.from(bytes).toString('base64');

/* ---------- fixtures: a real StarDict bundle and an EPUB with a figure ---------- */
function starDict(entries){
  const dictParts=[];const idxParts=[];let offset=0;
  for(const [word,definition] of entries.sort((a,b)=>a[0].localeCompare(b[0],'en'))){
    const body=Buffer.from(definition,'utf8');
    const head=Buffer.alloc(4);head.writeUInt32BE(offset);
    const tail=Buffer.alloc(4);tail.writeUInt32BE(body.length);
    idxParts.push(Buffer.from(word+'\0','utf8'),head,tail);
    dictParts.push(body);offset+=body.length;
  }
  const idx=Buffer.concat(idxParts),dict=Buffer.concat(dictParts);
  const ifo=Buffer.from(`StarDict's dict ifo file\nversion=2.4.2\nwordcount=${entries.length}\nidxfilesize=${idx.length}\nbookname=测试词典\nauthor=moyue\nsametypesequence=m\n`,'utf8');
  return {ifo,idx,dict};
}
const dictA=starDict([['apple','苹果；苹果树'],['book','书；书籍'],['reading','阅读；读物']]);
const dictB=starDict([['apple','苹果（第二部词典）'],['river','河流']]);
const png=b64(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
const figureEpub=(()=>{
  const files={
    'mimetype':enc.encode('application/epub+zip'),
    'META-INF/container.xml':enc.encode('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf':enc.encode(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>图表测试</dc:title><dc:creator>测试</dc:creator><dc:identifier id="id">moyue-figure</dc:identifier></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="pic.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    'OEBPS/ch1.xhtml':enc.encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>插图</title></head><body><h1>插图</h1><p>下面是一张图。<img src="pic.png" alt="示意图"/></p><p>后面的一段文字，用来确认关闭图片后仍回到原句。</p></body></html>`),
    'OEBPS/pic.png':Uint8Array.from(Buffer.from(png,'base64')),
  };
  return Buffer.from(zipSync(files,{level:6})).toString('base64');
})();

async function activeBook(){return page.evaluate(()=>window.ReaderApp.state.book?.title||'');}
async function ensureLibrary(){
  if(await page.locator('.library').count())return;
  if(await page.locator('#reader').count()){
    if(await page.locator('.modal-backdrop').count())await page.keyboard.press('Escape');
    for(let i=0;i<3;i++){
      if(await page.locator('#reader-tools').isVisible())break;
      await page.mouse.click(400,30);
      await page.waitForTimeout(160);
    }
    const shelf=page.getByRole('button',{name:'书库',exact:true}).first();
    if(await shelf.count())await shelf.click();
  }
  await page.waitForSelector('.library .book-card',{timeout:30000});
}
async function openBook(name){
  if(await page.locator('#reader').count()){
    if(await activeBook()===name){await page.waitForFunction(()=>!window.ReaderApp.state.busy);return;}
    await ensureLibrary();
  }
  await page.getByRole('button',{name:`阅读 ${name}`,exact:true}).first().click();
  await page.waitForFunction(()=>window.ReaderApp.state.doc&&!window.ReaderApp.state.busy,{timeout:60000});
}
async function showTools(){
  if(await page.locator('.modal-backdrop').count())await page.keyboard.press('Escape');
  for(let i=0;i<4;i++){
    if(await page.locator('#reader-tools').isVisible())return;
    await page.mouse.click(400,30);
    await page.waitForTimeout(160);
  }
  await page.waitForSelector('#reader-tools:not([hidden])',{timeout:10000});
}
async function importEpub(base64,name){
  await ensureLibrary();
  await page.evaluate(async({base64,name})=>{
    const bin=atob(base64),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    await window.ReaderApp.importBatch([new File([bytes],name,{type:'application/epub+zip'})]);
  },{base64,name});
  await page.waitForSelector('.library .book-card');
  await page.waitForFunction(n=>window.ReaderApp.state.books.some(b=>b.title===n),name.replace(/\.[^.]+$/,''),{timeout:60000});
}
async function importDict(files){
  await page.evaluate(async files=>{
    const items=Object.entries(files).map(([name,b64])=>({name,data:()=>{
      const bin=atob(b64),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
      return bytes.buffer;
    }}));
    await window.ReaderApp.importDictionary(items);
  },files);
}

try{
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6,{timeout:90000});

  /* 1. 07 custom themes */
  await openBook('山间来信');
  await showTools();
  await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.locator('[data-tab="theme"]').click();
  await page.getByRole('button',{name:/管理主题/}).click();
  await page.fill('#theme-name','我的小说排版');
  await page.getByRole('button',{name:/保存当前排版/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.theme-row').length===1);
  const themed=await page.evaluate(()=>window.ReaderApp.themeList()[0]);
  assert.equal(themed.name,'我的小说排版');
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  await showTools();
  await page.getByRole('button',{name:'字体与排版设置'}).click();
  await page.locator('[data-tab="font"]').click();
  await page.getByRole('button',{name:'增大字号'}).click();
  const bigger=await page.evaluate(()=>window.ReaderApp.settings.size);
  assert.ok(bigger>23);
  await page.locator('[data-tab="theme"]').click();
  await page.getByRole('button',{name:/管理主题/}).click();
  await page.getByRole('button',{name:'应用',exact:true}).click();
  await page.waitForFunction(()=>window.ReaderApp.settings.size===23);
  pass('07 theme saves the current typography and restores it');
  await page.getByRole('button',{name:/管理主题/}).click().catch(()=>{});
  await page.evaluate(()=>window.ReaderApp.showThemes());
  await page.getByRole('button',{name:'改名'}).click();
  await page.fill('#theme-rename','小说排版·改');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>window.ReaderApp.themeList()[0]?.name==='小说排版·改');
  await page.reload();
  await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6,{timeout:90000});
  assert.equal(await page.evaluate(()=>window.ReaderApp.themeList()[0].name),'小说排版·改','theme survives a restart');
  await page.evaluate(()=>window.ReaderApp.showThemes());
  await page.getByRole('button',{name:'删除'}).click();
  await page.waitForFunction(()=>window.ReaderApp.themeList().length===0);
  pass('07 themes can be renamed, persist across restarts and be deleted');

  /* 2. 10 figure zoom */
  await importEpub(figureEpub,'图表测试.epub');
  await openBook('图表测试');
  await page.locator('#flow img').first().click();
  await page.waitForSelector('.image-viewer');
  const stageBox=await page.locator('.image-stage').boundingBox();
  await page.mouse.move(stageBox.x+stageBox.width/2,stageBox.y+stageBox.height/2);
  await page.mouse.wheel(0,-300);
  const scaled=await page.evaluate(()=>getComputedStyle(document.querySelector('.image-stage img')).transform);
  assert.notEqual(scaled,'none','wheel zoom changes the image transform');
  await page.getByRole('button',{name:'适应屏幕'}).click();
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.waitForFunction(()=>!document.querySelector('.image-viewer'));
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.chapter),0,'closing the viewer keeps the page');
  pass('10 tapping a figure opens a zoomable viewer and closes back to the same page');
  await page.evaluate(()=>{window.ReaderApp.openImageViewer('data:image/png;base64,AAAA','损坏图片');});
  await page.waitForSelector('.image-viewer');
  await page.waitForFunction(()=>document.querySelector('.image-stage')?.textContent.includes('无法显示'),null,{timeout:10000});
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  pass('10 a broken image reports the problem instead of a blank screen');

  /* 3. 11 dictionary import and lookup */
  await importDict({'test.ifo':b64(dictA.ifo),'test.idx':b64(dictA.idx),'test.dict':b64(dictA.dict)});
  await page.waitForFunction(()=>window.ReaderApp.state.dicts.length===1,{timeout:30000});
  const hit=await page.evaluate(()=>window.ReaderApp.lookupWord('apple'));
  assert.equal(hit.results.length,1);
  assert.match(hit.results[0].definition,/苹果/);
  pass('11 a real StarDict bundle imports and returns its actual definition');
  await importDict({'bad.ifo':b64(Buffer.from("Not a dictionary\nversion=2.4.2\n")), 'bad.idx':b64(dictA.idx), 'bad.dict':b64(dictA.dict)});
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.innerText.includes('词典未能导入'),null,{timeout:20000});
  await page.getByRole('button',{name:'知道了'}).click();
  pass('11 an invalid .ifo is rejected with a readable message');
  const miss=await page.evaluate(()=>window.ReaderApp.lookupWord('zzzzzz'));
  assert.equal(miss.results.length,0);
  pass('11 an unknown word reports no match instead of a fake definition');

  /* 4. 11/14 lookup from the page, add to vocabulary, review card */
  await openBook('山间来信');
  await page.evaluate(()=>{
    const text=window.ReaderApp.state.doc.chapters[0].text;
    const at=text.indexOf('山间');
    window.ReaderApp.state.selected={start:at,end:at+2,text:'apple'};
    window.ReaderApp.showLookup('apple',{text:text.slice(at,at+20),bookId:window.ReaderApp.state.book.id,bookTitle:window.ReaderApp.state.book.title,locator:{chapter:0,anchor:at}});
  });
  await page.waitForSelector('.lookup-entry');
  assert.match(await page.locator('.lookup-def').first().innerText(),/苹果/);
  await page.getByRole('button',{name:/加入生词本/}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.vocab.length===1);
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.evaluate(()=>window.ReaderApp.showLookup('apple',{text:'apple',bookId:window.ReaderApp.state.book.id,bookTitle:window.ReaderApp.state.book.title,locator:{chapter:0,anchor:0}}));
  await page.waitForSelector('.lookup-entry');
  await page.getByRole('button',{name:/加入生词本/}).click();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>window.ReaderApp.state.vocab.length),1,'the same word is not duplicated');
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.evaluate(()=>window.ReaderApp.showVocab());
  await page.waitForSelector('.vocab-row');
  await page.getByRole('button',{name:'复习',exact:true}).click();
  await page.getByRole('button',{name:'显示释义'}).click();
  await page.getByRole('button',{name:'认识',exact:true}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.vocab[0].state==='known');
  pass('14 vocabulary dedupes, shows a card and records the review result');
  await page.evaluate(()=>window.ReaderApp.showVocab('known'));
  await page.waitForSelector('.vocab-row');
  await page.getByRole('button',{name:'原文',exact:true}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.route==='reader');
  pass('14 a vocabulary entry jumps back to its source sentence');

  /* 5. 32 adjust an existing highlight */
  await page.evaluate(async()=>{
    const book=window.ReaderApp.state.book,text=window.ReaderApp.state.doc.chapters[0].text;
    const at=text.indexOf('山间');
    book.notes.push({id:'adj-1',chapter:0,start:at,end:at+2,text:text.slice(at,at+2),note:'保留的笔记',created:Date.now(),view:'text'});
    book.notes.push({id:'adj-2',chapter:0,start:at+6,end:at+8,text:text.slice(at+6,at+8),note:'',created:Date.now(),view:'text'});
    await window.ReaderApp.flush();
    await window.ReaderApp.jump({chapter:0,anchor:at});
  });
  await page.waitForFunction(()=>document.querySelectorAll('mark[data-note]').length===2);
  await showTools();
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.locator('[data-action="note-adjust"]').first().click();
  await page.waitForSelector('.adjust-preview mark');
  const beforeText=await page.locator('.adjust-preview mark').innerText();
  await page.getByRole('button',{name:/终点 \+1 字/}).click();
  const afterText=await page.locator('.adjust-preview mark').innerText();
  assert.equal(afterText.length,beforeText.length+1,'the preview grows by one character');
  await page.getByRole('button',{name:'保存范围'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.book.notes.find(n=>n.id==='adj-1').text.length>2);
  const adjusted=await page.evaluate(()=>window.ReaderApp.state.book.notes.find(n=>n.id==='adj-1'));
  assert.ok(adjusted.text.length>2);
  assert.equal(adjusted.note,'保留的笔记','the note body is preserved');
  const neighbour=await page.evaluate(()=>window.ReaderApp.state.book.notes.find(n=>n.id==='adj-2'));
  assert.equal(neighbour.start,adjusted.start+6);
  pass('32 adjusting a highlight keeps its note identity and leaves the neighbour untouched');

  /* 6. 33 cross-page selection */
  await page.evaluate(()=>window.ReaderApp.jump({chapter:0,anchor:0}));
  await page.waitForFunction(()=>!window.ReaderApp.state.busy&&!window.ReaderApp.state.turning);
  await page.evaluate(()=>window.ReaderApp.selectRange(0,8));
  await page.getByRole('button',{name:'扩到下一页'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.selected.end>8,{timeout:30000});
  const extended=await page.evaluate(()=>window.ReaderApp.state.selected);
  assert.ok(extended.end>8,'the selection extends past the visible page');
  await page.getByRole('button',{name:'划线'}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.book.notes.some(n=>n.id!=='adj-1'&&n.id!=='adj-2'));
  pass('33 a selection can be extended across pages and saved as one highlight');

  /* 7. 34 note search */
  await showTools();
  await page.getByRole('button',{name:'笔记',exact:true}).click();
  await page.getByRole('button',{name:/搜索批注/}).click();
  await page.fill('#note-search-input','保留的笔记');
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await page.waitForSelector('#note-search-results .search-result');
  assert.match(await page.locator('#note-search-results').innerText(),/保留的笔记/);
  await page.locator('#note-search-results .search-result').first().click();
  await page.waitForFunction(()=>window.ReaderApp.state.route==='reader');
  pass('34 note search finds a keyword in the note body and jumps to it');

  /* 8. 39 library-wide full-text search */
  await ensureLibrary();
  await page.getByRole('button',{name:'搜索全部书籍正文'}).click();
  await page.fill('#library-fulltext','山间');
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await page.waitForFunction(()=>window.ReaderApp.state.libraryResults?.length>0,{timeout:60000});
  const grouped=await page.locator('.result-book').count();
  assert.ok(grouped>=2,'results are grouped by book');
  const firstBook=await page.locator('.result-book').first().innerText();
  await page.locator('#library-search-results .search-result').first().click();
  await page.waitForFunction(()=>window.ReaderApp.state.route==='reader');
  pass('39 library-wide search returns grouped hits and opens the matching passage');
  await ensureLibrary();
  await page.waitForFunction(()=>document.querySelector('#library-fulltext')?.value==='山间',null,{timeout:20000});
  assert.ok(await page.locator('#library-search-results .search-result').count()>0,'the result list is still there after returning');
  pass('39 returning to the library keeps the query and the results');
  assert.ok((await page.locator('.result-book').first().innerText()).length>0);

  /* 9. backup carries themes and vocabulary; old backups still restore */
  await page.evaluate(()=>{window.ReaderApp.saveThemes([{id:'t1',name:'备份主题',created:Date.now(),values:{size:27,line:2,margin:9,weight:400,font:'serif',align:'justify',publisher:true}}]);});
  const backupOk=await page.evaluate(async()=>{
    const blob=await window.ReaderApp.createBackup();
    const bytes=new Uint8Array(await blob.arrayBuffer());
    let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {text:btoa(out),size:blob.size};
  });
  const restored=await page.evaluate(async text=>{
    const bin=atob(text),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    localStorage.removeItem('moyue-themes');
    await window.ReaderApp.restoreLibrary(new Blob([bytes]));
    return {themes:window.ReaderApp.themeList().length,vocab:window.ReaderApp.state.vocab.length};
  },backupOk.text);
  assert.equal(restored.themes,1,'themes survive a full backup round-trip');
  assert.equal(restored.vocab,1,'vocabulary survives a full backup round-trip');
  pass('Full backup restores themes and vocabulary');

  assert.deepEqual(errors,[],'no uncaught page errors');
  pass('No uncaught application errors in the eight-feature update');
} finally {
  await context.close();await browser.close();
}
