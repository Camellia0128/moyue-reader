import './style.css';
import { allBooks, get, putBook, putProgress, insertBook, deleteBook, allDicts, deleteDictRecord, allVocab, putVocabRecord, deleteVocabRecord,putVocabBatch,putDocument } from './storage.js';
import { parseFile, escapeHtml as esc, prepareDocument } from './formats.js';
import { icon } from './icons.js';
import { Paginator } from './paginator.js';
import {nativePdfAvailable,nativePdfResult,renderNativePdfPage} from './native-pdf.js';
import {openPdfDocument} from './pdf-open.js';
import {createBackup,restoreBackup,saveBackup} from './backup.js';
import {defaults,normalizeSettings,withBookProfile,pickBookProfile,bookKeys} from './settings.js';
import {parseIfo,groupBundles} from './dict.js';
import {dictionaryJob,cancelDictionaryWork} from './dict-service.js';
import {reviewSchedule,resetLearning,isDue} from './vocabulary.js';
import {searchLibrary,clearSearchMemory,clearSearchCache,searchMemoryBytes} from './library-search.js';
import {protectDocumentImages,budgetImage} from './image-budget.js';
import {fragmentsOf,rotateRect,pdfPageModel,locateFragment,layerSelection} from './pdf-notes.js';

const $=(selector,root=document)=>root.querySelector(selector);
let storedSettings=null;try{const raw=localStorage.getItem('moyue-settings');if(raw)storedSettings=JSON.parse(raw);}catch{storedSettings=null;}
let settings=normalizeSettings(storedSettings||{});
// normalizeSettings only owns known keys; the imported font family rides along separately.
if(typeof storedSettings?.customFont==='string')settings.customFont=storedSettings.customFont;
/** The persisted profile. `settings` may temporarily be a book-specific merge of this object. */
const globalSettings=settings;
// One-time migration for the 1.1.0 paper palette. It must never overwrite a theme the reader
// already chose, so it only seeds a profile that has no saved preferences yet.
if(!localStorage.getItem('moyue-paper-v2')){if(!storedSettings){settings.animation='paper';settings.theme='paper';}localStorage.setItem('moyue-paper-v2','1');}
const rendererRecovery=new URLSearchParams(location.search).get('recover')==='renderer';
const state={books:[],route:'library',query:'',filter:'all',collection:'',sort:'recent',view:localStorage.getItem('moyue-view')||'grid',book:null,doc:null,chapter:0,pdfPage:0,pdf:null,paginator:null,tools:false,busy:false,zoom:1,rotation:0,crop:false,selected:null,aaTab:'font',battery:null,searchNonce:0,backgroundWorkDisabled:rendererRecovery,dicts:[],dictCache:new Map(),vocab:[],libraryIndex:null,libraryResults:null,libraryQuery:''};
let saveTimer,resizeTimer,toastTimer,importChain=Promise.resolve(),renderNonce=0,textRenderNonce=0,readerGeneration=0;
const app=$('#app'),overlays=$('#overlay-root'),pdfRenderJobs=new WeakMap();
function toast(message){const node=$('#toast');node.textContent=message;node.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),3600);}
function actionButton(action,label,ico='',extra=''){return `<button data-action="${action}" ${extra}>${ico?icon(ico):''}${esc(label)}</button>`;}
function iconButton(action,label,ico,extra=''){return `<button class="icon-button" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(ico)}</button>`;}
function time(){return new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});}
function status(){return `<div class="status-row"><span data-clock>${time()}</span><span class="status-brand">墨阅</span><span class="status-right">${state.battery!==null?`${state.battery}% <span class="battery"><i style="width:${state.battery}%"></i></span>`:'离线阅读'}</span></div>`;}
function coverArt(style){
  const mountains='<path d="M-20 300 75 170 115 220 180 100 275 250 330 170 440 330V500H-20Z" fill="#aaaFA5"/><path d="M-20 350 110 220 170 290 260 200 410 400V500H-20Z" fill="#7b8278"/><path d="M-20 415 90 335 165 390 280 280 440 450V500H-20Z" fill="#545d52"/>';
  const lines='<g stroke="#72766c" fill="none" stroke-width="1.1"><path d="M-40 370Q80 180 200 340T450 270M-40 390Q80 200 200 360T450 290M-40 410Q80 220 200 380T450 310M-40 430Q80 240 200 400T450 330M-40 450Q80 260 200 420T450 350M-40 470Q80 280 200 440T450 370"/></g>';
  const blocks='<g fill="none" stroke="#888c80"><path d="M90 500V270h75v230M180 500V220h90v280M285 500V300h65v200"/><path d="M105 290h45m-45 25h45m-45 25h45m-45 25h45m-45 25h45M195 245h60m-60 27h60m-60 27h60m-60 27h60m-60 27h60m-60 27h60"/></g>';
  return `<svg class="cover-art" viewBox="0 0 400 570" preserveAspectRatio="xMidYMax slice">${style===1||style===5?mountains:style===2?blocks:lines}</svg>`;
}
function cover(book,mini=false){const style=book.coverStyle||1;return `<div class="cover cover-style-${style}">${book.cover?`<img src="${esc(book.cover)}" alt="" loading="lazy">`:`${coverArt(style)}<div class="cover-name">${esc(book.title)}</div><div class="cover-author">${esc(book.author||'本地文档')}</div><div class="cover-type">${esc(book.format)} · 阅读</div>`}${mini?'':`<span class="book-progress">${book.finished?'已读':book.progress>0?Math.round(book.progress*100)+'%':'新'}</span><span class="download-mark">${icon('check',12)}</span>`}</div>`;}
function bookCard(book){return `<article class="book-card" data-book-id="${book.id}"><button class="book-open" data-action="open-book" data-id="${book.id}" aria-label="阅读 ${esc(book.title)}">${cover(book)}<div class="book-meta"><div class="grow"><div class="book-title">${esc(book.title)}</div><div class="book-sub">${esc(book.format)}${book.collections?.length?' · '+esc(book.collections[0]):''}</div></div></div></button><button class="book-more icon-button" data-action="book-menu" data-id="${book.id}" aria-label="管理 ${esc(book.title)}">${icon('more',18)}</button></article>`;}
function filteredBooks(){let books=[...state.books];if(state.query){const q=state.query.toLocaleLowerCase();books=books.filter(b=>`${b.title} ${b.author} ${b.filename}`.toLocaleLowerCase().includes(q));}if(state.filter==='unread')books=books.filter(b=>!b.finished);if(state.filter==='read')books=books.filter(b=>b.finished);if(state.filter==='favorite')books=books.filter(b=>b.favorite);if(state.filter==='documents')books=books.filter(b=>!['EPUB','TXT','MD'].includes(b.format));if(state.collection)books=books.filter(b=>b.collections?.includes(state.collection));books.sort((a,b)=>state.sort==='title'?a.title.localeCompare(b.title,'zh-CN'):state.sort==='author'?(a.author||'').localeCompare(b.author||'','zh-CN'):state.sort==='added'?b.added-a.added:(b.lastOpened||b.added)-(a.lastOpened||a.added));return books;}
function shelfContent(){const books=filteredBooks();if(!books.length)return `<div class="empty-state">${icon('book',45)}<h2>${state.books.length?'没有符合条件的书籍':'把想读的书放进来'}</h2><p>${state.books.length?'试试其他关键词，或清除筛选条件。':'导入 PDF、EPUB、Word 或 TXT<br>书籍和阅读记录都保存在这台设备。'}</p>${state.books.length?actionButton('clear-filter','清除筛选'):actionButton('import','导入文件','plus','class="outlined"')}</div>`;return `<div class="book-${state.view}">${books.map(bookCard).join('')}</div>`;}
function currentBook(){const healthy=state.books.filter(b=>!b.openFailure);return healthy.find(b=>b.id===localStorage.getItem('moyue-current'))||[...healthy].sort((a,b)=>(b.lastOpened||0)-(a.lastOpened||0))[0];}
function renderLibrary(route=state.route){
  state.route=route;localStorage.setItem('moyue-route',route);state.searchNonce++;window.Android?.setKeyTurns?.(false);window.Android?.keepScreenOn(false);
  const book=currentBook();const filterNames={all:'全部',unread:'未读',read:'已读',favorite:'收藏',documents:'文档'};
  app.innerHTML=`<section class="library"><header class="library-head">${status()}<div class="head-tools"><label class="search-box">${icon('search',21)}<input id="library-search" type="search" placeholder="搜索本地书库" aria-label="搜索书名或作者" value="${esc(state.query)}"></label>${iconButton('library-fulltext-open','搜索全部书籍正文','search')}${actionButton('import','导入','plus','class="import-button"')}${iconButton('main-menu','更多','more')}</div>${route==='library'?`<div class="shelf-tools"><div class="row">${actionButton('filters',state.collection||filterNames[state.filter],'filter')}${(state.filter!=='all'||state.collection)?'<button class="active-filter" data-action="clear-filter">清除 '+icon('close',12)+'</button>':''}</div><div class="row">${actionButton('sort',{recent:'最近阅读',title:'书名',author:'作者',added:'导入时间'}[state.sort],'sort')}${iconButton('view',state.view==='grid'?'切换列表':'切换网格',state.view==='grid'?'list':'grid')}</div></div>`:''}</header><div class="shelf-scroll" id="shelf-content">${route==='home'?homeContent():shelfContent()}</div><nav class="bottom-nav" aria-label="主导航"><button data-action="home" class="${route==='home'?'active':''}">首页</button>${book?`<button class="current-book" data-action="open-book" data-id="${book.id}" aria-label="继续阅读 ${esc(book.title)}">${cover(book,true)}</button>`:'<span class="nav-empty">墨</span>'}<button data-action="library" class="${route==='library'?'active':''}">书库</button></nav></section>`;
  setTimeout(()=>libraryCovers().catch(console.warn),500);
  // Returning from a full-text result keeps the query and the already-collected hits.
  if(route==='library'&&state.libraryReturn){
    const saved=state.libraryReturn;state.libraryReturn=null;
    state.libraryQuery=saved.query;state.libraryResults=saved.results;state.librarySkipped=saved.skipped;
    setTimeout(()=>{if(state.route!=='library')return;showLibrarySearch();renderLibraryResults();const status=$('#library-search-status');if(status)status.textContent=librarySearchStatus();},120);
  }
}
function homeContent(){const recent=[...state.books].sort((a,b)=>(b.lastOpened||b.added)-(a.lastOpened||a.added)).slice(0,innerWidth>=1100?4:3);return `<h1 class="home-title">留一点时间，给阅读。</h1><p class="home-caption">你的书籍与笔记，安静地留在这里。</p><div class="section-label"><span>最近阅读</span>${actionButton('library','查看全部','next')}</div><div class="home-recent">${recent.map(bookCard).join('')}</div><div class="home-hint">${icon('upload',31)}<div class="grow"><strong>把自己的书带进来</strong><p>支持电子书、PDF 和 Word 文档，导入后离线阅读。</p></div>${actionButton('import','导入','plus')}</div><div class="home-hint">${icon('notes',31)}<div class="grow"><strong>记下读到的片刻</strong><p>查看划线、笔记和书签，也可以导出阅读摘录。</p></div>${actionButton('all-notes','查看','next')}</div>`;}
function updateShelf(){if(state.route==='library'&&$('#shelf-content'))$('#shelf-content').innerHTML=shelfContent();}
function sheet(title,content,{tabs='',footer='',wide=false}={}){state.speedSample=null;overlays.innerHTML=`<div class="modal-backdrop" data-backdrop><section class="sheet ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="sheet-header"><h2>${esc(title)}</h2>${iconButton('close-sheet','关闭','close')}</header>${tabs}<div class="sheet-content">${content}</div>${footer?`<footer class="sheet-footer">${footer}</footer>`:''}</section></div>`;}
function closeSheet(){state.searchNonce++;state.librarySearchAbort?.abort();if(state.dictImporting){state.dictImportCancelled=true;cancelDictionaryWork();}if(state.pdfAdjust){state.pdfAdjust=null;restorePdfHighlights();}overlays.replaceChildren();if(state.route==='reader')$('#reader')?.focus({preventScroll:true});}
function reportError(error){console.error(error);if(error?.name==='LibraryWriteError'){sheet('本次记录未能保存',`<p class="error-detail">${esc(error.message)}</p><p class="panel-description">当前书籍仍可阅读，原文件未删除。请检查设备剩余空间；本次尚未保存的进度或笔记可能在退出后丢失。</p>`,{footer:actionButton('close-sheet','继续阅读','','class="outlined"')});return;}if(state.route==='reader'){recoverReader(error);return;}sheet('暂时无法完成',`<p class="error-detail">${esc(error?.message||String(error))}</p><p class="panel-description">操作未能完成，原文件和本地阅读记录均未删除。</p>`,{footer:actionButton('close-sheet','知道了','','class="outlined"')});}
function releasePdf(pdf){if(pdf)Promise.resolve().then(()=>pdf.destroy()).catch(error=>console.warn('PDF cleanup',error));}
function clearOpening(id){try{const marker=JSON.parse(localStorage.getItem('moyue-opening')||'null');if(!id||marker?.id===id)localStorage.removeItem('moyue-opening');}catch{localStorage.removeItem('moyue-opening');}}
function leaveReader(route='library',{save=true}={}){
  const book=state.book;readerGeneration++;renderNonce++;textRenderNonce++;state.searchNonce++;clearTimeout(saveTimer);clearTimeout(resizeTimer);
  state.abort?.abort();state.abort=null;releasePdf(state.pdf);state.pdf=null;state.pdfFallback=null;state.prefetching=false;state.pdfCache?.clear();state.pdfCache=null;state.paginator=null;state.pdfBytes=null;state.pdfBytesLoader=null;state.pagesTurned=0;state.busy=false;state.turning=false;state.pinching=false;state.opening=false;state.tools=false;
  closeImageViewer();state.paginator?.clearPreview?.();clearSelection();state.selected=null;clearOpening();state.book=null;state.doc=null;state.history=null;state.speedSample=null;settings=globalSettings;applySettings();closeSheet();renderLibrary(route);
  if(save&&book)putProgress(book).catch(error=>{console.warn(error);toast('已返回书库，但本次阅读记录未能保存');});
}
function recoverReader(error){
  const book=state.book;const detail=`${error?.name||'Error'}: ${error?.message||String(error)}`;
  if(book){book.openFailure={message:detail,time:Date.now()};putBook(book).catch(e=>console.warn('Save opening failure',e));}
  leaveReader('library',{save:false});
  const pdf=book?.kind==='pdf';const password=/password|encrypt|密码/i.test(detail);
  sheet('未能打开'+(pdf?' PDF':'文档'),`<p>${esc(book?.title||'这份文件')}</p><p class="panel-description">${password?'该文件可能需要密码。请先在其他应用解除密码后再导入。':'当前阅读引擎未能完成打开，可能与文件特性或运行环境兼容性有关，不能据此判定原文件损坏。'} 已返回书库，重启后不会反复自动打开这份文件。</p><details><summary class="small">查看错误详情</summary><p class="error-detail">${esc(detail)}</p><p class="error-detail">${esc(navigator.userAgent)}</p></details>`,{footer:actionButton('recover-home','返回首页','','class="outlined"')+actionButton('close-sheet','返回书库','','class="outlined"')+(pdf&&nativePdfAvailable()?actionButton('compat-open','兼容模式打开','','class="primary" data-id="'+book.id+'"'):'')});
}

async function importOne(name,bytes,{sample=false}={}){
  const digest=await crypto.subtle.digest('SHA-256',bytes);const id=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  const existing=state.books.find(b=>b.id===id);
  if(existing){
    const [original,document]=await Promise.all([get('originals',id),get('documents',id)]);let damaged=!!existing.openFailure||!document||!original?.blob;
    if(!damaged){const hash=await crypto.subtle.digest('SHA-256',await original.blob.arrayBuffer());damaged=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('')!==id;}
    if(!damaged)return {duplicate:true};
    const parsed=await parseFile(name,bytes),repaired={...existing,filename:name,format:name.split('.').pop().toUpperCase(),kind:parsed.kind,pages:parsed.pages||0,length:parsed.length||0,notice:parsed.notice||'',cover:parsed.cover||existing.cover||''};delete repaired.openFailure;
    await insertBook(repaired,parsed,new Blob([bytes]));invalidateLibrarySearch(id);Object.assign(existing,repaired);delete existing.openFailure;return {book:existing,repaired:true};
  }
  const parsed=await parseFile(name,bytes);const book={id,title:parsed.title,author:parsed.author,filename:name,format:name.split('.').pop().toUpperCase(),kind:parsed.kind,pdfMode:parsed.pdfMode||'auto',cover:parsed.cover||'',coverStyle:(state.books.length%5)+1,pages:parsed.pages||0,length:parsed.length||0,added:Date.now(),lastOpened:0,progress:0,finished:false,locator:{chapter:0,anchor:0,pdfPage:0},bookmarks:[],notes:[],collections:[],favorite:false,sample,notice:parsed.notice||''};
  await insertBook(book,parsed,new Blob([bytes]));invalidateLibrarySearch(id);state.books.push(book);return {book};
}
async function makeCover(book,generation){
  state.coverJobs||=new Set();if(book.cover||state.coverJobs.has(book.id))return;state.coverJobs.add(book.id);
  try{const art=await import('./page-art.js');let cover='';
    if(book.kind==='pdf'){if(state.book?.id!==book.id||!state.pdf)return;cover=await art.pdfThumbnail(state.pdf,0);}
    else{const doc=await get('documents',book.id);if(doc)cover=await art.textThumbnail(doc);}
    if(cover&&state.books.includes(book)){book.cover=cover;book.coverActual=true;await putBook(book);if(state.route!=='reader')updateShelf();}
  }finally{state.coverJobs.delete(book.id);}
}
async function libraryCovers(){
  if(state.backgroundWorkDisabled||state.coversRunning||state.route==='reader')return;state.coversRunning=true;
  try{
  for(const book of state.books.filter(b=>!b.cover)){
    if(state.route==='reader')return;
    if(book.kind==='pdf'){
      let pdf;try{const original=await get('originals',book.id);if(!original?.blob)continue;pdf=await openPdfDocument(new Uint8Array(await original.blob.arrayBuffer()),{preferNative:book.pdfMode==='native'});const {pdfThumbnail}=await import('./page-art.js');const cover=await pdfThumbnail(pdf,0);if(state.books.includes(book)){book.cover=cover;book.coverActual=true;await putBook(book);updateShelf();}}catch(e){console.debug('Optional cover skipped',e);}finally{releasePdf(pdf);}
    }else await makeCover(book);
    await new Promise(r=>setTimeout(r,150));
  }
  }finally{state.coversRunning=false;}
}
async function exportLibrary(){
  await flush();toast('正在整理书库备份…');const blob=await createBackup(globalSettings,{themes:themeList(),vocab:state.vocab||[],vocabAuto:localStorage.getItem('moyue-vocab-auto')==='1'}),name='墨阅书库-'+new Date().toISOString().slice(0,10)+'.moyue';
  if(!await saveBackup(blob,name)){download(blob,name);toast('备份已生成');}
}
async function restoreLibrary(blob){
  if(state.route==='reader')leaveReader('library');toast('正在校验备份，完成前不会改动书库…');
  const restored=await restoreBackup(blob,(i,n)=>{const banner=$('.import-status');if(banner)banner.textContent=`正在校验与恢复 ${i} / ${n}`;});
  Object.assign(globalSettings,normalizeSettings(restored.settings));globalSettings.customFont='';settings=globalSettings;
  if(restored.themes?.length)saveThemes(restored.themes);
  if(restored.vocabAuto!==undefined)localStorage.setItem('moyue-vocab-auto',restored.vocabAuto?'1':'0');
  await loadVocab();invalidateLibrarySearch();
  state.books=await allBooks();applySettings();renderLibrary('library');toast(`已恢复 ${restored.count} 本书及其阅读记录`);
}
function bindPdfPinch(root){
  let pinch=null;
  root.addEventListener('touchstart',e=>{if(e.touches.length!==2||e.target.closest('button,input,.reader-tools,.reader-navigation')||state.busy)return;const [a,b]=e.touches;const host=$('#pdf-host');pinch={generation:readerGeneration,distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),zoom:state.zoom,x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2,left:host.scrollLeft,top:host.scrollTop};state.pinching=pinch;e.preventDefault();},{passive:false});
  root.addEventListener('touchmove',e=>{if(!pinch||e.touches.length!==2)return;e.preventDefault();const [a,b]=e.touches;pinch.next=Math.max(.75,Math.min(4,pinch.zoom*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch.distance));const paper=$('#pdf-host>.pdf-paper');if(paper){paper.style.transformOrigin='0 0';paper.style.transform=`scale(${pinch.next/pinch.zoom})`;}},{passive:false});
  const finish=async()=>{if(!pinch)return;const p=pinch;pinch=null;if(p.generation!==readerGeneration)return;const paper=$('#pdf-host>.pdf-paper');if(paper)paper.style.transform='';if(p.next){state.zoom=Math.round(p.next*100)/100;await displayPdf();if(p.generation!==readerGeneration)return;const host=$('#pdf-host');if(host){const ratio=state.zoom/p.zoom;host.scrollLeft=(p.left+p.x)*ratio-p.x;host.scrollTop=(p.top+p.y)*ratio-p.y;}}setTimeout(()=>{if(state.pinching===p)state.pinching=false;},150);};
  root.addEventListener('touchend',()=>finish().catch(reportError));root.addEventListener('touchcancel',()=>{pinch=null;state.pinching=false;const paper=$('#pdf-host>.pdf-paper');if(paper)paper.style.transform='';});
}
function importBatch(items){
  importChain=importChain.then(async()=>{
    const errors=[];let added=0,duplicates=0,repairedCount=0,restored=false;
    for(let i=0;i<items.length;i++){
      const item=items[i];let banner=$('.import-status');if(!banner){banner=document.createElement('div');banner.className='import-status';document.body.append(banner);}banner.innerHTML=`<span>正在导入 ${esc(item.name)}</span><span>${i+1} / ${items.length}</span>`;
      try{if(/\.moyue$/i.test(item.name)){const blob=item.url?await(await fetch(item.url)).blob():item;await restoreLibrary(blob);restored=true;continue;}if(item.size>100*1024*1024)throw new Error('单个文件不能超过 100 MB');const bytes=new Uint8Array(item.url?await(await fetch(item.url)).arrayBuffer():await item.arrayBuffer());const result=await importOne(item.name,bytes);if(result.duplicate)duplicates++;else if(result.repaired)repairedCount++;else added++;}catch(e){errors.push(`${item.name}：${e.message}`);}finally{if(item.token)window.Android?.releaseImport(item.token);}
    }
    $('.import-status')?.remove();if(state.route!=='reader')renderLibrary();
    const resultText=[added?`已导入 ${added} 本书`:'',repairedCount?`已修复 ${repairedCount} 本书的本地副本`:'',duplicates?`${duplicates} 个重复文件已跳过`:''].filter(Boolean).join('，');
    if(errors.length)sheet('导入结果',`<p>${esc(resultText||'没有新文件导入')}。</p><p class="error-detail">${esc(errors.join('\n\n'))}</p>`,{footer:actionButton('close-sheet','完成','','class="outlined"')});else if(!restored)toast(resultText||'没有新文件导入');
    setTimeout(()=>libraryCovers().catch(console.warn),500);
  }).catch(reportError);return importChain;
}
function pickFiles(){if(window.Android)window.Android.pickFiles();else $('#file-picker').click();}

