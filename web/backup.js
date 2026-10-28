import {normalizeSettings,bookKeys} from './settings.js';
import { allBooks, get, restoreBooks } from './storage.js';
import { parseFile } from './formats.js';

const magic='MOYUE-BACKUP-1\n',limit=1024*1024*1024;
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function createBackup(settings,extras={},onProgress=()=>{}){
  const books=await allBooks(),parts=[],entries=[];let offset=0;
  for(const [index,book] of books.entries()){
    const original=await get('originals',book.id);if(!original?.blob)throw new Error('原文件副本缺失：'+book.title);
    if(await digest(await original.blob.arrayBuffer())!==book.id)throw new Error('原文件副本校验失败，请重新导入后再备份：'+book.title);
    entries.push({book,offset,size:original.blob.size});parts.push(original.blob);offset+=original.blob.size;
    if(offset>limit)throw new Error('书库超过 1 GB，请分批整理后备份');onProgress(index+1,books.length);
  }
  const manifest=new TextEncoder().encode(JSON.stringify({format:1,created:Date.now(),settings,themes:extras.themes||[],vocab:extras.vocab||[],vocabAuto:extras.vocabAuto===true,entries}));
  if(manifest.length>8*1024*1024)throw new Error('书库记录过大');
  return new Blob([magic,String(manifest.length).padStart(10,'0')+'\n',manifest,...parts],{type:'application/octet-stream'});
}
export async function restoreBackup(blob,onProgress=()=>{}){
  if(blob.size>limit+9*1024*1024)throw new Error('备份超过 1 GB');
  const header=await blob.slice(0,magic.length+11).text();if(!header.startsWith(magic)||!/^\d{10}\n$/.test(header.slice(magic.length)))throw new Error('不是墨阅书库备份');
  const length=Number(header.slice(magic.length,magic.length+10)),base=magic.length+11+length;
  if(length>8*1024*1024||base>blob.size)throw new Error('备份索引无效');
  const data=JSON.parse(await blob.slice(magic.length+11,base).text());
  if(data.format!==1||!Array.isArray(data.entries)||data.entries.length>10000)throw new Error('不支持此备份版本');
  const records=[],ids=new Set();let expectedOffset=0;
  for(const [i,entry] of data.entries.entries()){
    const b=entry.book;
    if(!b||!/^[a-f0-9]{64}$/.test(b.id)||ids.has(b.id)||entry.offset!==expectedOffset||!Number.isSafeInteger(entry.size)||entry.size<=0||entry.size>100*1024*1024||base+entry.offset+entry.size>blob.size||typeof b.filename!=='string'||!Array.isArray(b.notes)||!Array.isArray(b.bookmarks))throw new Error('备份书籍索引无效');
    const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
    if(typeof b.title!=='string'||typeof b.author!=='string'||b.title.length>1000||b.author.length>1000||b.filename.length>1000||!Array.isArray(b.collections)||b.collections.some(c=>typeof c!=='string'||c.length>200)||b.notes.length>100000||b.bookmarks.length>100000)throw new Error('备份书籍记录无效');
    const validIndex=n=>Number.isSafeInteger(n)&&n>=0&&n<=10000000;
    const validLocator=loc=>loc&&typeof loc==='object'&&['chapter','anchor','pdfPage'].every(k=>loc[k]===undefined||validIndex(loc[k]))&&[undefined,'text','original'].includes(loc.view)
      &&(loc.path===undefined||(typeof loc.path==='string'&&loc.path.length<=400))
      &&(loc.quote===undefined||(loc.quote&&typeof loc.quote==='object'&&(loc.quote.p===undefined||(typeof loc.quote.p==='string'&&loc.quote.p.length<=200))&&(loc.quote.e===undefined||(typeof loc.quote.e==='string'&&loc.quote.e.length<=200))))
      &&(loc.column===undefined||loc.column===0||loc.column===1);
    const validPdfView=v=>v&&Number.isFinite(v.zoom)&&v.zoom>=.75&&v.zoom<=4&&[0,90,180,270].includes(v.rotation)
      &&(v.column===undefined||['off','lr','rl'].includes(v.column))
      &&(v.slot===undefined||v.slot===0||v.slot===1)
      &&(v.cropOdd===undefined||typeof v.cropOdd==='boolean')&&(v.cropEven===undefined||typeof v.cropEven==='boolean');
    if(b.locator&&!validLocator(b.locator)||b.pdfView&&!validPdfView(b.pdfView))throw new Error('备份阅读位置无效');
    // Per-book typography must stay inside the same ranges the settings panel allows.
    if(b.typeset!==undefined&&b.typeset!==null){
      const values=b.typeset?.values;
      if(values&&typeof values==='object'){const normalized=normalizeSettings(values);for(const key of Object.keys(values)){if(key==='customFont'){if(typeof values[key]!=='string'||values[key].length>100)throw new Error('备份字体记录无效');}else if(!bookKeys.includes(key)||normalized[key]!==values[key])throw new Error('备份排版记录无效');}}

      if(!values||typeof values!=='object'||values.size!==undefined&&!(Number.isFinite(values.size)&&values.size>=14&&values.size<=42)||values.line!==undefined&&!(Number.isFinite(values.line)&&values.line>=1.2&&values.line<=2.5)||values.margin!==undefined&&!(Number.isFinite(values.margin)&&values.margin>=3&&values.margin<=18)||values.customFont!==undefined&&typeof values.customFont!=='string')throw new Error('备份排版记录无效');
    }
    for(const note of b.notes){if(!note||!safeId(note.id)||typeof note.text!=='string'||typeof note.note!=='string'||note.text.length>1000000||note.note.length>1000000||!Number.isFinite(note.created)||!validLocator(note)||note.start!==undefined&&!validIndex(note.start)||note.end!==undefined&&(!validIndex(note.end)||note.end<note.start)||note.rects&&(!Array.isArray(note.rects)||note.rects.length>10000||note.rects.some(r=>!r||['x','y','w','h'].some(k=>!Number.isFinite(r[k])||r[k]<(k==='w'||k==='h'?0:-2)||r[k]>2))))throw new Error('备份笔记记录无效');}
    for(const n of b.notes)if(n.fragments!==undefined){
      if(!Array.isArray(n.fragments)||!n.fragments.length||n.fragments.length>50)throw Error('备份跨页划线无效');let prior=-1;
      for(const f of n.fragments){if(!f||!validIndex(f.pdfPage)||f.pdfPage<=prior||![0,90,180,270].includes(f.rotation)||!validIndex(f.start)||!validIndex(f.end)||f.end<f.start||typeof f.text!=='string'||f.text.length>1000000||!Array.isArray(f.rects)||f.rects.length>10000||f.rects.some(r=>!r||['x','y','w','h'].some(k=>!Number.isFinite(r[k])||r[k]<(k==='w'||k==='h'?0:-2)||r[k]>2)))throw Error('备份跨页划线坐标无效');prior=f.pdfPage;}
    }
    for(const mark of b.bookmarks)if(!mark||!safeId(mark.id)||typeof mark.label!=='string'||!validLocator(mark.locator)||!Number.isFinite(mark.created))throw new Error('备份书签记录无效');
    ids.add(b.id);expectedOffset+=entry.size;
    const original=blob.slice(base+entry.offset,base+entry.offset+entry.size),bytes=new Uint8Array(await original.arrayBuffer());
    if(await digest(bytes)!==b.id)throw new Error('备份校验未通过：'+b.filename);
    // Reparse originals through the same sanitizer as imports, never trust stored HTML.
    const doc=await parseFile(b.filename,bytes);delete b.openFailure;b.kind=doc.kind;b.format=b.filename.split('.').pop().toUpperCase();b.pages=doc.pages||0;
    if(!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(b.cover||''))b.cover=doc.cover||'';
    records.push({book:b,doc,original});onProgress(i+1,data.entries.length);await new Promise(r=>setTimeout(r,0));
  }
  if(base+expectedOffset!==blob.size)throw new Error('备份长度不匹配');
  // 1.1.5 backup additions. Older files simply do not carry these fields.
  const locOk=loc=>!loc||typeof loc==='object'&&['chapter','anchor','pdfPage'].every(k=>loc[k]===undefined||(Number.isSafeInteger(loc[k])&&loc[k]>=0&&loc[k]<=10000000));
  const validThemes=(()=>{
    const list=Array.isArray(data.themes)?data.themes:[];
    if(list.length>60)throw new Error('备份主题过多');
    return list.filter(t=>t&&typeof t.id==='string'&&t.id.length<=64&&typeof t.name==='string'&&t.name.length<=100&&t.values&&typeof t.values==='object').map(t=>{
      const normalized=normalizeSettings(t.values),values={};
      for(const key of bookKeys)if(t.values[key]!==undefined){
        if(normalized[key]!==t.values[key])throw new Error('备份主题排版无效');
        values[key]=t.values[key];
      }
      if(typeof t.values.customFont==='string'&&t.values.customFont.length<=100)values.customFont=t.values.customFont;
      return {id:t.id,name:t.name,created:Number.isFinite(t.created)?t.created:Date.now(),values};
    });
  })();
  const validVocab=(()=>{
    const list=Array.isArray(data.vocab)?data.vocab:[];
    if(list.length>20000)throw new Error('备份生词过多');
    return list.filter(v=>v&&typeof v.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v.id)&&typeof v.word==='string'&&v.word.length<=200&&typeof v.definition==='string'&&v.definition.length<=8000)
      .map(v=>({
        id:v.id,word:v.word,definition:v.definition,
        dictName:typeof v.dictName==='string'?v.dictName.slice(0,200):'',
        dictId:typeof v.dictId==='string'?v.dictId.slice(0,100):'',
        context:typeof v.context==='string'?v.context.slice(0,2000):'',
        bookId:typeof v.bookId==='string'?v.bookId.slice(0,100):'',
        bookTitle:typeof v.bookTitle==='string'?v.bookTitle.slice(0,500):'',
        locator:locOk(v.locator)?v.locator:null,
        created:Number.isFinite(v.created)?v.created:Date.now(),
        state:['new','known','review'].includes(v.state)?v.state:'new',
        due:Number.isSafeInteger(v.due)&&v.due>=0&&v.due<=8640000000000000?v.due:0,
        streak:Number.isInteger(v.streak)&&v.streak>=0&&v.streak<=12?v.streak:0,
        lastReview:Number.isSafeInteger(v.lastReview)&&v.lastReview>=0?v.lastReview:0,
        key:typeof v.key==='string'?v.key.slice(0,300):'',
        reviews:Array.isArray(v.reviews)?v.reviews.filter(r=>r&&Number.isFinite(r.at)&&['known','review'].includes(r.result)).slice(-50):[],
      }));
  })();
  await restoreBooks(records,validVocab);return {settings:data.settings||{},count:records.length,themes:validThemes,records:validVocab,vocabAuto:typeof data.vocabAuto==='boolean'?data.vocabAuto:undefined};
}
export async function saveBackup(blob,name){
  if(!window.Android?.beginExport)return false;
  const token=window.Android.beginExport();if(!token)throw new Error('已有保存任务，请先完成文件选择');
  try{
    for(let offset=0;offset<blob.size;offset+=98304){const bytes=new Uint8Array(await blob.slice(offset,offset+98304).arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));if(!window.Android.appendExport(token,btoa(s)))throw new Error('备份缓存写入失败，请检查空间');await new Promise(r=>setTimeout(r,0));}
    window.Android.finishExport(token,name);return true;
  }catch(e){window.Android.cancelExport(token);throw e;}
}
