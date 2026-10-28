import {get,putSearchUnit,putSearchMetadata,indexMetadata,dropSearchIndex} from './storage.js';
import {openPdfDocument} from './pdf-open.js';
const VERSION=2,UNIT=32768,DISK_BUDGET=64*1024*1024,MEMORY_BUDGET=2*1024*1024;
const cache=new Map();let cacheBytes=0;
const unitId=(id,i)=>id+':'+String(i).padStart(8,'0');
const abort=signal=>{if(signal?.aborted)throw new DOMException('搜索已取消','AbortError');};
const tick=()=>new Promise(r=>setTimeout(r,0));
function remember(unit){const bytes=unit.text.length*2;if(bytes>MEMORY_BUDGET)return;const old=cache.get(unit.id);if(old)cacheBytes-=old.text.length*2;cache.delete(unit.id);cache.set(unit.id,unit);cacheBytes+=bytes;while(cacheBytes>MEMORY_BUDGET){const key=cache.keys().next().value;cacheBytes-=cache.get(key).text.length*2;cache.delete(key);}}
export function clearSearchMemory(id){for(const [key,u]of cache)if(!id||u.bookId===id){cacheBytes-=u.text.length*2;cache.delete(key);}}
export function searchMemoryBytes(){return cacheBytes;}
export async function clearSearchCache(){clearSearchMemory();await dropSearchIndex();}
async function unitAt(id,i){const key=unitId(id,i),hit=cache.get(key);if(hit){cache.delete(key);cache.set(key,hit);return hit;}const u=await get('searchUnits',key);if(u)remember(u);return u;}
async function* sourceUnits(book,signal,status){
 if(book.kind==='pdf'){
  const original=await get('originals',book.id);if(!original?.blob)throw Error('原 PDF 副本缺失');abort(signal);
  let pdf;
  try{pdf=await openPdfDocument(new Uint8Array(await original.blob.arrayBuffer()),{preferNative:book.pdfMode==='native',signal,bytesLoader:async()=>new Uint8Array(await original.blob.arrayBuffer())});
   for(let page=0;page<pdf.numPages;page++){abort(signal);status(`正在读取《${book.title}》第 ${page+1} / ${pdf.numPages} 页`);let text='',failed=false,p;
    try{p=await pdf.getPage(page+1);const c=await p.getTextContent();text=c.items.map(i=>i.str||'').join(' ');failed=!!pdf.textUnavailable&&!text;}catch(e){if(signal?.aborted)throw e;failed=true;}finally{p?.cleanup?.();}
    for(let offset=0;offset<Math.max(1,text.length);offset+=UNIT)yield{title:`第 ${page+1} 页`,pdfPage:page,anchor:offset,text:text.slice(offset,offset+UNIT+256),failed};
    await tick();
   }
  }finally{await pdf?.destroy();}
 }else{
  const doc=await get('documents',book.id);if(!doc?.chapters)throw Error('正文副本缺失');
  for(const [chapter,c]of doc.chapters.entries()){const text=c.text||'';for(let offset=0;offset<Math.max(1,text.length);offset+=UNIT){abort(signal);yield{title:c.title,chapter,anchor:offset,text:text.slice(offset,offset+UNIT+256)};await tick();}}
 }
}
export async function searchLibrary(books,query,{signal,onStatus=()=>{}}={}){
 const results=[],skipped=[],searchable=new Set(),needle=query.toLowerCase();if(query.length>200)throw Error('关键词请控制在 200 字以内');
 let allMeta=await indexMetadata();const known=new Set(books.map(b=>b.id));for(const m of allMeta)if(!known.has(m.id))await dropSearchIndex(m.id);
 let disk=allMeta.filter(m=>known.has(m.id)).reduce((n,m)=>n+(m.bytes||0),0);
 const scan=(unit,book)=>{if(unit.failed){if(!skipped.includes(book.title))skipped.push(book.title);return;}const text=unit.text,lower=text.toLowerCase();if(text.trim())searchable.add(book.id);let from=0;
  while(results.length<300){const at=lower.indexOf(needle,from);if(at<0||at>=UNIT)break;results.push({bookId:book.id,bookTitle:book.title,chapter:unit.chapter,chapterTitle:unit.title,pdfPage:unit.pdfPage,anchor:unit.anchor+at,snippet:text.slice(Math.max(0,at-30),at+query.length+50).replace(/\n/g,' '),query});from=at+Math.max(1,query.length);}
 };
 for(const [number,book]of books.entries()){
  abort(signal);onStatus(`正在搜索 ${number+1} / ${books.length}：《${book.title}》`);
  let meta=await get('searchMeta',book.id);
  try{
   if(meta?.version!==VERSION||meta?.failed||book.kind==='pdf'&&meta?.sourceMode!==(book.pdfMode||'auto')){await dropSearchIndex(book.id);clearSearchMemory(book.id);disk-=meta?.bytes||0;meta=null;}
   let reusable=!!meta?.complete;
   if(reusable){for(let i=0;i<meta.count;i++){abort(signal);const u=await unitAt(book.id,i);if(!u){reusable=false;while(results.at(-1)?.bookId===book.id)results.pop();await dropSearchIndex(book.id);clearSearchMemory(book.id);disk-=meta.bytes||0;meta=null;break;}scan(u,book);if(results.length>=300)break;await tick();}if(reusable)await putSearchMetadata({...meta,used:Date.now()});}
   if(!reusable){
    // Incomplete jobs can resume from persisted units; extraction remains sequential and cancellable.
    const saved=meta?.count||0;let i=0,bytes=0,transient=false,failed=false;
    for await(const raw of sourceUnits(book,signal,onStatus)){abort(signal);const unit={...raw,id:unitId(book.id,i),bookId:book.id};let existing=i<saved?await unitAt(book.id,i):null;const chosen=existing||unit;failed||=!!chosen.failed;scan(chosen,book);bytes+=chosen.text.length*2;
     if(!transient&&!existing){
      const added=chosen.text.length*2;
      if(disk+added>DISK_BUDGET){const victims=(await indexMetadata()).filter(m=>m.id!==book.id).sort((a,b)=>(a.used||0)-(b.used||0));for(const victim of victims){await dropSearchIndex(victim.id);clearSearchMemory(victim.id);disk-=victim.bytes||0;if(disk+added<=DISK_BUDGET)break;}}
      if(bytes>DISK_BUDGET){await dropSearchIndex(book.id);clearSearchMemory(book.id);disk-=meta?.bytes||0;transient=true;onStatus('正文超过缓存上限，继续直接搜索，不影响结果');}
      else{meta={id:book.id,version:VERSION,sourceMode:book.pdfMode||'auto',count:i+1,bytes,complete:false,failed,used:Date.now()};await putSearchUnit(chosen,meta);remember(chosen);disk+=added;}
     }
     i++;await tick();if(results.length>=300)break;
    }
    if(!transient&&meta&&results.length<300)await putSearchMetadata({...meta,complete:!failed,failed,used:Date.now()});
   }
  }catch(error){abort(signal);console.warn('Library index skipped',book.title,error);if(!skipped.includes(book.title))skipped.push(book.title);}
  if(!searchable.has(book.id)&&!skipped.includes(book.title))skipped.push(book.title);
  if(results.length>=300)break;await tick();
 }
 abort(signal);return{results,skipped,truncated:results.length>=300};
}