function systemFontScale(){
  if(!settings.systemScale)return 1;
  const scale=Number(window.Android?.systemFontScale?.());
  return Number.isFinite(scale)&&scale>0?Math.max(.85,Math.min(2,scale)):1;
}
function fontStack(){const custom=settings.customFont?`'${settings.customFont}',`:'';return custom+(settings.font==='sans'?"Arial,'Noto Sans',sans-serif":"'Noto Serif SC',serif");}
function applySettings(){
  const root=document.documentElement,scale=systemFontScale();
  root.style.setProperty('--reader-size',(settings.size*scale).toFixed(2)+'px');root.style.setProperty('--reader-line',settings.line);root.style.setProperty('--reader-margin',settings.margin+'%');root.style.setProperty('--reader-weight',settings.weight);root.style.setProperty('--reader-font',fontStack());root.style.setProperty('--reader-align',settings.align);
  root.style.setProperty('--reader-stroke',settings.stroke?'0.35px':'0');root.style.setProperty('--pdf-contrast',settings.pdfContrast||1);
  root.classList.toggle('night',settings.theme==='night');root.classList.toggle('warm',settings.theme==='warm');root.classList.toggle('publisher-style',settings.publisher);root.classList.toggle('eink',!!settings.einkMode);root.classList.toggle('pdf-color',!!settings.pdfColor);root.dataset.theme=settings.theme;
  const reader=$('#reader');if(reader){const clock=$('.reader-clock');if(clock)clock.hidden=!settings.clock;}
  window.Android?.brightness?.(settings.brightness);
  localStorage.setItem('moyue-settings',JSON.stringify(globalSettings));window.Android?.keepScreenOn(state.route==='reader'&&settings.keepAwake);window.Android?.setKeyTurns?.(state.route==='reader'&&settings.volume);
}
/** True while the reader edits a per-book profile instead of the global one. */
function bookProfileActive(){return !!(state.route==='reader'&&state.book?.typeset?.values);}
function useGlobalSettings(){settings=globalSettings;applySettings();}
function applyBookProfile(book){
  settings=book?.typeset?.values?withBookProfile(globalSettings,book.typeset.values):globalSettings;
}
async function openBook(id){
  if(state.opening)return false;state.opening=true;const generation=++readerGeneration;
  try{localStorage.setItem('moyue-route','library');localStorage.setItem('moyue-opening',JSON.stringify({id,time:Date.now()}));return await loadBook(id,generation);}catch(error){if(generation===readerGeneration)recoverReader(error);return false;}
  finally{if(generation===readerGeneration){clearOpening(id);state.opening=false;}}
}
async function loadBook(id,generation){
  const book=state.books.find(b=>b.id===id);if(!book)return;closeSheet();state.selected=null;state.pdfSearchPreview=null;
  clearTimeout(saveTimer);releasePdf(state.pdf);state.pdf=null;state.paginator=null;
  state.book=book;applyBookProfile(book);if(settings.customFont&&!await ensureCustomFont(settings.customFont))settings.customFont='';if(generation!==readerGeneration)return false;let document=await get('documents',id);if(generation!==readerGeneration)return false;if(!document)throw new Error('未找到应用内的文档数据，请重新导入原文件');prepareDocument(document);state.doc=document;
  if(book.kind!=='pdf'&&document.parserVersion!==3&&/\.(epub|docx)$/i.test(book.filename)){const original=await get('originals',id);if(original?.blob){document=await parseFile(book.filename,new Uint8Array(await original.blob.arrayBuffer()));if(generation!==readerGeneration)return false;await insertBook(book,document,original.blob);state.doc=document;}}
  if(book.kind!=='pdf'&&document.imageBudgetVersion!==1){await protectDocumentImages(document);await putDocument(document);if(generation!==readerGeneration)return false;}
  if(document.layoutChapters&&book.originalLayout){state.doc={...document,reflowChapters:document.chapters,chapters:document.layoutChapters,toc:document.layoutChapters.map((c,i)=>({title:c.title,chapter:i})),length:document.layoutChapters.reduce((n,c)=>n+c.length,0)};}
  const start=book.kind==='pdf'?{index:0,anchor:0}:locateAnchor(book.locator||{});
  state.route='reader';state.abort=new AbortController();state.chapter=Math.max(0,Math.min(start.index,Math.max(0,state.doc.chapters.length-1)));state.pdfPage=Math.max(0,Math.min(book.locator?.pdfPage||0,Math.max(0,book.pages-1)));state.pdfColumnIndex=Math.max(0,Math.min(1,book.pdfView?.slot|0));state.tools=false;state.zoom=book.pdfView?.zoom||1;state.rotation=book.pdfView?.rotation||0;state.crop=!!book.pdfView?.crop;state.fitWidth=!!book.pdfView?.fitWidth;state.pdfCache=new Map();state.busy=true;state.speedSample=null;state.history={back:[],forward:[]};
  app.innerHTML=`<section class="reader" id="reader" tabindex="-1" aria-label="${esc(book.title)}"><div class="reader-topline"><span></span><span class="reader-clock" data-clock ${settings.clock?'':'hidden'}>${time()}</span><span></span></div>${book.kind==='pdf'?'<div id="pdf-host" class="pdf-host"></div>':'<div class="page-viewport" id="page-viewport"><article class="flow" id="flow"></article></div>'}<footer class="reader-footer"><button data-action="progress" aria-label="切换阅读进度显示" id="progress-label"></button><span class="percent" id="progress-percent"></span></footer><header class="reader-tools" id="reader-tools" hidden></header><div class="reader-navigation" id="reader-navigation" hidden></div><div class="reader-busy" id="reader-busy" style="flex-direction:column;gap:20px"><span>正在打开书籍…</span>${actionButton('exit-reader','返回书库','','class="outlined"')}</div></section>`;
  applySettings();bindReaderGestures();
  if(book.kind==='pdf'){
    const original=await get('originals',id);if(generation!==readerGeneration)return false;
    if(!original?.blob)throw new Error('未找到应用内的 PDF 文件副本，请重新导入原文件');
    let bytes=new Uint8Array(await original.blob.arrayBuffer());if(generation!==readerGeneration)return false;state.pdfBytes=bytes;
    // The bytes are kept only while the engine opens the file. Holding a 100 MB PDF in the JS
    // heap for the whole session was the main out-of-memory risk on low-RAM tablets; the rare
    // compatibility fallback reloads the original copy from storage instead.
    state.pdfBytesLoader=async()=>{const copy=await get('originals',id);if(!copy?.blob)throw new Error('未找到应用内的 PDF 文件副本，请重新导入原文件');return new Uint8Array(await copy.blob.arrayBuffer());};
    const pdf=await openPdfDocument(bytes,{preferNative:book.pdfMode==='native',signal:state.abort.signal,bytesLoader:state.pdfBytesLoader});if(generation!==readerGeneration){releasePdf(pdf);return false;}
    state.pdfBytes=null;bytes=null;
    state.pdf=pdf;book.pages=pdf.numPages;state.pdfPage=Math.max(0,Math.min(state.pdfPage,pdf.numPages-1));if(pdf.isNative)book.pdfMode='native';await settleRender(displayPdf(),'pdfDisplayTask',generation);
  }else{state.paginator=new Paginator($('#page-viewport'),$('#flow'));await settleRender(displayChapter(start.index,start.anchor),'textDisplayTask',generation);}
  if(generation!==readerGeneration)return false;
  $('#reader-busy')?.remove();state.busy=false;book.lastOpened=Date.now();delete book.openFailure;
  localStorage.setItem('moyue-current',id);localStorage.setItem('moyue-route','reader');clearOpening(id);
  putBook(book).catch(e=>console.warn(e));if(!book.cover)makeCover(book,generation).catch(e=>console.warn('Cover',e));if(book.notice)toast(book.notice);return true;
}
async function settleRender(task,key,generation){while(task){await task;if(generation!==readerGeneration)return;if(task===state[key])return;task=state[key];}}
function displayChapter(index,offset=0,fragment=''){const task=renderChapter(index,offset,fragment);state.textDisplayTask=task;return task;}
async function renderChapter(index,offset=0,fragment=''){
  if(state.route!=='reader'||!state.paginator)return false;
  index=Math.max(0,Math.min(state.doc.chapters.length-1,Math.trunc(index)||0));
  state.chapter=index;const chapter=state.doc.chapters[index],generation=readerGeneration,paginator=state.paginator,nonce=++textRenderNonce;state.busy=true;state.textTargetAnchor=offset;
  const laid=await paginator.layout(chapter.html,offset,chapter.fixed&&(settings.publisher||state.book.originalLayout)?chapter:null,{clean:false});if(!laid||nonce!==textRenderNonce||generation!==readerGeneration||state.paginator!==paginator)return false;
  for(const note of state.book.notes.filter(n=>n.chapter===index&&n.start!==undefined&&sameTextView(n)))state.paginator.highlight(note.start,note.end,note.id);
  if(fragment)state.paginator.jumpId(fragment);
  state.preservedAnchor=!fragment&&Number.isFinite(offset)&&offset<Number.MAX_SAFE_INTEGER?Math.max(0,Math.min(offset,Math.max(0,paginator.length-1))):null;
  state.textTargetAnchor=null;state.busy=false;updateProgress();if(state.tools)renderReaderTools();return true;
}
function requestReflow(){
  if(state.route!=='reader'||state.book.kind==='pdf')return;
  const anchor=state.textTargetAnchor??state.book.locator?.anchor??0;
  return displayChapter(state.chapter,anchor).catch(reportError);
}
function displayPdf(){const task=renderPdfDisplay();state.pdfDisplayTask=task;return task;}
async function renderPdfDisplay(){
  const nonce=++renderNonce,host=$('#pdf-host'),book=state.book,source=state.pdf,generation=readerGeneration,cache=state.pdfCache;
  if(!host?.isConnected||!source)return false;state.busy=true;
  const staging=pdfStage(host),columnMode=pdfColumnSetting();
  const column=columnMode==='off'?'off':(columnMode==='rl'?(state.pdfColumnIndex?'left':'right'):(state.pdfColumnIndex?'right':'left'));
  const options={zoom:state.zoom,rotate:state.rotation,crop:pdfEffectiveCrop(),fitWidth:columnMode==='off'?state.fitWidth:true,column};let timer,pageIndex=state.pdfPage;
  const current=()=>generation===readerGeneration&&nonce===renderNonce&&host.isConnected;
  try{
    try{const key=pdfCacheKey(pageIndex,options),cached=cache?.get(key);if(cached)staging.replaceChildren(cached);else{if(!current())return false;await Promise.race([renderPdfQueued(source,pageIndex,staging,options,current),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PDF 页面渲染超时')),20000);})]);if(current()&&state.pdf===source)cachePdf(key,staging.firstElementChild,cache);}}
    catch(error){
      if(!current())return false;if(source.isNative||!nativePdfAvailable())throw error;clearTimeout(timer);
      if(state.pdfFallback?.source!==source){const signal=state.abort?.signal,bytesLoader=state.pdfBytesLoader;releasePdf(source);cache?.clear();state.pdfFallback={source,task:(async()=>{const bytes=state.pdfBytes||await bytesLoader();if(signal?.aborted)throw new DOMException('已取消打开','AbortError');return openPdfDocument(bytes,{preferNative:true,signal,bytesLoader});})().then(pdf=>{if(generation!==readerGeneration){releasePdf(pdf);return null;}state.pdf=pdf;book.pdfMode='native';book.pages=pdf.numPages;return pdf;})};}
      const pdf=await state.pdfFallback.task;if(!pdf||!current())return false;pageIndex=Math.max(0,Math.min(pageIndex,pdf.numPages-1));await renderPdfQueued(pdf,pageIndex,staging,options,current);toast('已使用 PDF 兼容模式打开');
    }
    if(!current())return false;state.pdfPage=pageIndex;host.replaceChildren(...staging.childNodes);const modeLabel=$('.reader-topline>span:first-child');if(modeLabel)modeLabel.textContent=(state.pdf.isNative?'PDF · 兼容模式':'')+(columnMode!=='off'?'　分栏':'');
    book.pdfView={...book.pdfView,zoom:options.zoom,rotation:options.rotate,crop:options.crop,fitWidth:options.fitWidth,slot:state.pdfColumnIndex||0,column:columnMode};restorePdfHighlights();updateProgress();if(state.tools)renderReaderTools();queuePdfPrefetch();return true;
  }catch(error){if(current())throw error;return false;}finally{clearTimeout(timer);staging.remove();if(current())state.busy=false;}
}
function renderPdfQueued(doc,index,host,options,current){
  const previous=pdfRenderJobs.get(doc)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{if(!current())return false;const render=doc.isNative?renderNativePdfPage:(await import('./pdf.js')).renderPdfPage;if(!current())return false;return await render(doc,index,host,options);});
  pdfRenderJobs.set(doc,task.catch(()=>{}));return task;
}
function pdfStage(host){const stage=document.createElement('div');stage.className='pdf-render-stage';stage.style.cssText=`position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none;width:${host.clientWidth}px;height:${host.clientHeight}px;overflow:hidden`;document.body.append(stage);return stage;}
function pdfCacheKey(page,options={zoom:state.zoom,rotate:state.rotation,crop:state.crop,fitWidth:state.fitWidth}){const h=$('#pdf-host');return JSON.stringify([readerGeneration,state.pdf?.isNative?'native':'web',page,options,h?.clientWidth,h?.clientHeight]);}
function cachePdf(key,element,cache=state.pdfCache){if(!element||!cache||cache!==state.pdfCache)return;cache.set(key,element);while(cache.size>2)cache.delete(cache.keys().next().value);}
function queuePdfPrefetch(){
  if(state.zoom!==1||state.crop||state.fitWidth||pdfColumnSetting()!=='off'||state.prefetching||state.pdfPage+1>=state.book.pages)return;
  const doc=state.pdf,generation=readerGeneration,cache=state.pdfCache,index=state.pdfPage+1,options={zoom:1,rotate:state.rotation,crop:pdfCropFor(state.pdfPage+1),fitWidth:false,column:'off'},key=pdfCacheKey(index,options);
  if(state.pdfCache.has(key))return;
  setTimeout(async()=>{if(generation!==readerGeneration||state.pdf!==doc||state.busy||state.turning||state.prefetching)return;const work={};state.prefetching=work;
    const h=$('#pdf-host');if(!h?.isConnected){state.prefetching=false;return;}const stage=pdfStage(h);
    try{await renderPdfQueued(doc,index,stage,options,()=>generation===readerGeneration&&state.pdf===doc&&!state.busy);if(generation===readerGeneration&&state.pdf===doc)cachePdf(key,stage.firstElementChild,cache);}
    catch(error){console.debug('Optional PDF prefetch skipped',error);}finally{stage.remove();if(state.prefetching===work)state.prefetching=false;}
  },220);
}
function restorePdfHighlights(){const paper=$('#pdf-host>.pdf-paper');if(!paper||!state.book)return;paper.querySelectorAll('.pdf-highlight').forEach(n=>n.remove());const width=Number(paper.dataset.fullWidth),height=Number(paper.dataset.fullHeight),cx=Number(paper.dataset.cropX),cy=Number(paper.dataset.cropY);const records=state.book.notes.map(n=>state.pdfAdjust?.id===n.id?{...n,fragments:state.pdfAdjust.fragments}:n);if(state.selected?.extended)records.push({...state.selected,preview:true});if(state.pdfSearchPreview)records.push({...state.pdfSearchPreview,preview:true});for(const note of records)for(const fragment of fragmentsOf(note).filter(n=>n.pdfPage===state.pdfPage)){for(const original of fragment.rects||[]){const r=rotateRect(original,(state.rotation-(fragment.rotation||0))/90),mark=document.createElement('div');mark.className='pdf-highlight'+(note.preview?' pdf-selection-preview':'');if(!note.preview)mark.dataset.note=note.id;mark.style.cssText=`left:${r.x*width-cx}px;top:${r.y*height-cy}px;width:${r.w*width}px;height:${r.h*height}px`;paper.append(mark);}}}
function locator(){
  if(state.book.kind==='pdf')return{pdfPage:state.pdfPage,chapter:0,anchor:0,column:state.pdfColumnIndex||0};
  const anchor=state.preservedAnchor??state.paginator?.anchor()??0;
  const chapter=state.doc.chapters[state.chapter];
  const text=chapter?.text||'';
  // A short text quote is a cheap backup for the character offset: if a parser upgrade changes the
  // text length, the reader can still find the sentence instead of landing on the wrong line.
  const from=Math.max(0,anchor-24),to=Math.min(text.length,anchor+24);
  return{chapter:state.chapter,anchor,pdfPage:0,path:chapter?.path||'',quote:{p:text.slice(from,anchor),e:text.slice(anchor,to)},...(state.book.originalLayout?{view:'original'}:{})};
}
/** Resolve a stored locator to a chapter offset, preferring the exact offset and then the quote. */
function locateAnchor(loc){
  const byPath=loc?.path?state.doc.chapters.findIndex(c=>c.path===loc.path):-1;
  const index=byPath>=0?byPath:Math.max(0,Math.min(state.doc.chapters.length-1,Math.trunc(loc?.chapter)||0));
  const text=state.doc.chapters[index]?.text||'';
  let anchor=Math.max(0,Math.min(text.length,Math.trunc(loc?.anchor)||0));
  const quote=loc?.quote;
  if(quote&&typeof quote.e==='string'&&quote.e&&!text.startsWith(quote.e,anchor)){
    const near=text.indexOf(quote.e,Math.max(0,anchor-600));
    if(near>=0)anchor=near;
    else{const far=text.indexOf(quote.e);if(far>=0)anchor=far;else toast('未找到原位置的文字，已打开邻近位置，请核对');}
  }
  return{index,anchor};
}
function sameTextView(loc){return (loc.view==='original')===!!state.book?.originalLayout;}
async function switchWordLayout(original,loc){
  const book=state.book,fraction=progress(),generation=readerGeneration;state.busy=true;book.viewLocators||={};book.viewLocators[book.originalLayout?'original':'text']=locator();await flush();if(generation!==readerGeneration)return false;
  book.originalLayout=original;const chapters=original?state.doc.layoutChapters:state.doc.reflowChapters;
  if(!loc&&!book.viewLocators[original?'original':'text']&&chapters){let offset=Math.round(fraction*chapters.reduce((n,c)=>n+c.length,0));let index=0;while(index<chapters.length-1&&offset>=chapters[index].length)offset-=chapters[index++].length;loc={chapter:index,anchor:offset,pdfPage:0,...(original?{view:'original'}:{})};}
  book.locator=loc||book.viewLocators[original?'original':'text']||{chapter:0,anchor:0,pdfPage:0};await putBook(book);if(generation!==readerGeneration)return false;leaveReader('library',{save:false});return await openBook(book.id);
}
function progress(){if(state.book.kind==='pdf')return (state.pdfPage+1)/state.book.pages;const before=state.doc.chapters.slice(0,state.chapter).reduce((n,c)=>n+c.length,0);return Math.min(1,(before+(state.preservedAnchor??state.paginator?.anchor()??0))/Math.max(1,state.doc.length));}
function updateProgress(){
  if(state.route!=='reader'||!state.book)return;state.book.locator=locator();state.book.progress=progress();
  if(state.book.kind==='pdf'&&state.pdfPage===state.book.pages-1 || state.book.kind!=='pdf'&&state.chapter===state.doc.chapters.length-1&&state.paginator?.page===state.paginator?.pages-1){state.book.finished=true;state.book.progress=1;}
  const label=$('#progress-label'),percent=$('#progress-percent');if(!label)return;
  if(state.book.kind==='pdf')label.textContent=`第 ${state.pdfPage+1} / ${state.book.pages} 页`;
  else if(settings.progress===0)label.textContent=state.doc.chapters[state.chapter].title+` · ${state.paginator.page+1} / ${state.paginator.pages}`;
  else if(settings.progress===1)label.textContent=`位置 ${state.book.locator.anchor+1} · 第 ${state.chapter+1} / ${state.doc.chapters.length} 节`;
  else if(settings.progress===2)label.textContent=`本节剩余约 ${Math.max(1,Math.ceil((state.doc.chapters[state.chapter].length-state.book.locator.anchor)/500))} 分钟`;
  else if(settings.progress===4){const remain=remainingMinutes();label.textContent=remain?`本章约 ${Math.max(1,Math.round(remain.chapter))} 分钟 · 全书约 ${Math.max(1,Math.round(remain.book))} 分钟`:'阅读速度学习中';}
  else label.textContent='';
  percent.textContent=settings.progress===3?'':Math.round(state.book.progress*100)+'%';
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>putProgress(state.book).catch(reportError),180);
}
async function flush(){clearTimeout(saveTimer);const book=state.book;if(book)await putBook(book);}
async function paperTurn(change){
  const generation=readerGeneration,root=$('#reader');state.turning=true;state.busy=true;const clear=document.createElement('div');clear.className='paper-clear';clear.dataset.phase='clear';
  let finish;const task=new Promise(resolve=>finish=resolve);state.turnFinished=task;
  const dwell=Math.max(0,Math.min(300,Number(settings.dwell)||0));
  if(settings.animation!=='none')root.append(clear);
  const start=performance.now();
  try{if(clear.isConnected)await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(generation!==readerGeneration||state.route!=='reader')return;await change();
    if(clear.isConnected)await new Promise(r=>setTimeout(r,Math.max(0,dwell-(performance.now()-start))));
    if(generation===readerGeneration){clear.dataset.phase='ready';await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}
  }finally{
    clear.remove();if(generation===readerGeneration){state.turning=false;countTurnForRefresh();sampleReading();}
    finish();if(state.turnFinished===task)state.turnFinished=null;
  }
}
/**
 * Optional visual flash simulation. The host does not select an e-paper hardware waveform.
 */
function countTurnForRefresh(){
  const every=Math.max(0,Math.round(Number(settings.refreshEvery)||0));if(!every)return;
  state.pagesTurned=(state.pagesTurned||0)+1;
  if(state.pagesTurned<every)return;
  state.pagesTurned=0;window.Android?.refreshScreen?.(true);
}
async function turn(direction,{preserveSelection=false}={}){
  if(state.route!=='reader'||state.busy||state.turning||overlays.firstChild||state.imageViewer)return;
  if(preserveSelection){window.getSelection()?.removeAllRanges();$('.selection-tools')?.remove();}else{clearSelection();state.selected=null;}
  state.pdfSearchPreview=null;
  if(state.tools){state.tools=false;$('#reader-tools').hidden=true;$('#reader-navigation').hidden=true;}
  if(state.book.kind==='pdf'){
    if((state.zoom>1||pdfColumnSetting()!=='off')&&panPdf(direction))return;
    if(pdfColumnSetting()!=='off'){
      const slot=state.pdfPage*2+(state.pdfColumnIndex||0),next=slot+direction;
      if(next<0||next>=state.book.pages*2){toast(direction>0?'已经读到最后一页':'已经是第一页');return;}
      await paperTurn(async()=>{state.pdfPage=Math.floor(next/2);state.pdfColumnIndex=next%2;const host=$('#pdf-host');host?.scrollTo?.({top:0,left:0,behavior:'instant'});await displayPdf();});
      return;
    }
    const next=state.pdfPage+direction;if(next<0||next>=state.book.pages){toast(next<0?'已经是第一页':'已经读到最后一页');return;}await paperTurn(async()=>{state.pdfPage=next;await displayPdf();});return;
  }
  const p=state.paginator;
  if(p.page+direction>=0&&p.page+direction<p.pages)await paperTurn(async()=>{state.preservedAnchor=null;p.go(p.page+direction);updateProgress();state.busy=false;});
  else if(state.chapter+direction>=0&&state.chapter+direction<state.doc.chapters.length)await paperTurn(()=>displayChapter(state.chapter+direction,direction>0?0:Number.MAX_SAFE_INTEGER));
  else toast(direction>0?'已经读到最后一页':'已经是第一页');
}
function bindReaderGestures(){
  const root=$('#reader');let start=null;
  if(state.book.kind==='pdf')bindPdfPinch(root);
  root.addEventListener('pointerdown',event=>{if(event.target.closest('button,input,a,.reader-tools,.reader-navigation'))return;start={x:event.clientX,y:event.clientY,time:Date.now()};});
  root.addEventListener('pointerup',event=>{
    if(!start)return;const p=start;start=null;if(state.pinching||event.target.closest('button,input,.reader-tools,.reader-navigation')||overlays.firstChild)return;
    if(state.busy||state.turning){const bounds=root.getBoundingClientRect();if(!$('#reader-busy')&&event.clientY<bounds.top+bounds.height*.19&&Math.abs(event.clientX-p.x)<12&&Math.abs(event.clientY-p.y)<12)toggleTools();return;}
    if(window.getSelection()?.toString().trim()){showSelection();return;}
    const dx=event.clientX-p.x,dy=event.clientY-p.y;
    const image=event.target.closest('.flow img');if(image){openImageViewer(image.src,image.alt||'插图');return;}
    const table=event.target.closest('.flow table');if(table){openTableZoom(table);return;}
    if(event.target.closest('a')){const anchor=event.target.closest('a'),href=anchor.getAttribute('href');
      if(href?.startsWith('moyue:')){
        if(anchor.classList.contains('noteref')&&showFootnote(anchor))return;
        const [idx,fragment]=href.slice(6).split('#');jump({chapter:Number(idx),anchor:0,fragment:decodeURIComponent(fragment||'')}).catch(reportError);
      }
      return;}
    if(event.target.closest('mark[data-note],.pdf-highlight[data-note]')){showNote(event.target.closest('[data-note]').dataset.note);return;}
    if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)*1.5 && (state.book.kind!=='pdf'||state.zoom===1)){turn(dx<0?1:-1).catch(reportError);return;}
    if(Math.abs(dx)>12||Math.abs(dy)>12||Date.now()-p.time>500)return;
    const rect=root.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
    if(y<.19){toggleTools();return;}
    if(state.tools){toggleTools();return;}
    turn(x<.18?-1:1).catch(reportError);
  });
  // Links are activated on click: pointerup deliberately ignores them so a text selection that
  // starts on a link does not navigate away.
  root.addEventListener('click',event=>{
    const anchor=event.target.closest('a');if(!anchor)return;event.preventDefault();
    const href=anchor.getAttribute('href');if(!href?.startsWith('moyue:'))return;
    if(state.route!=='reader'||overlays.firstChild)return;
    if(anchor.classList.contains('noteref')&&showFootnote(anchor))return;
    const [idx,fragment]=href.slice(6).split('#');
    jump({chapter:Number(idx),anchor:0,fragment:decodeURIComponent(fragment||'')}).catch(reportError);
  });
}
function toggleTools(){state.speedSample=null;state.tools=!state.tools;$('#reader-tools').hidden=!state.tools;$('#reader-navigation').hidden=!state.tools;if(state.tools)renderReaderTools();}
function isBookmarked(){const loc=locator();return state.book.bookmarks.some(b=>state.book.kind==='pdf'?b.locator.pdfPage===loc.pdfPage:sameTextView(b.locator)&&b.locator.chapter===loc.chapter&&state.paginator.pageAt(b.locator.anchor)===state.paginator.page);}
function renderReaderTools(){
  const marked=isBookmarked();$('#reader-tools').innerHTML=`<div class="tools-status"><span data-clock>${time()}</span><span>本地阅读${state.battery!==null?' · '+state.battery+'%':''}</span></div><div class="toolbar">${actionButton('exit-reader','书库','back','class="back-library"')}${iconButton('history-back','返回上一个位置','undo',(state.history?.back.length)?'':'disabled')}${iconButton('history-forward','前进到下一个位置','redo',(state.history?.forward.length)?'':'disabled')}<span class="grow"></span><button class="aa-button" data-action="aa" aria-label="字体与排版设置">Aa</button>${iconButton('toc','目录','toc')}${iconButton('book-notes','笔记','notes')}${iconButton('bookmark',marked?'移除书签':'添加书签',marked?'bookmarkFill':'bookmark')}${iconButton('search-book','搜索书内内容','search')}${iconButton('reader-menu','阅读选项','more')}</div><div class="book-bar">${esc(state.book.title)}</div>${state.book.kind==='pdf'?`<div class="pdf-tools">${actionButton('pdf-column',{off:'分栏 · 关',lr:'分栏 · 左→右',rl:'分栏 · 右→左'}[pdfColumnSetting()],'columns',`class="${pdfColumnSetting()!=='off'?'selected':''}"`)}${actionButton('pdf-crop','裁白边'+(pdfEffectiveCrop()?'（'+(state.pdfPage%2===0?'偶':'奇')+'数页）':''),'crop',`class="${pdfEffectiveCrop()?'selected':''}"`)}${actionButton('pdf-fit',state.fitWidth?'适合页面':'适合宽度','book')}${actionButton('pdf-zoom','缩放 '+Math.round(state.zoom*100)+'%','zoom')}${actionButton('pdf-rotate','旋转','rotate')}${actionButton('pdf-contrast','对比度 '+Math.round((settings.pdfContrast||1)*100)+'%','contrast',`class="${(settings.pdfContrast||1)>1?'selected':''}"`)}</div>`:''}`;
  const label=state.book.kind==='pdf'?`${state.pdfPage+1} / ${state.book.pages} 页`:`${state.chapter+1} / ${state.doc.chapters.length} 节`;
  if(state.pdf?.isNative)$('#reader-tools').insertAdjacentHTML('beforeend','<div class="compat-caption">兼容引擎 · 文字功能取决于文件和系统 '+actionButton('pdf-text','加载文字层')+'</div>');
  $('#reader-navigation').innerHTML=`<div class="navigation-caption"><span>${label}</span>${actionButton('preview','页面预览','grid')}</div><div class="scrub-row">${iconButton('prev','上一页','prev')}<input type="range" min="0" max="1000" value="${Math.round(progress()*1000)}" data-input="scrub" aria-label="阅读进度"><span>${Math.round(progress()*100)}%</span>${iconButton('next','下一页','next')}</div>`;
}
async function jump(loc,{history=true}={}){
  const generation=readerGeneration;if(state.turning)await state.turnFinished;if(generation!==readerGeneration||state.route!=='reader'||!state.book)return false;
  if(history)pushHistory();
  closeSheet();clearSelection();state.selected=null;state.pdfSearchPreview=null;
  if(state.book.kind==='pdf'){state.pdfPage=Math.min(state.book.pages-1,Math.max(0,Math.trunc(loc.pdfPage)||0));state.pdfColumnIndex=loc.column===1?1:0;await displayPdf();}
  else{if(state.book.format==='DOCX'&&loc.view!==undefined&&!sameTextView(loc)){await switchWordLayout(loc.view==='original',loc);return;}const at=loc.quote||loc.path?locateAnchor(loc):{index:Math.max(0,Math.min(state.doc.chapters.length-1,Math.trunc(loc.chapter)||0)),anchor:Math.max(0,loc.anchor||0)};await displayChapter(at.index,at.anchor,loc.fragment||'');}
}
function locatorAt(fraction){if(state.book.kind==='pdf')return{pdfPage:Math.min(state.book.pages-1,Math.floor(fraction*state.book.pages))};let target=Math.floor(fraction*state.doc.length);for(let i=0;i<state.doc.chapters.length;i++){const c=state.doc.chapters[i];if(target<c.length||i===state.doc.chapters.length-1)return{chapter:i,anchor:Math.min(c.length-1,target),...(state.book.originalLayout?{view:'original'}:{})};target-=c.length;}return{chapter:0,anchor:0};}
async function toggleBookmark(){const loc=locator();const existing=state.book.bookmarks.find(b=>state.book.kind==='pdf'?b.locator.pdfPage===loc.pdfPage:sameTextView(b.locator)&&b.locator.chapter===loc.chapter&&state.paginator.pageAt(b.locator.anchor)===state.paginator.page);if(existing){state.book.bookmarks=state.book.bookmarks.filter(b=>b!==existing);toast('已移除书签');}else{state.book.bookmarks.push({id:crypto.randomUUID(),locator:loc,label:state.book.kind==='pdf'?`第 ${state.pdfPage+1} 页`:state.doc.chapters[state.chapter].title,created:Date.now()});toast('已添加书签');}await flush();if(state.tools)renderReaderTools();}
function showToc(){const toc=state.doc.toc||[];sheet('目录',toc.length?toc.map((item,i)=>`<button class="toc-item ${state.book.kind==='pdf'?item.page===state.pdfPage?'active':'':item.chapter===state.chapter?'active':''}" data-action="toc-jump" data-index="${i}" style="padding-left:${(item.level||0)*14+4}px">${esc(item.title)}<span>${state.book.kind==='pdf'?'第 '+(item.page+1)+' 页':(item.chapter+1)+' / '+state.doc.chapters.length}</span></button>`).join(''):'<p class="panel-description">这份 PDF 没有内置目录，可以通过页面预览或页码跳转。</p>',{footer:actionButton('goto','跳转到位置','','class="outlined"')});}
function showSelection(){
  if(state.route!=='reader'||state.busy||state.turning||overlays.firstChild)return;const sel=window.getSelection();if(!sel||!sel.toString().trim())return;
  if(state.book.kind==='pdf'){
    const paper=$('#pdf-host>.pdf-paper'),layer=$('#pdf-host>.pdf-paper .textLayer');if(!paper||!layer||!paper.contains(sel.anchorNode)||!paper.contains(sel.focusNode))return;const part={...layerSelection(layer,sel.getRangeAt(0)),pdfPage:state.pdfPage,rotation:state.rotation};state.selected={...part,fragments:[part]};
  }else{const selected=state.paginator.selection();if(!selected)return;state.selected={...selected,chapter:state.chapter,...(state.book.originalLayout?{view:'original'}:{})};}
  if($('.selection-tools'))return;showSelectionTools();
}
function clearSelection(){window.getSelection()?.removeAllRanges();$('.selection-tools')?.remove();state.paginator?.clearPreview?.();document.querySelectorAll('.pdf-selection-preview').forEach(n=>n.remove());}

/* ---------- in-book history (deliberate jumps only) ---------- */
function histLocator(){const loc=locator();if(state.book?.kind==='pdf')loc.column=state.pdfColumnIndex||0;return loc;}
function sameLocator(a,b){
  if(!a||!b)return false;
  if(state.book?.kind==='pdf')return (a.pdfPage|0)===(b.pdfPage|0)&&(a.column|0)===(b.column|0);
  return (a.chapter|0)===(b.chapter|0)&&Math.abs((a.anchor|0)-(b.anchor|0))<24&&(a.view||'text')===(b.view||'text');
}
function pushHistory(){
  if(state.route!=='reader'||!state.book)return;
  const h=state.history||(state.history={back:[],forward:[]});
  const loc=histLocator();
  if(!h.back.length||!sameLocator(h.back[h.back.length-1],loc))h.back.push(loc);
  if(h.back.length>30)h.back.shift();
  h.forward.length=0;
  if(state.tools)renderReaderTools();
}
async function goHistory(direction){
  const h=state.history;if(!h)return;
  const from=direction<0?h.back:h.forward,to=direction<0?h.forward:h.back;
  if(!from.length){toast(direction<0?'没有可返回的位置':'没有可前进的位置');return;}
  const target=from.pop();to.push(histLocator());
  await jump(target,{history:false});
  if(state.tools)renderReaderTools();
}

/* ---------- footnote preview ---------- */
function footnoteFor(anchor){
  const href=anchor?.getAttribute?.('href')||'';if(!href.startsWith('moyue:'))return null;
  const [rawIndex,fragment]=href.slice(6).split('#');const index=Number(rawIndex);if(!Number.isInteger(index))return null;
  const target=state.doc?.chapters?.[index];if(!target)return null;
  const id=decodeURIComponent(fragment||'');if(!id)return null;
  let node=null;try{const dom=new DOMParser().parseFromString(target.html,'text/html');node=dom.getElementById('moyue-content-'+id)||dom.getElementById(id);}catch{return null;}
  if(!node)return null;
  return {index,id,title:target.title,text:(node.textContent||'').replace(/\s+/g,' ').trim().slice(0,6000)};
}
function showFootnote(anchor){
  const note=footnoteFor(anchor);if(!note)return false;
  // Reading position is untouched: the sheet is an overlay, not a navigation.
  sheet('注释',`<p class="footnote-source">${esc(note.title)}</p><div class="footnote-body">${esc(note.text||'这条注释没有可显示的文字。')}</div>`,{footer:actionButton('footnote-goto','跳到注释原文','','class="outlined"')+actionButton('close-sheet','留在原页','','class="primary"')});
  state.pendingFootnote=note;
  return true;
}

/* ---------- personal reading speed ---------- */
const SPEED_KEY='moyue-speed';
function readingSpeed(){try{const v=JSON.parse(localStorage.getItem(SPEED_KEY)||'null');return v&&Number.isFinite(v.cpm)&&v.cpm>0?v:null;}catch{return null;}}
function saveReadingSpeed(value){try{localStorage.setItem(SPEED_KEY,JSON.stringify(value));}catch{}}
function sampleReading(){
  if(state.route!=='reader'||!state.book||state.book.kind==='pdf')return;
  // Only count turns that happened while the page was actually on screen and idle-free.
  if(document.visibilityState!=='visible'||state.tools||overlays.firstChild||state.busy||state.turning)return;
  const now=Date.now(),chapter=state.chapter,anchor=state.paginator?.anchor()??0;
  const last=state.speedSample;
  state.speedSample={at:now,chapter,anchor};
  if(!last)return;
  const seconds=(now-last.at)/1000;if(seconds<1.5||seconds>120)return;      // idle or instant jump
  const advanced=chapter===last.chapter?anchor-last.anchor:Number.NaN;
  if(!Number.isFinite(advanced)||advanced<=40||advanced>6000)return;          // skip chapter jumps and scrubs
  const cpm=advanced/(seconds/60);if(cpm<80||cpm>6000)return;                // implausible, ignore
  const current=readingSpeed();
  const next=current?{cpm:current.cpm*0.7+cpm*0.3,samples:Math.min(999,current.samples+1),chars:current.chars+advanced}:{cpm,samples:1,chars:advanced};
  saveReadingSpeed(next);
}
function remainingMinutes(){
  const speed=readingSpeed();
  if(!speed||speed.samples<4||speed.chars<1500)return null;
  const left=Math.max(0,state.doc.length-state.doc.chapters.slice(0,state.chapter).reduce((sum,c)=>sum+c.length,0)-(state.book.locator?.anchor||0));
  const chapterLeft=Math.max(0,state.doc.chapters[state.chapter].length-(state.book.locator?.anchor||0));
  return {chapter:chapterLeft/speed.cpm,book:left/speed.cpm,cpm:speed.cpm};
}

/* ---------- annotations: delete with rollback ---------- */
function dropNoteMarks(id){
  const selector=`mark[data-note="${CSS.escape(id)}"],.pdf-highlight[data-note="${CSS.escape(id)}"]`;
  for(const node of document.querySelectorAll(selector)){
    if(node.tagName==='MARK'){const parent=node.parentNode;if(!parent)continue;while(node.firstChild)parent.insertBefore(node.firstChild,node);parent.removeChild(node);parent.normalize?.();}
    else node.remove();
  }
  state.paginator?.index();
}
async function deleteAnnotation(bookId,noteId,{refreshNotes=true}={}){
  const book=state.books.find(b=>b.id===bookId);if(!book)return false;
  const at=book.notes.findIndex(n=>n.id===noteId);if(at<0)return false;
  const removed=book.notes[at];
  book.notes.splice(at,1);
  try{
    await putBook(book);
  }catch(error){
    book.notes.splice(at,0,removed);
    reportError(error);toast('删除未能保存，已恢复这条记录');
    return false;
  }
  if(state.book?.id===book.id)dropNoteMarks(noteId);
  toast(removed.note?'已删除划线笔记':'已删除划线');
  if(refreshNotes){
    if(state.lastList==='all')allNotes();
    else if(state.lastList==='book'&&state.route==='reader'&&state.book?.id===book.id)showBookNotes(state.noteTab||'notes');
    else if(overlays.querySelector('.sheet'))closeSheet();
    if(state.tools)renderReaderTools();
  }
  return true;
}
async function deleteBookmark(bookId,markId){
  const book=state.books.find(b=>b.id===bookId);if(!book)return false;
  const at=book.bookmarks.findIndex(b=>b.id===markId);if(at<0)return false;
  const removed=book.bookmarks[at];book.bookmarks.splice(at,1);
  try{await putBook(book);}catch(error){book.bookmarks.splice(at,0,removed);reportError(error);toast('删除未能保存，已恢复这个书签');return false;}
  toast('已删除书签');
  if(state.route==='reader'&&state.book?.id===book.id&&state.tools)renderReaderTools();
  if(overlays.querySelector('.sheet'))showBookNotes('bookmarks');
  return true;
}

/* ---------- imported fonts ---------- */
const FONT_KEY='moyue-fonts';
function fontList(){try{const v=JSON.parse(localStorage.getItem(FONT_KEY)||'[]');return Array.isArray(v)?v.filter(f=>f&&typeof f.family==='string'&&typeof f.url==='string'):[];}catch{return[];}}
function saveFonts(list){try{localStorage.setItem(FONT_KEY,JSON.stringify(list));}catch{}}
async function ensureCustomFont(family){
  if(!family)return false;
  if([...document.fonts].some(face=>face.family===family&&face.status==='loaded'))return true;
  const entry=fontList().find(f=>f.family===family);if(!entry)return false;
  try{
    const response=await fetch(entry.url);if(!response.ok)throw new Error('字体文件不可用');
    const face=new FontFace(family,await response.arrayBuffer());await face.load();document.fonts.add(face);return true;
  }catch(error){console.warn('Custom font unavailable',error);return false;}
}
async function restoreCustomFont(){
  const family=globalSettings.customFont;if(!family)return;
  if(!await ensureCustomFont(family)){
    globalSettings.customFont='';applySettings();toast('上次使用的自定义字体不可用，已回退默认字体');
  }
}
async function adoptFont(payload){
  const family=`MoyueFont-${crypto.randomUUID()}`;
  const previous=fontList();saveFonts([...previous,{family,label:payload?.name||'已导入字体',url:payload?.url,added:Date.now()}]);
  if(!await ensureCustomFont(family)){saveFonts(previous);const token=(payload?.url||'').split('/').pop();if(token)window.Android?.deleteFont?.(token);toast('这个字体文件无法加载，已保留默认字体');return;}settings.customFont=family;
  if(bookProfileActive()){state.book.typeset.values.customFont=family;putBook(state.book).catch(reportError);}else globalSettings.customFont=family;
  applySettings();requestReflow();toast('已应用字体：'+(payload?.name||family));
  if(overlays.querySelector('.sheet'))aa('font');
}
async function removeFont(family){
  const entry=fontList().find(f=>f.family===family);
  saveFonts(fontList().filter(f=>f.family!==family));
  const token=(entry?.url||'').split('/').pop();
  if(token)try{window.Android?.deleteFont?.(token);}catch{}
  for(const face of document.fonts)if(face.family===family)document.fonts.delete(face);
  if(globalSettings.customFont===family)globalSettings.customFont='';
  for(const book of state.books)if(book.typeset?.values.customFont===family){book.typeset.values.customFont='';await putBook(book);}
  if(settings.customFont===family)settings.customFont='';applySettings();requestReflow();
  if(overlays.querySelector('.sheet'))aa('font');
  toast('已移除该字体');
}
function fontOptions(){const list=fontList();return '<option value="">系统默认</option>'+list.map(f=>`<option value="${esc(f.family)}" ${settings.customFont===f.family?'selected':''}>${esc(f.label||f.family)}</option>`).join('');}
async function selectFont(value){
  settings.customFont=value||'';
  if(bookProfileActive())state.book.typeset.values.customFont=value||'';
  else globalSettings.customFont=value||'';
  if(value&&!await ensureCustomFont(value)){
    settings.customFont='';
    if(bookProfileActive())state.book.typeset.values.customFont='';else globalSettings.customFont='';
    toast('这个字体文件无法加载，已回退默认字体');
  }
  if(bookProfileActive())await putBook(state.book);
  applySettings();requestReflow();
}
function fontRow(){
  const list=fontList();
  const control=`<select data-input="font-select" aria-label="自定义字体">${fontOptions()}</select><button data-action="import-font" class="outlined">导入</button>${settings.customFont?`<button data-action="remove-font" class="outlined">移除</button>`:''}`;
  const hint=list.length?'':'<p class="panel-description">支持导入 TTF / OTF 字体文件，导入后仅保存在本机，可随时移除。字体损坏或加载失败时自动回退默认字体。</p>';
  return settingRow('自定义字体',control)+hint;
}

/* ---------- PDF reading modes ---------- */
function pdfColumnSetting(){const value=state.book?.pdfView?.column;return ['lr','rl'].includes(value)?value:'off';}
function pdfCropFor(page){const view=state.book?.pdfView||{};const odd=page%2===0;return odd?(view.cropOdd??!!view.crop):(view.cropEven??!!view.crop);}
function pdfEffectiveCrop(){return state.book?.kind==='pdf'?pdfCropFor(state.pdfPage):false;}
function pdfHasOverflow(direction){
  const host=$('#pdf-host');if(!host)return false;
  if(direction>0)return host.scrollTop+host.clientHeight<host.scrollHeight-8||host.scrollLeft+host.clientWidth<host.scrollWidth-8;
  return host.scrollTop>8||host.scrollLeft>8;
}
function panPdf(direction){
  const host=$('#pdf-host');if(!host)return false;
  const stepX=host.clientWidth*.8,stepY=host.clientHeight*.8;
  const canX=host.scrollWidth>host.clientWidth+8,canY=host.scrollHeight>host.clientHeight+8;
  if(!canX&&!canY)return false;
  if(canY&&(direction>0?host.scrollTop+host.clientHeight<host.scrollHeight-8:host.scrollTop>8)){
    host.scrollBy({top:direction*stepY,behavior:'instant'});return true;
  }
  if(canX&&(direction>0?host.scrollLeft+host.clientWidth<host.scrollWidth-8:host.scrollLeft>8)){
    host.scrollBy({left:direction*stepX,behavior:'instant'});return true;
  }
  return false;   // at the edge: fall through to a page turn
}

async function saveNote(text=''){
  if(!state.selected||!state.book||state.noteSaving)return;state.noteSaving=true;const book=state.book,generation=readerGeneration,selected=structuredClone(state.selected);
  try{
    if(book.kind==='pdf'&&selected.extended){const d={bookId:book.id,pdf:state.pdf,models:new Map()},parts=[];for(const f of fragmentsOf(selected)){const m=await pdfModel(d,f.pdfPage);parts.push(m.resolve?await m.resolve(f.start,f.end):f);}Object.assign(selected,combinePdfFragments(parts));}
    if(generation!==readerGeneration)return;
    const note={...selected,id:crypto.randomUUID(),note:text,created:Date.now()};delete note.extended;book.notes.push(note);clearSelection();state.selected=null;
    try{await flush();}catch(error){book.notes=book.notes.filter(n=>n.id!==note.id);throw error;}
    if(generation!==readerGeneration||state.book!==book)return;if(book.kind==='pdf')restorePdfHighlights();else state.paginator.highlight(note.start,note.end,note.id);toast(text?'已保存笔记':'已保存划线');
  }catch(error){if(error.name==='LibraryWriteError')throw error;if(error.name!=='AbortError')toast('划线未能保存：'+error.message);}finally{state.noteSaving=false;}
}
function noteCards(notes,book){return notes.length?notes.map(n=>`<article class="note-card"><div class="note-quote">${esc(n.text)}</div>${n.note?`<div class="note-text">${esc(n.note)}</div>`:''}<div class="note-meta grow"><span class="grow">${n.pdfPage!==undefined?'第 '+(n.pdfPage+1)+' 页':esc(book.title)} · ${new Date(n.created).toLocaleDateString('zh-CN')}</span><button data-action="note-jump" data-id="${n.id}" data-book="${book.id}">查看原文</button><button data-action="note-adjust" data-id="${n.id}" data-book="${book.id}">调整范围</button><button data-action="edit-note" data-id="${n.id}" data-book="${book.id}">编辑</button><button data-action="note-delete" data-id="${n.id}" data-book="${book.id}" class="danger-link">删除</button></div></article>`).join(''):'<p class="panel-description">长按正文选择文字，即可划线或写下笔记。扫描 PDF 需要先有文字层才能选取。</p>';}
function askDeleteNote(bookId,id){
  const book=state.books.find(b=>b.id===bookId),note=book?.notes.find(n=>n.id===id);if(!note)return;
  const hasText=!!(note.note||'').trim();
  state.pendingDelete={bookId,id};
  sheet(hasText?'删除这条笔记？':'删除这条划线？',`<div class="note-quote">${esc(note.text)}</div><p class="panel-description">${hasText?'这条划线附有笔记，删除后笔记内容会一并移除。':'删除后正文中的划线会立即移除。'}此操作无法撤销，只影响应用内的阅读记录，不会修改原始文件。</p>`,{footer:actionButton('close-sheet','取消','','class="outlined"')+actionButton('confirm-delete-note','删除','trash','class="primary"')});
}
function showBookNotes(tab='notes'){const book=state.book;state.noteTab=tab;state.lastList='book';const tabs=`<div class="sheet-tabs"><button data-action="book-notes" class="${tab==='notes'?'active':''}">划线与笔记 ${book.notes.length}</button><button data-action="bookmarks" class="${tab==='bookmarks'?'active':''}">书签 ${book.bookmarks.length}</button></div>`;const content=tab==='notes'?noteCards(book.notes,book):book.bookmarks.length?book.bookmarks.map(b=>`<div class="row"><button class="toc-item grow" data-action="bookmark-jump" data-id="${b.id}">${esc(b.label)}<span>${new Date(b.created).toLocaleDateString('zh-CN')}</span></button>${iconButton('remove-bookmark','删除书签','trash',`data-id="${b.id}"`)}</div>`).join(''):'<p class="panel-description">点击阅读工具栏中的书签图标，标记当前页。</p>';sheet('阅读记录',content,{tabs,footer:actionButton('note-search-open','搜索批注','search','class="outlined"')+actionButton('export-notes','导出摘录','export','class="outlined"')});}
function showNote(id,book=state.book){const n=book.notes.find(x=>x.id===id);if(!n)return;state.editNote={bookId:book.id,id};sheet('编辑笔记',`<div class="note-quote">${esc(n.text)}</div><textarea id="note-input" rows="5" style="width:100%" placeholder="写下你的想法…">${esc(n.note||'')}</textarea>`,{footer:actionButton('ask-delete-note','删除','trash',`data-id="${esc(n.id)}" data-book="${esc(book.id)}"`)+actionButton('save-edit-note','保存','','class="primary"')});}
function allNotes(){const books=state.books.filter(b=>b.notes.length);state.lastList='all';sheet('全部阅读笔记',books.length?books.map(b=>`<h3>${esc(b.title)}</h3>${noteCards(b.notes,b)}`).join(''):'<p class="panel-description">还没有笔记。打开一本书，长按正文选择文字即可开始。</p>',{wide:true,footer:actionButton('note-search-open-all','搜索批注','search','class="outlined"')+actionButton('export-all-notes','导出全部','export','class="outlined"')});}
function exportNotes(books){const text=books.map(b=>`# ${b.title}\n\n${b.author}\n\n`+b.notes.map(n=>`> ${n.text.replace(/\n/g,'\n> ')}\n\n${n.note||''}\n\n${new Date(n.created).toLocaleString('zh-CN')}\n\n---\n`).join('\n')).join('\n\n');if(!books.some(b=>b.notes.length)){toast('还没有可导出的笔记');return;}const filename=(books.length===1?books[0].title:'墨阅全部')+'-阅读摘录.md';if(window.Android)window.Android.saveText(text,filename);else download(new Blob([text],{type:'text/markdown;charset=utf-8'}),filename);}
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}

function segment(key,values,labels){return `<div class="segment">${values.map((v,i)=>`<button data-action="setting" data-key="${key}" data-value="${v}" class="${String(settings[key])===String(v)?'active':''}">${labels[i]}</button>`).join('')}</div>`;}
function toggleLabel(key){return{clock:'阅读时显示时钟',publisher:'保留出版排版',keepAwake:'保持屏幕常亮',volume:'音量键翻页',stroke:'字迹加深',systemScale:'跟随系统字体大小',einkMode:'墨水屏模式',pdfColor:'PDF 保留彩色'}[key]||key;}
function toggle(key){return `<button class="toggle ${settings[key]?'on':''}" data-action="setting" data-key="${key}" data-value="${!settings[key]}" role="switch" aria-checked="${settings[key]}" aria-label="${toggleLabel(key)}"></button>`;}
function settingRow(label,control){return `<div class="setting-row"><label>${label}</label><div>${control}</div></div>`;}
function aa(tab=state.aaTab){
  state.aaTab=tab;const tabs=`<div class="sheet-tabs">${[['theme','主题'],['font','字体'],['layout','版式'],['more','更多']].map(([id,name])=>`<button data-action="aa-tab" data-tab="${id}" class="${tab===id?'active':''}">${name}</button>`).join('')}</div>`;
  let content='';
  if(tab==='font')content=`<div class="font-preview">山间的风，轻轻翻过书页。<br><span style="font-size:14px">A quiet moment, a page at a time.</span></div>${settingRow('字体',segment('font',['serif','sans'],['宋体','黑体']))}${fontRow()}${settingRow('字号',`<button data-action="font-smaller" class="outlined" aria-label="减小字号">A−</button><span style="width:34px;text-align:center">${settings.size}</span><button data-action="font-larger" class="outlined" aria-label="增大字号">A＋</button>`)}${settingRow('字重',segment('weight',[400,600],['标准','加粗']))}${settingRow('字迹加深',toggle('stroke'))}${settingRow('跟随系统字号',toggle('systemScale'))}`;
  else if(tab==='layout')content=settingRow('行距',segment('line',[1.55,1.75,2],['紧凑','标准','宽松']))+settingRow('边距',segment('margin',[5,9,12],['窄','标准','宽']))+settingRow('对齐',segment('align',['justify','left'],['两端','左对齐']))+settingRow('出版排版',toggle('publisher'))+(state.doc?.layoutChapters?settingRow('Word 视图',`<button data-action="word-layout" class="outlined">${state.book.originalLayout?'切换正文模式':'查看原版页面'}</button>`):state.doc?.reflowChapters?settingRow('Word 视图','<button data-action="word-layout" class="outlined">切换正文模式</button>'):'')+settingRow('排版范围',`<div class="segment"><button data-action="typeset-mode" data-value="global" class="${bookProfileActive()?'':'active'}">全局</button><button data-action="typeset-mode" data-value="book" class="${bookProfileActive()?'active':''}">仅此书</button></div>`)+`<p class="panel-description">出版排版保留书内标题、段落和表格样式。关闭后使用统一正文排版。Word 原版预览尽量保留纸张与分页，复杂公式和浮动对象可能存在差异。${bookProfileActive()?'当前使用这本书自己的排版，切换为「全局」或点下方的恢复按钮可回到默认设置。':''}</p>`;
  else if(tab==='theme')content=`<div class="theme-grid">${[['standard','标准'],['compact','紧凑'],['large','大字'],['comfortable','舒展']].map(([v,label])=>`<button class="theme-choice" data-action="preset" data-value="${v}"><span class="theme-icon"><i></i><i></i><i></i><i></i></span>${label}</button>`).join('')}</div>${settingRow('页面',segment('theme',['paper','warm','night'],['灰纸','暖纸','夜间']))}${settingRow('我的主题',actionButton('themes-open','管理主题','','class="outlined"'))}${settingRow('屏幕亮度',`<input type="range" min="2" max="100" value="${settings.brightness<0?45:Math.round(settings.brightness*100)}" data-input="brightness" aria-label="屏幕亮度"><button data-action="system-brightness" class="outlined">${settings.brightness<0?'跟随系统':'恢复系统'}</button>`)}<p class="panel-description">纸张主题也应用于 PDF 和设置面板。亮度控制需运行环境支持；可随时恢复系统亮度。</p>`;
  else content=settingRow('翻页效果',`<select data-input="setting-select" data-key="animation" aria-label="翻页效果"><option value="paper" ${settings.animation!=='none'?'selected':''}>白场清屏后显示新页</option><option value="none" ${settings.animation==='none'?'selected':''}>直接切换</option></select>`)+settingRow('白场停留',`<select data-input="setting-select" data-key="dwell" aria-label="白场停留时长"><option value="60" ${settings.dwell<=60?'selected':''}>短（60ms）</option><option value="125" ${settings.dwell>60&&settings.dwell<180?'selected':''}>标准（125ms）</option><option value="200" ${settings.dwell>=180?'selected':''}>长（200ms）</option></select>`)+settingRow('模拟整屏刷新',`<select data-input="setting-select" data-key="refreshEvery" aria-label="每多少页模拟整屏刷新一次"><option value="0" ${settings.refreshEvery===0?'selected':''}>关闭</option><option value="5" ${settings.refreshEvery===5?'selected':''}>每 5 页</option><option value="10" ${settings.refreshEvery===10?'selected':''}>每 10 页</option><option value="20" ${settings.refreshEvery===20?'selected':''}>每 20 页</option></select>`)+settingRow('显示时钟',toggle('clock'))+settingRow('保持常亮',toggle('keepAwake'))+settingRow('音量键翻页',toggle('volume'))+settingRow('墨水屏模式',toggle('einkMode'))+settingRow('PDF 保留彩色',toggle('pdfColor'))+settingRow('阅读速度',`<button data-action="reset-speed" class="outlined">重新学习</button><span class="small muted">${readingSpeed()?`${readingSpeed().samples} 次采样 · ${Math.round(readingSpeed().cpm)} 字/分`:'尚未采集'}</span>`)+`<p class="panel-description">翻页先清为空白纸面，再一次显示完整的新页；与当前纸张颜色一致。「模拟整屏刷新」按设定页数显示黑白图层，仅模拟闪屏，不保证触发墨水屏硬件全刷；可关闭。墨水屏模式会关闭过渡动画与阴影，保留清晰的选中状态。阅读速度仅保存在本机，可随时重新学习。</p>`;
  if(state.book?.kind==='pdf'&&state.route==='reader'&&(tab==='font'||tab==='layout'))content='<p class="panel-description">PDF 保留原版页面，字号和行距由文件本身决定。请使用工具栏中的缩放、旋转和裁白边。</p>';
  sheet('阅读设置',content,{tabs});
}
function changeSetting(key,value){
  if(!(key in defaults))return;
  if(typeof defaults[key]==='number')value=Number(value);
  if(typeof defaults[key]==='boolean')value=value==='true'||value===true;
  settings[key]=value;
  // A book profile owns only typography keys; everything else stays global.
  if(bookProfileActive()&&bookKeys.includes(key)){state.book.typeset.values[key]=value;putBook(state.book).catch(reportError);}
  else globalSettings[key]=value;
  applySettings();
  if(['size','line','margin','weight','font','align','publisher','systemScale'].includes(key)){if(key==='publisher'&&state.book)displayChapter(state.chapter,state.book.locator.anchor).catch(reportError);else requestReflow();}
  if(overlays.querySelector('.sheet-tabs'))aa();
}
function preview(fraction=progress()){
  state.previewFraction=fraction;const loc=locatorAt(fraction);const cards='<div class="preview-cards">'+[-1,0,1].map(d=>`<div class="real-preview ${d===0?'active':''}" data-preview-d="${d}"><div class="preview-frame">正在生成…</div><small></small></div>`).join('')+'</div>';
  sheet('页面预览',`<p class="preview-label">预览不会改变当前阅读位置</p>${cards}<div class="scrub-row"><span>0%</span><input type="range" min="0" max="1000" value="${Math.round(fraction*1000)}" data-input="preview" aria-label="预览位置"><span>${Math.round(fraction*100)}%</span></div>`,{wide:true,footer:actionButton('close-sheet','返回原页','','class="outlined"')+actionButton('confirm-preview','读这一页','','class="primary"')});
  const root=$('.preview-cards'),pdf=state.pdf,doc=state.doc,vr=$('#page-viewport')?.getBoundingClientRect();
  (async()=>{for(const card of root.children){if(!root.isConnected)return;const d=Number(card.dataset.previewD),frame=card.firstElementChild;
    if(pdf){const index=Math.max(0,Math.min(pdf.numPages-1,loc.pdfPage+d));const {pdfThumbnail}=await import('./page-art.js');const url=await pdfThumbnail(pdf,index);if(!root.isConnected)return;frame.replaceChildren(Object.assign(new Image(),{src:url,alt:`第 ${index+1} 页缩略图`}));card.lastElementChild.textContent='第 '+(index+1)+' 页';}
    else{const chapterIndex=doc.chapters[loc.chapter].fixed?Math.max(0,Math.min(doc.chapters.length-1,loc.chapter+d)):loc.chapter,c=doc.chapters[chapterIndex];frame.replaceChildren();const vp=document.createElement('div');vp.className='mini-viewport';vp.style.cssText=`width:${vr.width}px;height:${vr.height}px;transform:scale(${frame.clientWidth/vr.width});transform-origin:0 0;position:absolute;overflow:hidden`;const flow=document.createElement('article');flow.className='flow';vp.append(flow);frame.append(vp);frame.style.height=frame.clientWidth*vr.height/vr.width+'px';const p=new Paginator(vp,flow);await p.layout(c.html,loc.anchor,c.fixed&&settings.publisher?c:null,{clean:false});p.go(c.fixed?0:p.page+d);card.lastElementChild.textContent=c.title+' · '+(p.page+1)+' / '+p.pages;}
  }})().catch(error=>{if(root.isConnected)root.textContent='预览暂时无法生成，可使用页码跳转。';console.warn('Preview',error);});
}
function goto(){const pdf=state.book.kind==='pdf';sheet(pdf?'跳转到页码':'跳转到阅读进度',`<label for="goto-input" class="panel-description">${pdf?`页码：1–${state.book.pages}`:'进度：0–100%'}</label><input id="goto-input" type="number" inputmode="numeric" min="${pdf?1:0}" max="${pdf?state.book.pages:100}" value="${pdf?state.pdfPage+1:Math.round(progress()*100)}" style="width:100%;margin-top:12px">`,{footer:actionButton('confirm-goto','跳转','','class="primary"')});}
function showSearch(){sheet('搜索书内内容',`<div class="row"><input id="book-search-input" type="search" placeholder="输入关键词" aria-label="书内搜索关键词" style="flex:1;min-width:0">${actionButton('run-search','搜索','','class="outlined"')}</div><div class="search-results" id="book-search-results"><p class="panel-description">搜索整本书的文字内容。</p></div>`);setTimeout(()=>$('#book-search-input')?.focus(),50);}
async function runSearch(){
  const query=$('#book-search-input')?.value.trim();if(!query||!state.book)return;const nonce=++state.searchNonce,root=$('#book-search-results'),pdf=state.pdf,doc=state.doc,results=[];let skipped=0;
  const current=()=>nonce===state.searchNonce&&root.isConnected;root.innerHTML='<p class="panel-description">正在搜索…</p>';state.results=results;const needle=query.toLocaleLowerCase();
  if(state.book.kind==='pdf'){
    for(let i=0;i<pdf.numPages;i++){if(!current())return;let page;
      try{page=await pdf.getPage(i+1);if(!current())return;const content=await page.getTextContent();if(!current())return;const text=content.items.map(x=>x.str).join(' '),pos=text.toLocaleLowerCase().indexOf(needle);if(pos>=0)results.push({title:'第 '+(i+1)+' 页',text:text.slice(Math.max(0,pos-30),pos+query.length+70),locator:{pdfPage:i}});}
      catch(error){if(!current())return;skipped++;console.warn('Skipping unavailable PDF search text',i+1,error);}
      finally{try{page?.cleanup();}catch{}}
      if(results.length>=100)break;if(i%5===0){root.innerHTML=`<p class="panel-description">已搜索 ${i+1} / ${pdf.numPages} 页…</p>`;await new Promise(r=>setTimeout(r,0));}
    }
  }else for(let i=0;i<doc.chapters.length;i++){const c=doc.chapters[i];let from=0;for(let pos;(pos=c.text.toLocaleLowerCase().indexOf(needle,from))>=0&&results.length<100;from=pos+query.length)results.push({title:c.title,text:c.text.slice(Math.max(0,pos-25),pos+query.length+65),locator:{chapter:i,anchor:pos,...(state.book.originalLayout?{view:'original'}:{})},end:pos+query.length});if(results.length>=100)break;}
  if(nonce!==state.searchNonce||!root.isConnected)return;state.searchQuery=query;root.innerHTML=state.results.length?`<p class="panel-description">找到 ${state.results.length}${state.results.length===100?' 条以上':' 条'}结果</p>`+state.results.map((r,i)=>`<button class="search-result" data-action="search-jump" data-index="${i}"><small>${esc(r.title)}</small>${esc(r.text).replaceAll(esc(query),`<b>${esc(query)}</b>`)}</button>`).join(''):state.pdf?.textUnavailable?'<p class="panel-description">当前系统和备用文字引擎都未能读取此文件的文字层，页面仍可正常阅读。可尝试标准模式，扫描图片需先做 OCR。</p>':'<p class="panel-description">没有找到匹配文字。扫描版 PDF 若没有文字层，将无法搜索。</p>';
  if(skipped)root.insertAdjacentHTML('afterbegin',`<p class="panel-description">${skipped} 页文字层暂不可用，已跳过；页面阅读不受影响。</p>`);
}

function filters(){const groups=[...new Set(state.books.flatMap(b=>b.collections||[]))];sheet('筛选书库',`<div class="setting-row"><label>阅读状态</label>${segmentFilter()}</div><div class="setting-row"><label>内容</label><div>${['all','documents','favorite'].map((v,i)=>`<button class="outlined" data-action="set-filter" data-value="${v}">${['全部','文档','收藏'][i]}</button>`).join('')}</div></div><h3 style="font-size:15px;margin:24px 0 14px">收藏集</h3>${groups.length?groups.map(g=>`<button class="collection-chip" data-action="set-collection" data-value="${esc(g)}"><span>${esc(g)}</span><span class="muted small">${state.books.filter(b=>b.collections?.includes(g)).length} 本</span></button>`).join(''):'<p class="panel-description">在书籍的更多菜单中，可以把书加入收藏集。</p>'}`);}
function segmentFilter(){return `<div class="segment">${[['all','全部'],['unread','未读'],['read','已读']].map(([v,label])=>`<button class="${state.filter===v?'active':''}" data-action="set-filter" data-value="${v}">${label}</button>`).join('')}</div>`;}
function bookMenu(id){const b=state.books.find(b=>b.id===id);state.menuBook=id;const items=[['favorite',b.favorite?'取消收藏':'收藏这本书','heart'],['collection','加入收藏集','book'],['rename','修改书名','notes'],['mark-read',b.finished?'标记为未读':'标记为已读','check'],...(b.kind==='pdf'&&nativePdfAvailable()?[['compat-open','用 PDF 兼容模式打开','book'],['standard-open','用 PDF 标准模式打开','book']]:[]),['delete-book','从本机删除','trash']];sheet(b.title,`<p class="panel-description">${esc(b.author)} · ${esc(b.format)}<br>${esc(b.filename)}</p>${items.map(([a,label,ico])=>`<button class="toc-item" data-action="${a}" data-id="${b.id}"><span class="row" style="color:inherit;font-size:15px">${icon(ico,19)}${label}</span>${icon('next',16)}</button>`).join('')}`);}
function mainMenu(){sheet('墨阅',`${[['all-notes','全部阅读笔记','notes'],['vocab-open','生词本','bookmark'],['dict-manage','离线词典','book'],['backup','书库备份与恢复','export'],['settings','阅读偏好','settings'],['help','使用说明','book'],['about','关于与开源许可','more']].map(([a,label,ico])=>`<button class="toc-item" data-action="${a}"><span class="row" style="color:inherit;font-size:15px">${icon(ico,20)}${label}</span>${icon('next',16)}</button>`).join('')}`);}
function help(){sheet('使用说明',`<div class="help-block"><h3>导入自己的书</h3><p>点击书库上方的「导入」，支持批量选择 PDF、EPUB、DOCX、DOC、TXT、Markdown 和 HTML。单个文件最大 100 MB。相同内容的文件会自动去重。</p><h3>阅读与翻页</h3><p>点正文的大部分区域进入下一页，点左侧较窄区域返回上一页；也可以左右滑动。点顶部展开工具栏。支持音量键和外接键盘方向键翻页。</p><h3>字体与版式</h3><p>点击 Aa 调整字号、字重、行距、边距和页面主题。改变排版或横竖屏时，会按正文文字位置恢复阅读进度。</p><h3>PDF 文档</h3><p>保留原始页面；在工具栏中缩放、旋转或裁减白边。具有文字层的 PDF 支持选取和搜索；扫描图片不会自动 OCR。受密码或 DRM 保护的文件需先解除限制。</p><h3>笔记和书签</h3><p>长按正文选择文字，可划线或写笔记。点击工具栏书签图标标记当前位置。阅读记录可导出为 Markdown 文件。</p><h3>本地保存</h3><p>原始文件副本、书籍、阅读进度与笔记均保存在应用本地，断网可用。在更多菜单中可完整备份书库，并通过导入 .moyue 文件恢复。卸载前请先把备份保存到应用之外。</p><h3>格式说明</h3><p>DOCX 保留段落、标题、表格和图片等阅读内容；旧版 DOC 主要提取正文，不保证复杂版式。EPUB 保留安全的出版样式与固定页面；Word 可切换原版预览与正文模式。复杂公式、浮动对象与交互内容仍可能有差异。</p></div>`,{wide:true});}

async function handleAction(button){
  const a=button.dataset.action,id=button.dataset.id,generation=readerGeneration;
  if(state.turning&&!['exit-reader','home','library','recover-home','close-sheet'].includes(a)){await state.turnFinished;if(generation!==readerGeneration||state.route!=='reader')return;}
  switch(a){
    case'import':pickFiles();break;
    case'backup':sheet('书库备份与恢复','<p class="panel-description">备份包含原文件、书名、收藏集、进度、书签、笔记和阅读偏好。恢复时按原文件合并，重复书籍采用备份里的记录，其余书籍保留。备份需保存在应用之外，支持总计 1 GB 的书库。自定义字体文件不包含在备份中，换设备恢复后需重新导入。</p>',{footer:actionButton('restore-library','恢复备份','','class="outlined"')+actionButton('export-library','保存完整备份','','class="primary"')});break;
    case'export-library':await exportLibrary();break;
    case'restore-library':closeSheet();pickFiles();toast('请选择之前保存的 .moyue 备份文件');break;
    case'system-brightness':changeSetting('brightness',-1);break;
    case'word-layout':button.disabled=true;if(await switchWordLayout(!state.book.originalLayout)){toggleTools();aa('layout');}break;
    case'home':case'recover-home':leaveReader('home');break;
    case'library':case'exit-reader':leaveReader('library');break;
    case'clear-filter':state.query='';state.filter='all';state.collection='';renderLibrary('library');break;
    case'open-book':await openBook(id);break;
    case'compat-open':case'standard-open':{const b=state.books.find(b=>b.id===(id||state.book?.id));if(!b)return;leaveReader('library');b.pdfMode=a==='compat-open'?'native':'auto';await putBook(b);await openBook(b.id);break;}
    case'view':state.view=state.view==='grid'?'list':'grid';localStorage.setItem('moyue-view',state.view);renderLibrary();break;
    case'main-menu':mainMenu();break;
    case'close-sheet':closeSheet();break;
    case'book-menu':bookMenu(id);break;
    case'filters':filters();break;
    case'set-filter':state.filter=button.dataset.value;state.collection='';closeSheet();renderLibrary('library');break;
    case'set-collection':state.collection=button.dataset.value;closeSheet();renderLibrary('library');break;
    case'sort':sheet('排序方式',[['recent','最近阅读'],['title','书名'],['author','作者'],['added','导入时间']].map(([v,label])=>`<button class="toc-item" data-action="set-sort" data-value="${v}">${label}${state.sort===v?icon('check',18):''}</button>`).join(''));break;
    case'set-sort':state.sort=button.dataset.value;closeSheet();renderLibrary();break;
    case'favorite':{const b=state.books.find(b=>b.id===id);b.favorite=!b.favorite;await putBook(b);closeSheet();renderLibrary();toast(b.favorite?'已收藏':'已取消收藏');break;}
    case'mark-read':{const b=state.books.find(b=>b.id===id);b.finished=!b.finished;await putBook(b);closeSheet();renderLibrary();break;}
    case'rename':{const b=state.books.find(b=>b.id===id);state.menuBook=id;sheet('修改书名',`<input id="rename-input" maxlength="200" value="${esc(b.title)}" style="width:100%" aria-label="书名">`,{footer:actionButton('confirm-rename','保存','','class="primary"')});break;}
    case'confirm-rename':{const title=$('#rename-input').value.trim();if(!title){toast('请输入书名');break;}const b=state.books.find(b=>b.id===state.menuBook);b.title=title;await putBook(b);closeSheet();renderLibrary();break;}
    case'collection':{const b=state.books.find(b=>b.id===id);state.menuBook=id;const groups=[...new Set(state.books.flatMap(x=>x.collections))];sheet('收藏集',`<p class="panel-description">当前：${b.collections.length?b.collections.map(esc).join('、'):'尚未加入收藏集'}</p>${groups.map(g=>`<button class="toc-item" data-action="toggle-collection" data-value="${esc(g)}">${esc(g)}${b.collections.includes(g)?icon('check',18):icon('plus',18)}</button>`).join('')}<div class="row" style="margin-top:20px"><input id="collection-input" placeholder="新建收藏集" maxlength="40" style="flex:1;min-width:0">${actionButton('new-collection','添加','','class="outlined"')}</div>`);break;}
    case'toggle-collection':{const b=state.books.find(b=>b.id===state.menuBook),v=button.dataset.value;b.collections=b.collections.includes(v)?b.collections.filter(x=>x!==v):[...b.collections,v];await putBook(b);closeSheet();renderLibrary();toast('已更新收藏集');break;}
    case'new-collection':{const v=$('#collection-input').value.trim();if(!v){toast('请输入收藏集名称');break;}const b=state.books.find(b=>b.id===state.menuBook);if(!b.collections.includes(v))b.collections.push(v);await putBook(b);closeSheet();renderLibrary();toast('已加入收藏集');break;}
    case'delete-book':state.menuBook=id;sheet('删除这本书？','<p class="panel-description">将删除应用内的书籍副本、进度、书签和笔记。系统原文件不会被删除。</p>',{footer:actionButton('close-sheet','保留','','class="outlined"')+actionButton('confirm-delete','删除','','class="primary"')});break;
    case'confirm-delete':await deleteBook(state.menuBook);invalidateLibrarySearch(state.menuBook);state.books=state.books.filter(b=>b.id!==state.menuBook);if(localStorage.getItem('moyue-current')===state.menuBook)localStorage.removeItem('moyue-current');if(state.book?.id===state.menuBook)state.book=null;closeSheet();renderLibrary();break;
    case'next':await turn(1);break;
    case'prev':await turn(-1);break;
    case'progress':settings.progress=(settings.progress+1)%4;applySettings();updateProgress();break;
    case'toc':showToc();break;
    case'toc-jump':{const item=state.doc.toc[Number(button.dataset.index)];await jump(state.book.kind==='pdf'?{pdfPage:item.page}:{chapter:item.chapter,fragment:item.fragment});break;}
    case'bookmark':await toggleBookmark();break;
    case'book-notes':showBookNotes();break;
    case'bookmarks':showBookNotes('bookmarks');break;
    case'bookmark-jump':await jump({view:'text',...state.book.bookmarks.find(b=>b.id===id).locator});break;
    case'remove-bookmark':await deleteBookmark(state.book?.id||state.menuBook||state.book?.id,id);break;
    case'history-back':await goHistory(-1);break;
    case'history-forward':await goHistory(1);break;
    case'highlight':await saveNote();break;
    case'annotate':clearSelection();sheet('写下笔记',`<div class="note-quote">${esc(state.selected?.text||'')}</div><textarea id="note-input" placeholder="写下你的想法…" rows="5" style="width:100%"></textarea>`,{footer:actionButton('save-note','保存笔记','','class="primary"')});break;
    case'save-note':{const text=$('#note-input').value.trim();closeSheet();await saveNote(text);break;}
    case'cancel-selection':clearSelection();state.selected=null;break;
    case'copy-selection':{const text=state.selected?.text||'';try{await navigator.clipboard.writeText(text);toast('已复制');}catch{toast('请使用系统文字选择菜单复制');}clearSelection();break;}
    case'edit-note':showNote(id,state.books.find(b=>b.id===button.dataset.book));break;
    case'save-edit-note':{const b=state.books.find(b=>b.id===state.editNote.bookId),n=b.notes.find(n=>n.id===state.editNote.id);n.note=$('#note-input').value.trim();await putBook(b);closeSheet();toast('笔记已保存');break;}
    case'note-delete':case'ask-delete-note':askDeleteNote(button.dataset.book,id);break;
    case'confirm-delete-note':{const pending=state.pendingDelete;state.pendingDelete=null;if(pending)await deleteAnnotation(pending.bookId,pending.id);break;}
    case'note-jump':{const book=state.books.find(b=>b.id===button.dataset.book),n=book.notes.find(n=>n.id===id);if(state.route!=='reader'||state.book.id!==book.id){if(!await openBook(book.id))break;}await jump(n.pdfPage!==undefined?{pdfPage:n.pdfPage}:{chapter:n.chapter,anchor:n.start,view:n.view||'text'});break;}
    case'all-notes':allNotes();break;
    case'export-notes':exportNotes([state.book]);break;
    case'export-all-notes':exportNotes(state.books);break;
    case'aa':aa();break;
    case'aa-tab':aa(button.dataset.tab);break;
    case'setting':changeSetting(button.dataset.key,button.dataset.value);break;
    case'themes-open':showThemes();break;
    case'theme-create':await createThemeFromInput();break;
    case'theme-apply':await applyThemeById(id);break;
    case'theme-update':{const list=themeList(),theme=list.find(x=>x.id===id);if(theme){theme.values=themeSnapshot();saveThemes(list);showThemes();toast('已用当前排版更新主题');}break;}
    case'theme-rename':{const theme=themeList().find(x=>x.id===id);if(!theme)break;sheet('重命名主题',`<input id="theme-rename" maxlength="40" value="${esc(theme.name)}" style="width:100%" aria-label="主题名称">`,{footer:actionButton('close-sheet','取消','','class="outlined"')+actionButton('theme-rename-save','保存','','class="primary" data-id="'+esc(id)+'"')});break;}
    case'theme-rename-save':{const name=($('#theme-rename')?.value||'').trim();if(!name){toast('名称不能为空');break;}const list=themeList(),theme=list.find(x=>x.id===id);if(theme){theme.name=name;saveThemes(list);}showThemes();break;}
    case'theme-delete':saveThemes(themeList().filter(x=>x.id!==id));showThemes();toast('已删除主题');break;
    case'lookup-selection':{const text=(state.selected?.text||'').trim();if(!text)break;const word=text.split(/\s+/)[0].slice(0,40),context=vocabContext();clearSelection();state.selected=null;await showLookup(word,context);break;}
    case'vocab-add':await addVocabFromLookup();break;
    case'dict-manage':showDictionaryManager();break;
    case'dict-import':closeSheet();if(window.Android?.pickDictionary)window.Android.pickDictionary();else $('#dict-picker').click();break;
    case'dict-remove':await removeDictionary(id);break;
    case'vocab-open':await loadVocab();showVocab();break;
    case'vocab-filter':showVocab(button.dataset.value,state.vocabQuery);break;
    case'vocab-search':showVocab(state.vocabFilter,($('#vocab-search')?.value||'').trim());break;
    case'vocab-review':showVocabCardFor(id);break;
    case'vocab-jump':await jumpToVocab(id);break;
    case'vocab-remove':confirmRemoveVocab(id);break;
    case'confirm-vocab-remove':await removeVocab(state.pendingVocab||id);break;
    case'vocab-cards':showVocabCard();break;
    case'card-show':{const answer=$('#card-answer');if(answer)answer.hidden=false;const footer=overlays.querySelector('.sheet-footer');if(footer)footer.innerHTML=actionButton('card-known','认识','','class="primary"')+actionButton('card-again','需复习','','class="outlined"');break;}
    case'card-known':await reviewVocab(state.cardQueue?.[state.cardIndex],'known');break;
    case'card-again':await reviewVocab(state.cardQueue?.[state.cardIndex],'review');break;
    case'vocab-cards-next':{state.cardIndex=(state.cardIndex||0)+1;if(state.cardIndex>=(state.cardQueue||[]).length){closeSheet();toast('本轮复习完成');}else renderVocabCard();break;}
    case'note-adjust':await showAdjustRange(button.dataset.book,id);break;
    case'pdf-adjust-page':await adjustPdfPage(button.dataset.edge,Number(button.dataset.dir));break;
    case'dict-import-cancel':closeSheet();break;
    case'vocab-auto':{const value=localStorage.getItem('moyue-vocab-auto')!=='1';localStorage.setItem('moyue-vocab-auto',value?'1':'0');showVocab();break;}
    case'vocab-reset':sheet('重置学习状态？','<p>保留全部生词、释义和原句，清除学习状态与复习记录。</p>',{footer:actionButton('close-sheet','取消','','class="outlined"')+actionButton('vocab-reset-confirm','重置全部','','class="primary"')});break;
    case'vocab-reset-confirm':await putVocabBatch(state.vocab.map(resetLearning));await loadVocab();showVocab();toast('已重置学习状态');break;
    case'vocab-reset-one':{const v=state.vocab.find(v=>v.id===id);if(v){await putVocabRecord(resetLearning(v));await loadVocab();showVocab();toast('已重置这个生词');}break;}
    case'library-index-clear':state.librarySearchAbort?.abort();await clearSearchCache();state.libraryResults=null;state.libraryReturn=null;showLibrarySearch();toast('已清理搜索缓存，书籍与批注保留');break;
    case'adjust-start-back':await adjustNudge('start',-1);break;
    case'adjust-start-forward':await adjustNudge('start',1);break;
    case'adjust-end-back':await adjustNudge('end',-1);break;
    case'adjust-end-forward':await adjustNudge('end',1);break;
    case'adjust-start-sentence':adjustSentence('start');break;
    case'adjust-end-sentence':adjustSentence('end');break;
    case'adjust-save':await saveAdjustRange();break;
    case'extend-forward':await extendSelection(1);break;
    case'extend-back':await extendSelection(-1);break;
    case'note-search-open':showNoteSearch('book');break;
    case'note-search-open-all':showNoteSearch('all');break;
    case'note-search-run':runNoteSearch();break;
    case'note-search-scope':showNoteSearch(button.dataset.value);break;
    case'note-result':await openNoteResult(button);break;
    case'library-fulltext-open':state.libraryReturn=null;showLibrarySearch();break;
    case'library-search-run':await runLibrarySearch();break;
    case'library-search-cancel':state.librarySearchAbort?.abort();state.libraryQuery='';state.libraryResults=null;closeSheet();break;
    case'library-result':await openLibraryResult(button);break;
    case'typeset-mode':{
      if(state.route!=='reader'||!state.book)break;
      const book=state.book;
      if(button.dataset.value==='book'){
        book.typeset={values:pickBookProfile(settings),enabled:true};
        settings=withBookProfile(globalSettings,book.typeset.values);
      }else{
        book.typeset=null;settings=globalSettings;
      }
      await putBook(book);applySettings();requestReflow();aa('layout');
      toast(book.typeset?'已改为只对这本书生效':'已恢复使用全局排版');
      break;}
    case'import-font':try{window.Android?.pickFont?.();}catch{toast('当前环境无法导入字体');}break;
    case'remove-font':await removeFont(settings.customFont);break;
    case'reset-speed':try{localStorage.removeItem(SPEED_KEY);}catch{}state.speedSample=null;toast('已清除阅读速度样本，将重新学习');aa('more');break;
    case'footnote-goto':{const note=state.pendingFootnote;state.pendingFootnote=null;if(!note)break;closeSheet();await jump({chapter:note.index,anchor:0,fragment:note.id});toast('已跳到注释原文，可用工具栏的返回按钮回到原处');break;}
    case'font-smaller':changeSetting('size',Math.max(14,settings.size-2));break;
    case'font-larger':changeSetting('size',Math.min(42,settings.size+2));break;
    case'preset':{const presets={standard:{size:23,line:1.75,margin:9},compact:{size:20,line:1.55,margin:5},large:{size:30,line:1.75,margin:9},comfortable:{size:25,line:2,margin:12}};Object.assign(settings,presets[button.dataset.value]);if(bookProfileActive()){Object.assign(state.book.typeset.values,presets[button.dataset.value]);await putBook(state.book);}applySettings();requestReflow();aa('theme');break;}
    case'preview':preview();break;
    case'confirm-preview':await jump(locatorAt(state.previewFraction));break;
    case'goto':goto();break;
    case'confirm-goto':{const value=Number($('#goto-input').value);if(!Number.isFinite(value)){toast('请输入有效数字');break;}if(state.book.kind==='pdf'){if(value<1||value>state.book.pages){toast('页码超出范围');break;}await jump({pdfPage:Math.floor(value)-1});}else{if(value<0||value>100){toast('请输入 0–100 的进度');break;}await jump(locatorAt(value/100));}break;}
    case'search-book':if(state.pdf?.isNative){state.pdf.textRequested=true;state.pdfCache.clear();}showSearch();break;
    case'pdf-text':if(state.pdf?.isNative){state.pdf.textRequested=true;state.pdfCache.clear();await displayPdf();toast('正在尝试读取文字层；扫描图片仍需 OCR');}break;
    case'run-search':await runSearch();break;
    case'search-jump':{const result=state.results[Number(button.dataset.index)];if(!result)break;await jump(result.locator);if(generation===readerGeneration&&state.route==='reader'&&state.book.kind!=='pdf')state.paginator.highlight(result.locator.anchor,result.end,'search');break;}
    case'pdf-crop':{const view=state.book.pdfView||(state.book.pdfView={});if(view.cropOdd===undefined)view.cropOdd=!!view.crop;if(view.cropEven===undefined)view.cropEven=!!view.crop;const key=state.pdfPage%2===0?'cropOdd':'cropEven';view[key]=!view[key];view.crop=view[key];state.crop=view[key];await displayPdf();toast(view[key]?'已裁掉这一组页面的白边':'已恢复这一组页面的完整页面');break;}
    case'pdf-column':{const view=state.book.pdfView||(state.book.pdfView={});const next={off:'lr',lr:'rl',rl:'off'}[pdfColumnSetting()];view.column=next;state.pdfColumnIndex=0;if(next!=='off'){view.fitWidth=true;state.fitWidth=true;}await displayPdf();toast({off:'已关闭分栏，恢复正常单页',lr:'分栏阅读：先左后右',rl:'分栏阅读：先右后左'}[next]);break;}
    case'pdf-fit':state.zoom=1;state.crop=false;state.fitWidth=!state.fitWidth;await displayPdf();break;
    case'pdf-zoom':state.zoom=state.zoom>=2?1:state.zoom+.25;await displayPdf();break;
    case'pdf-rotate':state.rotation=(state.rotation+90)%360;await displayPdf();break;
    case'pdf-contrast':{const steps=[1,1.25,1.5],index=steps.indexOf(settings.pdfContrast),next=steps[(index<0?0:index+1)%steps.length];changeSetting('pdfContrast',next);if(state.tools)renderReaderTools();toast('PDF 对比度 '+Math.round(next*100)+'%');break;}
    case'reader-menu':sheet('阅读选项',actionButton('goto','跳转到位置','book','class="toc-item"')+actionButton('bookmarks','查看书签','bookmark','class="toc-item"')+actionButton('preview','页面预览','grid','class="toc-item"')+(state.book.kind==='pdf'&&nativePdfAvailable()?actionButton(state.pdf?.isNative?'standard-open':'compat-open',state.pdf?.isNative?'切换 PDF 标准模式':'切换 PDF 兼容模式','book','class="toc-item"'):'')+actionButton('settings','阅读偏好','settings','class="toc-item"')+actionButton('help','使用说明','book','class="toc-item"'));break;
    case'settings':aa('more');break;
    case'help':help();break;
    case'about':{const text=await(await fetch('./licenses.txt')).text(),version=text.split('\n')[0].match(/^墨阅\s+(\S+)/)?.[1]||'1.2.0';sheet('关于墨阅',`<div class="help-block"><h3>墨阅 ${esc(version)}</h3><p>本地优先的 Android 平板阅读器。界面参考 Kindle Paperwhite 的阅读结构，独立开发。</p><p>无需账号、无需网络权限。PDF 支持标准引擎与系统兼容引擎，Word 使用 Mammoth，EPUB 在本地解析。</p><details><summary>开源组件与字体许可</summary><pre style="white-space:pre-wrap;font:11px/1.6 monospace">${esc(text)}</pre></details></div>`);break;}
  }
}

document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button){event.preventDefault();handleAction(button).catch(reportError);}else if(event.target.matches('[data-backdrop]'))closeSheet();});
document.addEventListener('input',event=>{if(event.target.dataset.input==='brightness'){settings.brightness=Number(event.target.value)/100;applySettings();const button=overlays.querySelector('[data-action="system-brightness"]');if(button)button.textContent='恢复系统';}if(event.target.id==='library-search'){state.query=event.target.value;if(state.route==='home'){state.route='library';renderLibrary('library');const input=$('#library-search');input.focus();input.setSelectionRange?.(input.value.length,input.value.length);}else updateShelf();}});
document.addEventListener('change',event=>{const node=event.target;if(node.dataset.input==='setting-select')changeSetting(node.dataset.key,node.value);if(node.dataset.input==='font-select')selectFont(node.value).catch(reportError);if(node.dataset.input==='scrub')jump(locatorAt(Number(node.value)/1000)).catch(reportError);if(node.dataset.input==='preview')preview(Number(node.value)/1000);});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.id==='book-search-input'){event.preventDefault();runSearch().catch(reportError);return;}if(event.key==='Escape'){back();return;}if(event.target.matches('input,textarea,select')||overlays.firstChild)return;if(['ArrowRight','PageDown',' '].includes(event.key)){event.preventDefault();turn(1).catch(reportError);}if(['ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();turn(-1).catch(reportError);}});
let selectionTimer;document.addEventListener('selectionchange',()=>{clearTimeout(selectionTimer);if(window.getSelection()?.toString().trim())selectionTimer=setTimeout(showSelection,350);else $('.selection-tools')?.remove();});
$('#file-picker').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';if(files.length)importBatch(files);});
$('#dict-picker').addEventListener('change',event=>importDictionaryFromInput(event.target).catch(reportError));
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.route==='reader'){if(state.book.kind==='pdf')displayPdf().catch(reportError);else requestReflow();}},180);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){state.speedSample=null;}if(document.visibilityState==='hidden')flush().catch(error=>console.warn('Background save',error));});
function back(){if(state.imageViewer){closeImageViewer();return;}if(overlays.firstChild){closeSheet();return;}if($('.selection-tools')){clearSelection();state.selected=null;return;}if(state.noteSearchReturn&&state.route==='reader'){const saved=state.noteSearchReturn;state.noteSearchReturn=null;state.noteQuery=saved.query;showNoteSearch(saved.scope);return;}if(state.route==='reader'){if(state.tools){toggleTools();return;}handleAction({dataset:{action:'exit-reader'}}).catch(reportError);return;}window.Android?.minimize();}
/* ================= 1.1.5: themes, images, dictionary, vocabulary, notes ================= */

/* ---------- 07 custom reading themes ---------- */
const THEME_KEY='moyue-themes';
function themeList(){try{const v=JSON.parse(localStorage.getItem(THEME_KEY)||'[]');return Array.isArray(v)?v.filter(t=>t&&typeof t.id==='string'&&typeof t.name==='string'&&t.values):[]}catch{return[]}}
function saveThemes(list){try{localStorage.setItem(THEME_KEY,JSON.stringify(list));}catch(cause){const error=new Error('主题未能保存，请检查设备剩余空间',{cause});error.name='LibraryWriteError';throw error;}}
function themeSnapshot(){const values=pickBookProfile(settings);if(settings.customFont)values.customFont=settings.customFont;return values;}
async function applyThemeValues(values){
  const next={...values};
  if(next.customFont&&!await ensureCustomFont(next.customFont)){
    next.customFont='';toast('主题引用的字体已不可用，已回退默认字体');
  }
  next.customFont=next.customFont||'';
  const previousSettings={...settings},previousProfile=bookProfileActive()?{...state.book.typeset.values}:null;
  for(const key of bookKeys)if(next[key]!==undefined)settings[key]=next[key];
  settings.customFont=next.customFont;
  if(bookProfileActive()){
    for(const key of bookKeys)if(next[key]!==undefined)state.book.typeset.values[key]=next[key];
    state.book.typeset.values.customFont=next.customFont;
    try{await putBook(state.book);}catch(error){Object.assign(settings,previousSettings);state.book.typeset.values=previousProfile;throw error;}
  }else{
    for(const key of bookKeys)if(next[key]!==undefined)globalSettings[key]=next[key];
    globalSettings.customFont=next.customFont||'';
  }
  applySettings();requestReflow();
}
function showThemes(){
  const list=themeList();
  const rows=list.length?list.map(t=>`<div class="theme-row" data-theme="${esc(t.id)}"><div class="grow"><strong>${esc(t.name)}</strong><small>${t.values.size||settings.size}px · 行距 ${t.values.line||settings.line}${t.values.customFont?' · 自定义字体':''}</small></div><button data-action="theme-apply" data-id="${esc(t.id)}" class="outlined">应用</button><button data-action="theme-update" data-id="${esc(t.id)}">更新</button><button data-action="theme-rename" data-id="${esc(t.id)}">改名</button><button data-action="theme-delete" data-id="${esc(t.id)}">删除</button></div>`).join(''):'<p class="panel-description">还没有自定义主题。调好字号、行距和字体后，可以把它存成主题，以后一键套用。</p>';
  sheet('我的主题',`${rows}<div class="row" style="margin-top:18px"><input id="theme-name" maxlength="40" placeholder="主题名称，例如：我的小说排版" style="flex:1;min-width:0">${actionButton('theme-create','保存当前排版','plus','class="primary"')}</div><p class="panel-description">主题保存字体、字号、字重、行距、边距、对齐和出版排版。${bookProfileActive()?'当前在「仅此书」范围，应用主题只影响这本书。':'当前在「全局」范围，应用主题会影响默认排版。'}字体文件不会随 .moyue 备份携带，恢复后需重新导入。</p>`,{wide:true});
}
async function createThemeFromInput(){
  const name=($('#theme-name')?.value||'').trim();
  if(!name){toast('请先输入主题名称');return;}
  const list=themeList();if(list.length>=40){toast('主题数量已达上限');return;}
  list.push({id:crypto.randomUUID(),name,created:Date.now(),values:themeSnapshot()});
  saveThemes(list);showThemes();toast('已保存主题：'+name);
}
async function applyThemeById(id){
  const theme=themeList().find(t=>t.id===id);if(!theme)return;
  await applyThemeValues(theme.values);
  closeSheet();toast('已应用主题：'+theme.name);
}

/* ---------- 10 image and table zoom ---------- */
async function openImageViewer(src,alt=''){
  if(!src)return;
  closeImageViewer();state.speedSample=null;
  const root=document.createElement('div');root.className='image-viewer';root.setAttribute('role','dialog');root.setAttribute('aria-label','图片查看');
  root.innerHTML=`<div class="image-stage"><img alt="${esc(alt)}"></div><div class="image-bar"><span class="grow">${esc(alt||'图片')}</span><button data-zoom="fit">适应屏幕</button><button data-zoom="close" class="primary">关闭</button></div>`;
  document.body.append(root);state.imageViewer=root;
  const stage=root.querySelector('.image-stage'),img=root.querySelector('img');
  let scale=1,minScale=.6,tx=0,ty=0,pinch=null,drag=null;
  const apply=()=>{img.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;};
  const fit=()=>{const box=stage.getBoundingClientRect();const w=img.naturalWidth||1,h=img.naturalHeight||1;scale=Math.min(box.width/w,box.height/h,1);minScale=Math.min(scale,.9);tx=0;ty=0;apply();};
  img.addEventListener('load',fit,{once:true});
  img.addEventListener('error',()=>{stage.innerHTML='<p class="panel-description">这张图片无法显示，原文件可能已损坏。</p>';},{once:true});
  stage.addEventListener('wheel',event=>{event.preventDefault();scale=Math.max(minScale,Math.min(5,scale*(event.deltaY<0?1.1:.9)));apply();},{passive:false});
  stage.addEventListener('touchstart',event=>{
    if(event.touches.length===2){const[a,b]=event.touches;pinch={d:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),s:scale};}
    else if(event.touches.length===1){const t=event.touches[0];drag={x:t.clientX,y:t.clientY,tx,ty};}
  },{passive:true});
  stage.addEventListener('touchmove',event=>{
    if(pinch&&event.touches.length===2){event.preventDefault();const[a,b]=event.touches;const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);scale=Math.max(minScale,Math.min(5,pinch.s*d/pinch.d));apply();}
    else if(drag&&event.touches.length===1){event.preventDefault();const t=event.touches[0];tx=drag.tx+(t.clientX-drag.x);ty=drag.ty+(t.clientY-drag.y);apply();}
  },{passive:false});
  const endTouch=()=>{pinch=null;drag=null;};
  stage.addEventListener('touchend',endTouch);stage.addEventListener('touchcancel',endTouch);
  root.addEventListener('click',event=>{
    const action=event.target.closest('[data-zoom]')?.dataset.zoom;
    if(action==='close'||event.target===stage){closeImageViewer();return;}
    if(action==='fit'){fit();return;}
    event.stopPropagation();
  });
  const prepared=await budgetImage(src);if(state.imageViewer!==root)return;
  if(prepared.blocked)stage.innerHTML='<p class="panel-description">这张图片无法显示：尺寸过大或无法安全解码。原文件仍保留。</p>';else img.src=prepared.src;
}
function closeImageViewer(){const viewer=state.imageViewer;state.imageViewer=null;viewer?.querySelectorAll('img').forEach(img=>{img.removeAttribute('src');});viewer?.remove();}
function openTableZoom(table){
  if(!table)return;
  const clone=table.cloneNode(true);clone.removeAttribute('style');
  sheet('表格查看',`<div class="table-zoom">${clone.outerHTML}</div><p class="panel-description">可以左右拖动查看完整表格；关闭后回到原来的段落。</p>`,{wide:true,footer:actionButton('close-sheet','关闭','','class="primary"')});
}

/* ---------- 11 offline dictionary ---------- */
async function loadDictionaries(){state.dicts=await allDicts();if(state.tools)renderReaderTools();}
function dictSize(record){return (record.dictBlob?.size||record.dictBytes||0)+(record.idxBlob?.size||record.idxBytes||0)+(record.synBlob?.size||0);}
async function openDictionary(id){
  const record=state.dicts.find(d=>d.id===id);if(!record)throw Error('词典记录不存在');
  return{name:record.name,lookup:word=>dictionaryJob('lookup',{id,word})};
}
async function importDictionary(items){
  if(!items?.length)return;
  const groups=groupBundles(items.map(item=>item.name));
  if(!groups.length){toast('没有识别到 StarDict 文件（.ifo/.idx/.dict/.dict.dz）');return;}
  let added=0,lastError='';state.dictImporting=true;state.dictImportCancelled=false;
  sheet('正在处理词典','<p id="dict-import-status">正在后台校验和建立词典索引，页面仍可操作。</p>',{footer:actionButton('dict-import-cancel','取消','','class="outlined"')});
  try{
  for(const group of groups){
    if(state.dictImportCancelled)break;const status=$('#dict-import-status');if(status)status.textContent='正在后台处理：'+group.base;
    const pick=kind=>items.find(item=>item.name===group.files[kind]);
    const ifo=pick('ifo'),idx=pick('idx'),dict=pick('dict')||pick('dictdz'),syn=pick('syn');
    if(!ifo||!idx||!dict){lastError=`${group.base}：缺少 ${!ifo?'ifo':!idx?'idx':'dict/dict.dz'} 文件`;continue;}
    try{
      const ifoBuffer=await ifo.data();
      if(ifoBuffer.byteLength>1024*1024)throw Error('词典 ifo 元数据超过 1 MB');
      const meta=parseIfo(new TextDecoder().decode(ifoBuffer));
      const idxBuffer=await idx.data();
      if(meta.idxfilesize!==idxBuffer.byteLength)throw new Error('词典索引大小与 ifo 声明不符');
      const dictBuffer=await dict.data();
      const compressed=!group.files.dict&&!!group.files.dictdz;
      const synBuffer=syn?await syn.data():null;
      if(state.dictImportCancelled)break;
      await dictionaryJob('import',{meta,idxBuffer,dictBuffer,synBuffer,compressed},[idxBuffer,dictBuffer,...(synBuffer?[synBuffer]:[])]);added++;
    }catch(error){if(error.name==='AbortError')break;lastError=`${group.base}：${error.message}`;console.warn('Dictionary import',error);}
  }
  }finally{state.dictImporting=false;}
  await loadDictionaries();
  if(state.dictImportCancelled){toast(`已取消词典处理${added?'，已完成的 '+added+' 部保留':''}`);return;}
  if(added){toast(`已导入 ${added} 部词典`);if(overlays.querySelector('.sheet'))showDictionaryManager();}
  else sheet('词典未能导入',`<p class="error-detail">${esc(lastError||'所选文件不完整')}</p><p class="panel-description">需要同一名称的 .ifo、.idx 和 .dict 或 .dict.dz。.syn 可选，会被用于同义词查询；.idx.gz 暂不支持。</p>`,{footer:actionButton('close-sheet','知道了','','class="outlined"')});
}
function showDictionaryManager(){
  const list=state.dicts;
  const rows=list.length?list.map(d=>`<div class="dict-row"><div class="grow"><strong>${esc(d.name)}</strong><small>${d.wordcount} 条 · ${(dictSize(d)/1048576).toFixed(1)} MB · ${d.compressed?'dictzip':'未压缩'}${d.synBlob?' · 含同义词':''}</small></div><span class="dict-state">可用</span><button data-action="dict-remove" data-id="${esc(d.id)}">移除</button></div>`).join(''):'<p class="panel-description">还没有词典。导入 StarDict 词典后，长按选中文字即可查词。</p>';
  sheet('离线词典',`${rows}<div class="row" style="margin-top:18px">${actionButton('dict-import','导入 StarDict 词典','plus','class="primary"')}</div><p class="panel-description">需要同一名称的 .ifo、.idx 和 .dict 或 .dict.dz，可一次多选；.syn 可选。词条与查询全部在本机完成，不联网、不上传所选文字。删除词典不会删除书籍、笔记或生词本。</p>`,{wide:true});
}
async function lookupWord(word){
  const needle=String(word||'').trim();
  if(!needle)return null;
  if(!state.dicts?.length)return{results:[],reason:'empty'};
  const results=[],failures=[];
  for(const record of state.dicts){
    try{const dict=await openDictionary(record.id);for(const hit of await dict.lookup(needle))results.push({...hit,dictId:record.id,dictName:dict.name});}
    catch(error){console.warn('Dictionary lookup failed',error);failures.push(`「${record.name}」无法读取：${error.message}`);}
  }
  return{results,reason:results.length?'ok':failures.length?'broken':'miss',message:failures.join('；'),warnings:failures};
}
async function showLookup(word,context){
  const needle=String(word||'').trim();
  if(!needle)return;
  const lookup=state.lookup={word:needle,context:context||null,results:[]};
  sheet('查词',`<div class="lookup-word">${esc(needle)}</div><div id="lookup-body"><p class="panel-description">正在查询…</p></div>`,{wide:true,footer:actionButton('dict-manage','词典管理','settings','class="outlined"')});
  const outcome=await lookupWord(needle);
  if(state.lookup!==lookup||!overlays.querySelector('#lookup-body'))return;
  state.lookup.results=outcome.results;
  let body='';
  if(outcome.reason==='empty')body='<p class="panel-description">尚未安装离线词典。导入 StarDict 词典后即可查词，全程离线。</p>';
  else if(outcome.reason==='broken')body=`<p class="error-detail">${esc(outcome.message||'词典无法读取')}</p>`;
  else if(outcome.reason==='miss')body='<p class="panel-description">词典里没有这个词。可以换个词形，或检查词典是否收词。</p>';
  else body=outcome.results.map((hit,i)=>`<article class="lookup-entry"><h3>${esc(hit.word)} <small>${esc(hit.dictName)}</small></h3><div class="lookup-def">${esc(hit.definition)}</div></article>`).join('');
  const addButton=outcome.results.length?actionButton('vocab-add','加入生词本','plus','class="primary"'):(outcome.reason==='empty'?actionButton('dict-import','导入词典','plus','class="outlined"'):'');
  $('#lookup-body').innerHTML=body+(outcome.results.length&&outcome.warnings?.length?`<p class="panel-description">${esc(outcome.warnings.join('；'))}</p>`:'');
  const footer=overlays.querySelector('.sheet-footer');
  if(footer)footer.innerHTML=actionButton('close-sheet','关闭','','class="outlined"')+addButton;
  if(outcome.results.length&&context?.bookId&&localStorage.getItem('moyue-vocab-auto')==='1')await addVocabFromLookup();
}
async function importDictionaryFromInput(input){
  const files=[...input.files];input.value='';
  if(!files.length)return;
  await importDictionary(files.map(file=>({name:file.name,data:()=>file.arrayBuffer()})));
}

/* ---------- 14 vocabulary ---------- */
async function loadVocab(){state.vocab=await allVocab();}
function vocabContext(){const sel=state.selected;if(!sel)return null;const text=state.doc?.chapters?.[sel.chapter??state.chapter]?.text;const context=text&&Number.isFinite(sel.start)?text.slice(Math.max(0,sel.start-100),sel.end+100):(sel.text||'');const loc={...locator(),...(Number.isFinite(sel.start)?{chapter:sel.chapter??state.chapter,anchor:sel.start,quote:undefined}:{})};return{text:context.slice(0,2000),bookId:state.book?.id||'',bookTitle:state.book?.title||'',locator:loc};}
async function addVocabFromLookup(){
  const lookup=state.lookup;if(!lookup?.results.length)return;
  const lookupBody=$('#lookup-body');
  const top=lookup.results[0];
  const context=lookup.context||{};
  const key=`${context.bookId||''}|${context.locator?.chapter??''}|${context.locator?.anchor??''}|${lookup.word}`;
  const existing=state.vocab.find(v=>v.key===key)||state.vocab.find(v=>v.word===lookup.word&&v.bookId===(context.bookId||''));
  if(existing){toast('这个生词已经在生词本里了');return;}
  const record={id:crypto.randomUUID(),key,word:lookup.word,definition:top.definition.slice(0,8000),dictName:top.dictName,dictId:top.dictId,context:context.text||'',bookId:context.bookId||'',bookTitle:context.bookTitle||'',locator:context.locator||null,created:Date.now(),state:'new',reviews:[],due:0,streak:0,lastReview:0};
  await putVocabRecord(record);await loadVocab();toast('已加入生词本');if(state.lookup===lookup&&lookupBody&&$('#lookup-body')===lookupBody)showLookupFooterState();
}
function showLookupFooterState(){const footer=overlays.querySelector('.sheet-footer');if(footer&&!footer.querySelector('[data-action="vocab-added"]'))footer.insertAdjacentHTML('afterbegin','<span class="small muted" data-action="vocab-added">已加入生词本</span>');}
function showVocab(filter=state.vocabFilter||'all',query=state.vocabQuery||''){
  state.vocabFilter=filter;state.vocabQuery=query;
  const all=state.vocab||[];
  const needle=query.trim().toLowerCase();
  const list=all.filter(v=>{
    if(filter==='due'&&!isDue(v))return false;
    if(filter==='new'&&v.state!=='new')return false;
    if(filter==='known'&&v.state!=='known')return false;
    if(filter==='review'&&v.state!=='review')return false;
    if(filter==='book'&&v.bookId!==state.book?.id)return false;
    return !needle||v.word.toLowerCase().includes(needle)||(v.definition||'').toLowerCase().includes(needle);
  }).sort((a,b)=>(a.state==='known'?1:0)-(b.state==='known'?1:0)||b.created-a.created);
  const rows=list.length?list.map(v=>`<article class="vocab-row"><div class="grow"><strong>${esc(v.word)}</strong><small>${esc((v.definition||'').split('\n')[0].slice(0,60))} · ${esc(v.bookTitle||'未知来源')} · ${new Date(v.created).toLocaleDateString('zh-CN')}${v.due?' · 下次 '+new Date(v.due).toLocaleString('zh-CN'):''}</small></div><span class="vocab-state">${v.state==='known'?'已掌握':v.state==='review'?'需复习':'待学习'}</span><button data-action="vocab-jump" data-id="${esc(v.id)}">原文</button><button data-action="vocab-review" data-id="${esc(v.id)}">复习</button><button data-action="vocab-reset-one" data-id="${esc(v.id)}">重置</button><button data-action="vocab-remove" data-id="${esc(v.id)}">删除</button></article>`).join(''):'<p class="panel-description">还没有生词。查词后点「加入生词本」即可收集。</p>';
  const filters=[['all','全部'],['due','到期复习'],['new','待学习'],['review','需复习'],['known','已掌握'],['book','当前书']];
  const tabs=`<div class="sheet-tabs">${filters.map(([key,name])=>`<button data-action="vocab-filter" data-value="${key}" class="${filter===key?'active':''}">${name}</button>`).join('')}</div>`;
  const dueCount=all.filter(v=>isDue(v)).length;
  sheet('生词本',`<div class="row" style="margin-bottom:12px"><input id="vocab-search" type="search" placeholder="搜索词语或释义" value="${esc(query)}" style="flex:1;min-width:0">${actionButton('vocab-search','搜索','','class="outlined"')}</div><div class="setting-row"><label>查词后自动收录</label><button role="switch" aria-checked="${localStorage.getItem('moyue-vocab-auto')==='1'}" data-action="vocab-auto">${localStorage.getItem('moyue-vocab-auto')==='1'?'已开启':'已关闭'}</button></div><p class="panel-description">${dueCount} 个生词待复习。认识后按 1、3、7、14、30、60、120 天安排；需复习的词 10 分钟后再出现。不会发送系统通知。</p>${rows}`,{tabs,wide:true,footer:actionButton('vocab-reset','重置学习状态','','class="outlined"')+actionButton('vocab-cards','开始卡片复习','','class="primary"')});
}
function showVocabCard(){
  const pool=(state.vocab||[]).filter(v=>isDue(v)).sort((a,b)=>(a.due||0)-(b.due||0));
  if(!pool.length){toast('没有需要复习的生词');return;}
  state.cardQueue=pool.map(v=>v.id);state.cardIndex=0;renderVocabCard();
}
function renderVocabCard(){
  const queue=state.cardQueue||[];const id=queue[state.cardIndex];
  const item=(state.vocab||[]).find(v=>v.id===id);
  if(!item){closeSheet();toast('复习完成');return;}
  sheet('卡片复习',`<div class="card-word">${esc(item.word)}</div><div id="card-answer" class="card-answer" hidden>${esc(item.definition)}${item.context?`<p class="card-context">${esc(item.context)}</p>`:''}</div><p class="panel-description">第 ${state.cardIndex+1} / ${queue.length} 张</p>`,{footer:actionButton('card-show','显示释义','','class="primary"')});
}
async function reviewVocab(id,result){
  const item=(state.vocab||[]).find(v=>v.id===id);if(!item)return;
  state.reviewSaving||=new Set();if(state.reviewSaving.has(id))return;state.reviewSaving.add(id);
  const card=overlays.querySelector('.sheet'),queue=state.cardQueue;
  const before=structuredClone(item);Object.assign(item,reviewSchedule(item,result));
  try{await putVocabRecord(item);}catch(error){const index=state.vocab.indexOf(item);if(index>=0)state.vocab[index]=before;throw error;}finally{state.reviewSaving.delete(id);}
  toast((result==='known'?'已标记为认识':'已加入需复习')+'，下次 '+new Date(item.due).toLocaleString('zh-CN'));
  const footer=overlays.querySelector('.sheet-footer');
  if(footer&&overlays.querySelector('.sheet')===card&&state.cardQueue===queue&&$('#card-answer')){
    footer.innerHTML=actionButton('vocab-cards-next','下一张','','class="primary"');
  }
}

/* ---------- 32 adjust an existing highlight ---------- */
function noteById(bookId,id){return state.books.find(b=>b.id===bookId)?.notes.find(n=>n.id===id);}
function adjustPreview(note){state.adjustDraft={bookId:note.bookId,id:note.id,start:note.start,end:note.end};renderAdjust(note);}
function renderAdjust(note){
  const draft=state.adjustDraft;const text=state.doc?.chapters?.[note.chapter]?.text||note.text;
  const start=Math.max(0,Math.min(text.length-1,draft.start));
  const end=Math.max(start+1,Math.min(text.length,draft.end));
  draft.start=start;draft.end=end;
  const selected=text.slice(start,end);
  $('#adjust-preview').innerHTML=`<mark>${esc(selected)}</mark>`;
  $('#adjust-meta').textContent=`第 ${start+1}–${end} 字 · 共 ${end-start} 字`;
}
async function showAdjustRange(bookId,id){
  const note=noteById(bookId,id);if(!note)return;
  if(note.pdfPage!==undefined||note.rects){await showPdfAdjust(bookId,note);return;}
  if(bookId!==state.book?.id){toast('请先打开这本书再调整');return;}
  if(!sameTextView(note)){toast('请先切换到这条批注所在的正文或原版视图再调整');return;}
  const chapter=state.doc.chapters[note.chapter];
  if(!chapter){toast('找不到原章节，无法调整');return;}
  state.adjust={bookId,id,chapter:note.chapter};
  state.adjustDraft={bookId,id,start:note.start,end:note.end};
  sheet('调整划线范围',`<div id="adjust-preview" class="adjust-preview"></div><p class="small muted" id="adjust-meta"></p><div class="adjust-grid"><button data-action="adjust-start-back">起点 −1 字</button><button data-action="adjust-start-forward">起点 +1 字</button><button data-action="adjust-end-back">终点 −1 字</button><button data-action="adjust-end-forward">终点 +1 字</button><button data-action="adjust-start-sentence">起点扩到句首</button><button data-action="adjust-end-sentence">终点扩到句末</button></div><p class="panel-description">调整只改变这条批注覆盖的文字，笔记内容、创建时间和记录身份保持不变。取消不会修改原划线。</p>`,{footer:actionButton('close-sheet','取消','','class="outlined"')+actionButton('adjust-save','保存范围','','class="primary"')});
  renderAdjust(note);
}
async function saveAdjustRange(){
  if(state.pdfAdjust){await savePdfAdjust();return;}
  const draft=state.adjustDraft,bookId=state.adjust?.bookId;if(!draft||!bookId)return;
  if(state.book?.id!==bookId){toast('阅读中的书籍已改变，请重新打开批注');return;}
  const book=state.books.find(b=>b.id===bookId);const note=book?.notes.find(n=>n.id===draft.id);if(!note){closeSheet();return;}
  const before={start:note.start,end:note.end,text:note.text};
  const chapter=state.doc.chapters[note.chapter];
  const text=chapter.text.slice(draft.start,draft.end);
  if(draft.end-draft.start<1||!text.trim()){toast('选中的范围为空');return;}
  note.start=draft.start;note.end=draft.end;note.text=text;
  try{await putBook(book);}catch(error){Object.assign(note,before);reportError(error);toast('保存失败，已恢复原划线与范围');return;}
  closeSheet();
  if(state.route==='reader'&&state.book?.id===bookId){
    await displayChapter(state.chapter,state.book.locator.anchor);
  }
  toast('划线范围已更新');
}

/* ---------- 33 cross-page selection ---------- */
function pageOffsetFor(dir){
  const p=state.paginator;if(!p||!p.nodes.length)return null;
  const target=p.page+dir;if(target<0||target>=p.pages)return null;
  const boundary=dir>0?target+1:target;
  if(boundary>=p.pages)return p.length;
  let low=0,high=p.length;
  while(low<high){const mid=(low+high)>>1;if(p.pageAt(mid)<boundary)low=mid+1;else high=mid;}
  return low;
}
async function extendSelection(dir){
  if(state.busy||state.turning)return;
  if(state.book?.kind==='pdf'){await extendPdfSelection(dir);return;}
  const sel=state.selected;if(!sel||state.route!=='reader'||!state.book||state.book.kind==='pdf'){toast('跨页选择暂只支持文字书籍，且在同一章节内');return;}
  const chapter=state.doc.chapters[state.chapter];
  const text=chapter.text;
  let start=sel.start,end=sel.end;
  if(dir>0){
    const target=pageOffsetFor(1);
    if(target===null||target<=end){toast('已经是本章最后一页');return;}
    end=Math.min(text.length,target);
  }else{
    const target=pageOffsetFor(-1);
    if(target===null||target>=start){toast('已经是本章第一页');return;}
    start=Math.max(0,target);
  }
  state.selected={...sel,start,end,text:text.slice(start,end)};
  state.paginator.preview(start,end);
  await turn(dir,{preserveSelection:true});
  showSelectionTools();
  toast(`已选 ${end-start} 字`);
}
/** Programmatic selection used by cross-page extension and by the regression tests. */
function selectRange(start,end){
  const chapter=state.doc?.chapters?.[state.chapter];if(!chapter)return;
  const from=Math.max(0,Math.min(chapter.text.length-1,start)),to=Math.max(from+1,Math.min(chapter.text.length,end));
  state.selected={start:from,end:to,text:chapter.text.slice(from,to),chapter:state.chapter,...(state.book.originalLayout?{view:'original'}:{})};
  state.paginator?.preview(from,to);
  showSelectionTools();
}
function showSelectionTools(){
  $('.selection-tools')?.remove();
  const canExtend=state.route==='reader';
  const tools=document.createElement('div');tools.className='selection-tools';
  tools.innerHTML=actionButton('highlight','划线')+actionButton('annotate','笔记')+actionButton('lookup-selection','查词')+(canExtend?actionButton('extend-forward','扩到下一页')+actionButton('extend-back','扩到上一页'):'')+actionButton('copy-selection','复制')+actionButton('cancel-selection','取消');
  document.body.append(tools);
}

/* ---------- 34 search notes and highlights ---------- */
function noteMatches(note,needle){const n=needle.toLowerCase();return (note.text||'').toLowerCase().includes(n)||(note.note||'').toLowerCase().includes(n);}
function highlightMatch(value,needle){const text=esc(value||'');if(!needle)return text;try{return text.replace(new RegExp('('+needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<b>$1</b>');}catch{return text;}}
function noteSearchResults(books,needle){const out=[];for(const book of books){for(const n of book.notes||[]){if(needle&&!noteMatches(n,needle))continue;out.push({book,note:n});}}return out;}
function showNoteSearch(scope='book'){
  state.noteSearchScope=scope;
  const tabs=`<div class="sheet-tabs"><button data-action="note-search-scope" data-value="book" class="${scope==='book'?'active':''}">本书</button><button data-action="note-search-scope" data-value="all" class="${scope==='all'?'active':''}">全部书籍</button></div>`;
  sheet('搜索批注',`<div class="row"><input id="note-search-input" type="search" placeholder="搜索摘录或笔记内容" value="${esc(state.noteQuery||'')}" style="flex:1;min-width:0">${actionButton('note-search-run','搜索','','class="outlined"')}</div><div id="note-search-results" class="search-results"></div>`,{tabs,wide:true});
  setTimeout(()=>$('#note-search-input')?.focus(),50);
  runNoteSearch();
}
function runNoteSearch(){
  const query=($('#note-search-input')?.value||'').trim();
  state.noteQuery=query;
  const books=state.noteSearchScope==='all'?state.books:[state.book].filter(Boolean);
  const root=$('#note-search-results');if(!root)return;
  if(!query){root.innerHTML='<p class="panel-description">输入关键词，搜索摘录和笔记内容。</p>';return;}
  const hits=noteSearchResults(books,query);
  if(!hits.length){root.innerHTML='<p class="panel-description">没有匹配的批注。';return;}
  root.innerHTML=`<p class="panel-description">找到 ${hits.length} 条</p>`+hits.slice(0,200).map(hit=>{
    const n=hit.note;
    return `<button class="search-result" data-action="note-result" data-book="${esc(hit.book.id)}" data-id="${esc(n.id)}"><small>${esc(hit.book.title)}${n.pdfPage!==undefined?' · 第 '+(n.pdfPage+1)+' 页':''}</small>${highlightMatch(n.text,query)}${n.note?`<span class="note-inline">${highlightMatch(n.note,query)}</span>`:''}</button>`;
  }).join('');
}

/* ---------- 39 search every book ---------- */
function invalidateLibrarySearch(id){
  state.librarySearchAbort?.abort();
  clearSearchMemory(id);
  if(id)state.libraryIndex?.delete(id);else state.libraryIndex=null;
  state.libraryResults=null;state.libraryReturn=null;state.librarySkipped=[];
}
function showLibrarySearch(){
  sheet('搜索书库正文',`<div class="row"><input id="library-fulltext" type="search" maxlength="200" placeholder="输入关键词，搜索所有书籍正文" value="${esc(state.libraryQuery||'')}" style="flex:1;min-width:0">${actionButton('library-search-run','搜索','','class="outlined"')}${actionButton('library-search-cancel','取消','close','class="outlined"')}</div><div id="library-search-status" class="panel-description">搜索正文和 PDF 文字层。首次逐本建立索引，重启后仍能复用；扫描图片需要先做 OCR。</div><div id="library-search-results" class="search-results"></div><p class="panel-description">搜索缓存最多占用 64 MB，可随时清理，不影响原书。</p>${actionButton('library-index-clear','清理搜索缓存','','class="outlined"')}`,{wide:true});
  if(state.libraryQuery&&state.libraryResults?.length)renderLibraryResults();
  setTimeout(()=>$('#library-fulltext')?.focus(),50);
}
function renderLibraryResults(){
  const root=$('#library-search-results');if(!root)return;
  const results=state.libraryResults||[];
  if(!results.length){root.innerHTML='<p class="panel-description">没有找到匹配的正文。';return;}
  const grouped=new Map();
  for(const hit of results){if(!grouped.has(hit.bookId))grouped.set(hit.bookId,{title:hit.bookTitle,hits:[]});grouped.get(hit.bookId).hits.push(hit);}
  root.innerHTML=[...grouped.values()].map(group=>`<h3 class="result-book">${esc(group.title)}<small>${group.hits.length} 处</small></h3>`+group.hits.map(hit=>`<button class="search-result" data-action="library-result" data-book="${esc(hit.bookId)}" data-chapter="${hit.chapter??0}" data-pdf-page="${hit.pdfPage??''}" data-anchor="${hit.anchor}"><small>${esc(hit.chapterTitle)}</small>${highlightMatch(hit.snippet,hit.query)}</button>`).join('')).join('');
}
async function runLibrarySearch(){
  const query=($('#library-fulltext')?.value||'').trim();
  if(!query){toast('请输入关键词');return;}
  state.libraryQuery=query;state.libraryResults=[];
  const status=$('#library-search-status'),root=$('#library-search-results');
  const controller=new AbortController();state.librarySearchAbort?.abort();state.librarySearchAbort=controller;
  if(status)status.textContent='正在准备索引…';
  try{const {results,skipped}=await searchLibrary([...state.books],query,{signal:controller.signal,onStatus:message=>{if(status?.isConnected&&!controller.signal.aborted)status.textContent=message;}});if(controller.signal.aborted)return;state.libraryResults=results;state.librarySkipped=skipped;if(status?.isConnected)status.textContent=librarySearchStatus();if(root?.isConnected)renderLibraryResults();}
  catch(error){if(error.name!=='AbortError'&&status?.isConnected)status.textContent='搜索未完成：'+error.message;}
}
function librarySearchStatus(){const results=state.libraryResults||[],skipped=state.librarySkipped||[];return (results.length?`找到 ${results.length}${results.length>=300?' 处以上':' 处'}`:'没有找到匹配的正文')+(skipped.length?`；${skipped.length} 本书未索引（${skipped.slice(0,3).join('、')}${skipped.length>3?' 等':''}）`:'');}
async function openLibraryResult(button){
  const bookId=button.dataset.book,chapter=Number(button.dataset.chapter),anchor=Number(button.dataset.anchor);
  state.libraryReturn={query:state.libraryQuery,results:state.libraryResults,skipped:state.librarySkipped};
  closeSheet();
  const ok=await openBook(bookId);if(!ok)return;
  if(button.dataset.pdfPage!==undefined&&button.dataset.pdfPage!==''){
    const page=Number(button.dataset.pdfPage);await jump({pdfPage:page});
    try{const pdf=state.pdf,generation=readerGeneration,m=await pdfPageModel(pdf,page),at=m.text.toLowerCase().indexOf(state.libraryQuery.toLowerCase());if(at>=0&&generation===readerGeneration){state.pdfSearchPreview=m.range(at,at+state.libraryQuery.length);restorePdfHighlights();}}catch{};
  }else{await jump({chapter,anchor,view:'text'});state.paginator?.preview?.(anchor,anchor+(state.libraryQuery||'').length);}
}

/* ---------- PDF ranges use one logical annotation with normalized per-page fragments ---------- */
async function pdfModel(d,page){
  if(d.models.has(page)){const m=d.models.get(page);d.models.delete(page);d.models.set(page,m);return m;}
  const model=await pdfPageModel(d.pdf,page);if(state.book?.id!==d.bookId||state.pdf!==d.pdf)throw new DOMException('已离开这份 PDF','AbortError');
  d.models.set(page,model);while(d.models.size>3)d.models.delete(d.models.keys().next().value);return model;
}
function combinePdfFragments(parts){const sorted=parts.slice().sort((a,b)=>a.pdfPage-b.pdfPage);return{...sorted[0],fragments:sorted,text:sorted.map(p=>p.text).join('\n')};}
async function extendPdfSelection(dir){
  const sel=state.selected;if(!sel)return;const generation=readerGeneration,parts=structuredClone(fragmentsOf(sel));if(!parts.length)return;
  if(parts.length>=50){toast('一条划线最多跨 50 页，请分段批注');return;}
  const edge=dir>0?parts.at(-1):parts[0],page=edge.pdfPage+dir;
  if(page<0||page>=state.book.pages){toast('已到文档边界');return;}
  const d={bookId:state.book.id,pdf:state.pdf,models:new Map()};state.busy=true;
  try{
    const original=await pdfModel(d,edge.pdfPage),located=locateFragment(original,edge),next=await pdfModel(d,page);
    const current=original.range(dir>0?located.start:0,dir>0?original.text.length:located.end),added=next.range(0,next.text.length);
    if(dir>0){parts[parts.length-1]=current;parts.push(added);}else{parts[0]=current;parts.unshift(added);}
    const combined=combinePdfFragments(parts);if(combined.text.length>1000000)throw Error('划线文字过多，请分段保存');
    if(generation!==readerGeneration)return;state.selected={...combined,extended:true};window.getSelection()?.removeAllRanges();
    state.busy=false;await paperTurn(async()=>{state.pdfPage=page;state.pdfColumnIndex=0;await displayPdf();});showSelectionTools();toast(`已跨 ${parts.length} 页选择 ${combined.text.length} 字`);
  }catch(error){if(error.name!=='AbortError')toast('跨页选择未完成：'+error.message);}finally{if(generation===readerGeneration)state.busy=false;}
}
async function showPdfAdjust(bookId,note){
  if(state.book?.id!==bookId){if(!await openBook(bookId))return;}
  const pdf=state.pdf;sheet('正在读取划线文字','<p>正在读取文字层，可随时关闭，原批注尚未改变。</p>');const root=overlays.firstChild;
  const d={id:note.id,bookId,pdf,models:new Map(),fragments:structuredClone(fragmentsOf(note)),busy:false};
  try{for(const i of new Set([0,d.fragments.length-1])){const f=d.fragments[i],m=await pdfModel(d,f.pdfPage),loc=locateFragment(m,f);d.fragments[i]=m.range(loc.start,loc.end);}if(overlays.firstChild!==root)return;state.pdfAdjust=d;renderPdfAdjust();}
  catch(error){if(overlays.firstChild===root)sheet('无法读取这条划线的文字',`<p>${esc(error.message)}</p><p>原批注没有改变。扫描页需先有文字层。</p>`,{footer:actionButton('close-sheet','关闭','','class="outlined"')});}
}
function renderPdfAdjust(){
  const d=state.pdfAdjust;if(!d)return;const parts=d.fragments,first=parts[0],last=parts.at(-1);
  sheet('调整 PDF 划线范围',`<p>第 ${first.pdfPage+1} 页第 ${first.start+1} 字 → 第 ${last.pdfPage+1} 页第 ${last.end} 字</p><div class="adjust-preview"><mark>${esc(parts.map(f=>f.text).join('\n'))}</mark></div><div class="adjust-grid"><button data-action="adjust-start-back">起点 −1 字</button><button data-action="adjust-start-forward">起点 +1 字</button><button data-action="adjust-end-back">终点 −1 字</button><button data-action="adjust-end-forward">终点 +1 字</button><button data-action="adjust-start-sentence">起点扩到句首</button><button data-action="adjust-end-sentence">终点扩到句末</button><button data-action="pdf-adjust-page" data-edge="start" data-dir="-1">增加前一页</button><button data-action="pdf-adjust-page" data-edge="end" data-dir="1">增加后一页</button><button data-action="pdf-adjust-page" data-edge="start" data-dir="1" ${parts.length<2?'disabled':''}>移除起始页</button><button data-action="pdf-adjust-page" data-edge="end" data-dir="-1" ${parts.length<2?'disabled':''}>移除结束页</button></div><p class="panel-description">范围预览与原文同步。保存保留笔记内容，取消恢复原划线。</p>`,{wide:true,footer:actionButton('close-sheet','取消','','class="outlined"')+actionButton('adjust-save','保存范围','','class="primary"')});restorePdfHighlights();
}
async function nudgePdfAdjust(which,delta,sentence=false){
  const d=state.pdfAdjust;if(!d||d.busy)return;d.busy=true;
  try{const i=which==='start'?0:d.fragments.length-1,f=d.fragments[i],m=await pdfModel(d,f.pdfPage);if(state.pdfAdjust!==d)return;let start=f.start,end=f.end,at=which==='start'?start:end;
    if(sentence){const stops='。！？；.!?;\n';if(delta<0){while(at>0&&!stops.includes(m.text[at-1]))at--;}else{while(at<m.text.length&&!stops.includes(m.text[at]))at++;if(at<m.text.length)at++;}}
    else{if(delta>0)at+=m.text.codePointAt(at)>65535?2:1;else{at--;if(at>0&&/[\uDC00-\uDFFF]/.test(m.text[at]))at--;}}
    if(which==='start')start=Math.max(0,Math.min(end-1,at));else end=Math.max(start+1,Math.min(m.text.length,at));d.fragments[i]=m.range(start,end);renderPdfAdjust();
  }catch(e){toast(e.message);}finally{d.busy=false;}
}
async function adjustPdfPage(edge,dir){
  const d=state.pdfAdjust;if(!d||d.busy)return;const remove=edge==='start'?dir>0:dir<0;if(remove){if(d.fragments.length<2)return;edge==='start'?d.fragments.shift():d.fragments.pop();renderPdfAdjust();return;}
  if(d.fragments.length>=50){toast('最多选择 50 页');return;}const page=(edge==='start'?d.fragments[0]:d.fragments.at(-1)).pdfPage+dir;if(page<0||page>=state.book.pages){toast('已到文档边界');return;}
  d.busy=true;try{const m=await pdfModel(d,page);if(state.pdfAdjust!==d)return;const part=m.range(0,m.text.length);edge==='start'?d.fragments.unshift(part):d.fragments.push(part);renderPdfAdjust();}catch(e){toast(e.message);}finally{d.busy=false;}
}
async function savePdfAdjust(){
  const d=state.pdfAdjust;if(!d||d.busy||state.book?.id!==d.bookId)return;d.busy=true;const book=state.book,index=book.notes.findIndex(n=>n.id===d.id),before=index<0?null:structuredClone(book.notes[index]);if(!before)return;
  try{const parts=[];for(const part of d.fragments){const m=await pdfModel(d,part.pdfPage);parts.push(m.resolve?await m.resolve(part.start,part.end):part);}if(state.pdfAdjust!==d)return;const combined=combinePdfFragments(parts);if(!combined.text.trim())throw Error('选区没有可用文字');if(combined.text.length>1000000)throw Error('划线文字过多，请分段保存');book.notes[index]={...before,...combined};await putBook(book);closeSheet();restorePdfHighlights();toast('PDF 划线范围已更新');}
  catch(error){book.notes[index]=before;state.pdfAdjust=null;restorePdfHighlights();if(error.name==='LibraryWriteError')reportError(error);else sheet('范围未能保存',`<p>${esc(error.message)}</p>`,{footer:actionButton('close-sheet','关闭','','class="outlined"')});}finally{d.busy=false;}
}
/* ---------- helpers shared by the reading panels ---------- */
async function removeDictionary(id){
  const record=state.dicts.find(d=>d.id===id);if(!record)return;
  state.dictCache.delete(id);
  await dictionaryJob('release',{});
  await deleteDictRecord(id);await loadDictionaries();
  showVocabularyAfterDictionaryChange();
  toast('已移除词典：'+record.name);
}
function showVocabularyAfterDictionaryChange(){
  if(overlays.querySelector('.sheet'))showDictionaryManager();
}
function showVocabCardFor(id){
  const item=state.vocab.find(v=>v.id===id);if(!item)return;
  state.cardQueue=[id];state.cardIndex=0;renderVocabCard();
}
async function jumpToVocab(id){
  const item=state.vocab.find(v=>v.id===id);if(!item)return;
  if(!item.bookId||!state.books.some(b=>b.id===item.bookId)){toast('来源书籍已被删除，无法回到原句');return;}
  closeSheet();
  if(state.book?.id!==item.bookId){if(!await openBook(item.bookId))return;}
  if(item.locator)await jump(item.locator);
  else toast('这条生词没有可用的原文位置');
}
function confirmRemoveVocab(id){
  const item=state.vocab.find(v=>v.id===id);if(!item)return;
  state.pendingVocab=id;
  sheet('删除这个生词？',`<div class="note-quote">${esc(item.word)}</div><p class="panel-description">删除后它的释义、原句和学习状态都会移除，无法撤销。删除词典不会影响这条记录。</p>`,{footer:actionButton('close-sheet','取消','','class="outlined"')+actionButton('confirm-vocab-remove','删除','trash','class="primary"')});
}
async function removeVocab(id){
  const target=state.pendingVocab||id;state.pendingVocab=null;
  await deleteVocabRecord(target);await loadVocab();
  if(state.cardQueue)state.cardQueue=state.cardQueue.filter(x=>x!==target);
  toast('已删除生词');showVocab(state.vocabFilter,state.vocabQuery);
}
async function adjustNudge(which,delta){
  if(state.pdfAdjust){await nudgePdfAdjust(which,delta);return;}
  const draft=state.adjustDraft;if(!draft)return;
  const text=state.doc?.chapters?.[state.adjust?.chapter]?.text||'',at=draft[which];
  let next=at+delta;
  if(delta>0&&text.codePointAt(at)>0xffff)next++;
  if(delta<0&&at>1&&/[\uDC00-\uDFFF]/.test(text[at-1])&&/[\uD800-\uDBFF]/.test(text[at-2]))next--;
  draft[which]=Math.max(0,next);
  const note=noteById(draft.bookId,draft.id);if(note)renderAdjust(note);
}
function adjustSentence(which){
  if(state.pdfAdjust){nudgePdfAdjust(which,which==='start'?-1:1,true);return;}
  const draft=state.adjustDraft,adjust=state.adjust;if(!draft||!adjust)return;
  const text=state.doc.chapters[adjust.chapter].text;
  const stops='。！？；…\n';
  if(which==='start'){
    let at=draft.start;
    while(at>0&&!stops.includes(text[at-1]))at--;
    draft.start=at;
  }else{
    let at=draft.end;
    while(at<text.length&&!stops.includes(text[at]))at++;
    if(at<text.length)at++;
    draft.end=at;
  }
  const note=noteById(draft.bookId,draft.id);if(note)renderAdjust(note);
}
async function openNoteResult(button){
  const bookId=button.dataset.book,id=button.dataset.id;
  const book=state.books.find(b=>b.id===bookId);if(!book)return;
  const note=book.notes.find(n=>n.id===id);if(!note){toast('这条批注已不存在');return;}
  state.noteSearchReturn={query:state.noteQuery,scope:state.noteSearchScope};
  closeSheet();
  if(state.book?.id!==bookId){if(!await openBook(bookId))return;}
  await jump(note.pdfPage!==undefined?{pdfPage:note.pdfPage}:{chapter:note.chapter,anchor:note.start,view:note.view||'text'});
}


// Also supports browser regression testing of exactly the packaged UI, without a separate demo.
window.NativeEvents=(type,value)=>{
  if(type==='pdf')nativePdfResult(value);
  else if(type==='files')importBatch(value);
  else if(type==='dictfiles')importDictionary((value||[]).map(item=>({name:item.name,data:async()=>{const response=await fetch(item.url);if(!response.ok)throw new Error('词典临时文件无法读取');return response.arrayBuffer();}}))).catch(reportError).finally(()=>{for(const item of value||[])if(item.token)window.Android?.releaseImport?.(item.token);});
  else if(type==='font')adoptFont(value).catch(reportError);
  else if(type==='error'||type==='saved')toast(value);
  else if(type==='back')back();
  else if(type==='key'&&settings.volume&&state.route==='reader')turn(value==='next'?1:-1).catch(reportError);
};
window.ReaderApp={flush,state,get settings(){return settings;},importBatch,openBook,turn,jump,requestReflow,createBackup:()=>createBackup(globalSettings,{themes:themeList(),vocab:state.vocab||[],vocabAuto:localStorage.getItem('moyue-vocab-auto')==='1'}),restoreLibrary,importDictionary,lookupWord,showLookup,addVocabFromLookup,showVocab,runLibrarySearch,showLibrarySearch,themeList,saveThemes,createThemeFromInput,applyThemeById,showThemes:()=>showThemes(),openImageViewer,selectRange,extendSelection,searchMemoryBytes,clearSearchCache,pdfPageModel:page=>pdfPageModel(state.pdf,page)};
async function boot(){
  state.books=await allBooks();await restoreCustomFont();applySettings();
  loadDictionaries().catch(error=>console.warn('Dictionary load',error));loadVocab().catch(error=>console.warn('Vocabulary load',error));
  if(!localStorage.getItem('moyue-seeded')){
    try{const samples=await(await fetch('./samples/index.json')).json();for(const file of samples){const bytes=new Uint8Array(await(await fetch('./samples/'+file)).arrayBuffer());await importOne(file,bytes,{sample:true});}localStorage.setItem('moyue-seeded','1');}catch(e){console.error('Sample import:',e);}
  }
  const current=localStorage.getItem('moyue-current'),interrupted=localStorage.getItem('moyue-opening');
  if(!rendererRecovery&&!interrupted&&localStorage.getItem('moyue-route')==='reader'&&state.books.some(b=>b.id===current&&!b.openFailure))await openBook(current);
  else{clearOpening();renderLibrary('library');if(rendererRecovery)toast('阅读进程已恢复，已返回书库。原文件与已保存记录仍保留。');else if(interrupted)toast('上次打开未完成，已返回书库，可重新选择文件');}
  window.Android?.ready();navigator.storage?.persist?.().catch(()=>{});
  if(state.route!=='reader')setTimeout(()=>libraryCovers().catch(console.warn),600);
  if(navigator.getBattery)navigator.getBattery().then(b=>{state.battery=Math.round(b.level*100);b.addEventListener('levelchange',()=>state.battery=Math.round(b.level*100));}).catch(()=>{});
  setInterval(()=>document.querySelectorAll('[data-clock]').forEach(n=>n.textContent=time()),30000);
}
boot().catch(error=>{app.innerHTML='<div class="empty-state"><h2>无法打开本地书库</h2><p>请检查设备剩余空间，并确保 Android System WebView 已更新。</p></div>';reportError(error);window.Android?.ready();});
