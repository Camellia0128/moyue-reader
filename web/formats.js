import { unzipSync, strFromU8, strToU8 } from 'fflate';
import DOMPurify from 'dompurify';
import mammoth from 'mammoth/mammoth.browser.js';
import * as CFB from 'cfb';
import {safeStyle,applyBookStyles} from './book-style.js';
import {protectDocumentImages} from './image-budget.js';

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function resolvePath(base, relative) {
  const path=decodeURIComponent(relative.split('#')[0].split('?')[0]);
  const out=path.startsWith('/')?[]:base.split('/').slice(0,-1);
  for(const part of path.split('/')) {if(part==='..'){if(!out.length)throw new Error('文件路径无效');out.pop();}else if(part && part!=='.')out.push(part);}
  return out.join('/');
}
function xml(text) {const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw new Error('文档结构损坏，无法读取');return doc;}
function byLocal(doc,name){return [...doc.getElementsByTagName('*')].filter(n=>n.localName===name);}
function zipRead(bytes) {
  let total=0,count=0;
  return unzipSync(bytes,{filter:entry=>{if(++count>20000 || entry.originalSize>60*1024*1024 || (total+=entry.originalSize)>220*1024*1024)throw new Error('解压后的文档过大，无法安全打开');return !entry.name.endsWith('/');}});
}
const typeFor=(path)=>({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',avif:'image/avif'}[path.split('.').pop().toLowerCase()]||'application/octet-stream');
function dataUrl(bytes,path) {
  if(path.toLowerCase().endsWith('.svg'))bytes=strToU8(DOMPurify.sanitize(strFromU8(bytes),{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['script','foreignObject','image','a','style'],FORBID_ATTR:['style']}));
  let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return `data:${typeFor(path)};base64,${btoa(text)}`;
}
export function cleanHtml(raw) {
  // `moyue:` is the reader's own in-book link scheme; without it DOMPurify strips the href and
  // cross-chapter links (and every footnote marker) silently stop working.
  const clean=DOMPurify.sanitize(raw,{USE_PROFILES:{html:true,mathMl:true},FORBID_TAGS:['style','form','input','button','textarea','select','video','audio','iframe','object','embed'],FORBID_ATTR:['srcset'],ALLOW_DATA_ATTR:false,ALLOWED_URI_REGEXP:/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|moyue):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i});
  const doc=new DOMParser().parseFromString(clean,'text/html');
  // Book identifiers must never shadow the application's controls or loading UI.
  for(const node of doc.querySelectorAll('[id]'))if(!node.id.startsWith('moyue-content-'))node.id='moyue-content-'+node.id;
  for(const link of doc.querySelectorAll('a[href^="#"]')){const target=link.getAttribute('href').slice(1);if(target&&!target.startsWith('moyue-content-'))link.setAttribute('href','#moyue-content-'+target);}
  for(const node of doc.querySelectorAll('[style]')){const style=safeStyle(node.getAttribute('style'));if(style)node.setAttribute('style',style);else node.removeAttribute('style');}
  for(const image of doc.querySelectorAll('img')) {if(!/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);base64,/i.test(image.getAttribute('src')||''))image.remove();}
  for(const link of doc.querySelectorAll('a')) {if(!/^#|^moyue:/i.test(link.getAttribute('href')||'')){link.removeAttribute('href');}}
  return doc.body.innerHTML;
}
/** Old parser versions also used parserVersion=2, before identifiers were isolated. */
export function prepareDocument(doc){
  if(doc.safeContentVersion===1)return doc;
  for(const c of [...doc.chapters||[],...doc.layoutChapters||[]])c.html=cleanHtml(c.html);
  doc.safeContentVersion=1;return doc;
}
function chapter(title,html,path='') {
  const safe=cleanHtml(html);const dom=new DOMParser().parseFromString(safe,'text/html');
  const text=dom.body.textContent||'';
  return {title,html:safe,path,text,length:text.length};
}
async function textChapters(text,title) {
  const lines=text.replace(/\r\n?/g,'\n').matchAll(/[^\n]+/g);const chapters=[];let parts=[],heading=title,length=0,count=0;
  const flush=()=>{if(parts.length){chapters.push(chapter(heading,`<h2>${escapeHtml(heading)}</h2>`+parts.join('')));parts=[];length=0;}};
  for(const match of lines){const s=match[0].trim();if(!s)continue;if(++count>200000)throw Error('文档段落过多，请分卷导入');if(s.length<70 && /^(第[零〇一二三四五六七八九十百千万\d]+[章回卷节部篇]|chapter\s+\d+)/i.test(s)){flush();heading=s;}else{parts.push(`<p>${escapeHtml(s)}</p>`);length+=s.length;if(length>18000){flush();heading=title+' · '+(chapters.length+1);await new Promise(r=>setTimeout(r,0));}}if(count%250===0)await new Promise(r=>setTimeout(r,0));}flush();
  return chapters.length?chapters:[chapter(title,'<p>此文件没有可显示的正文。</p>')];
}
export function decodeText(bytes) {
  if(bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if(bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030').decode(bytes);}
}

export function extractDoc(bytes) {
  const container=CFB.read(bytes,{type:'array'});
  const wordContent=CFB.find(container,'WordDocument')?.content;
  if(!wordContent)throw new Error('不是可识别的 Word 97–2003 文档，请另存为 DOCX 后导入');
  const word=new Uint8Array(wordContent);
  const v=new DataView(word.buffer,word.byteOffset,word.byteLength);
  if(word.length<154 || v.getUint16(0,true)!==0xa5ec)throw new Error('不支持此版本的 DOC 文件，请另存为 DOCX');
  const flags=v.getUint16(10,true);
  if(flags&0x0100)throw new Error('文档已加密，请先在 Word 中解除密码');
  let pos=32;const csw=v.getUint16(pos,true);pos+=2+csw*2;const cslw=v.getUint16(pos,true);const lw=pos+2;
  const textLength=v.getUint32(lw+12,true);pos=lw+cslw*4;const pairs=v.getUint16(pos,true);pos+=2;
  if(pairs<=33 || pos+272>word.length)throw new Error('DOC 文档索引损坏');
  const fcClx=v.getUint32(pos+264,true),lcbClx=v.getUint32(pos+268,true);
  const tableContent=CFB.find(container,(flags&0x0200)?'1Table':'0Table')?.content;
  if(!tableContent)throw new Error('DOC 文档的正文索引无法读取');
  const table=new Uint8Array(tableContent);
  if(fcClx+lcbClx>table.length)throw new Error('DOC 文档的正文索引无法读取');
  const t=new DataView(table.buffer,table.byteOffset,table.byteLength);let p=fcClx,end=fcClx+lcbClx;
  while(p<end && table[p]===1)p+=3+t.getUint16(p+1,true);
  if(p+5>end||table[p]!==2)throw new Error('此 DOC 排版版本不受支持，请另存为 DOCX');
  const size=t.getUint32(p+1,true);p+=5;const count=(size-4)/12;
  if(!Number.isInteger(count)||count<1||count>100000||p+size>end)throw new Error('DOC 正文索引损坏');
  let output='';
  for(let i=0;i<count;i++){
    const start=t.getUint32(p+i*4,true),finish=Math.min(textLength,t.getUint32(p+(i+1)*4,true));if(start>=textLength)break;
    const chars=finish-start;const fc=t.getUint32(p+(count+1)*4+i*8+2,true);const compressed=!!(fc&0x40000000);const offset=(fc&0x3fffffff)/(compressed?2:1);const length=chars*(compressed?1:2);
    if(offset+length>word.length||output.length+chars>5000000)throw new Error('DOC 正文数据损坏或过大');
    output+=new TextDecoder(compressed?'windows-1252':'utf-16le').decode(word.subarray(offset,offset+length));
  }
  return output.replace(/\x13[^\x14\x15]*\x14/g,'').replace(/[\x00-\x08\x0b\x0e-\x1f]/g,'').replace(/\x0c/g,'\n\n').replace(/\r/g,'\n');
}

async function epub(bytes,fallback) {
  const zip=zipRead(bytes);const container=zip['META-INF/container.xml'];if(!container)throw new Error('EPUB 缺少 container.xml');
  const root=byLocal(xml(strFromU8(container)),'rootfile')[0]?.getAttribute('full-path');if(!root||!zip[root])throw new Error('EPUB 缺少书籍索引');
  const opf=xml(strFromU8(zip[root]));const title=byLocal(opf,'title')[0]?.textContent?.trim()||fallback;const author=byLocal(opf,'creator')[0]?.textContent?.trim()||'未知作者';
  const items=new Map(byLocal(opf,'item').map(n=>[n.getAttribute('id'),{path:resolvePath(root,n.getAttribute('href')||''),properties:n.getAttribute('properties')||'',type:n.getAttribute('media-type')} ]));
  const spine=byLocal(opf,'itemref').filter(n=>n.getAttribute('linear')!=='no').map(n=>items.get(n.getAttribute('idref'))).filter(Boolean);
  if(!spine.length)throw new Error('EPUB 没有可阅读的章节');
  const encrypted=zip['META-INF/encryption.xml']?strFromU8(zip['META-INF/encryption.xml']):'';
  if(encrypted){
    const algorithms=byLocal(xml(encrypted),'EncryptionMethod').map(n=>n.getAttribute('Algorithm')||'');
    // Font obfuscation is not book DRM. We use our own bundled font and can ignore it.
    const fontObfuscation=new Set(['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC']);
    if(algorithms.some(a=>!fontObfuscation.has(a)))throw new Error('这本 EPUB 可能有 DRM 加密，无法读取');
  }
  const pathIndex=new Map(spine.map((item,i)=>[item.path,i]));let toc=[];
  const nav=[...items.values()].find(n=>n.properties.split(' ').includes('nav'));
  if(nav&&zip[nav.path]){
    const ndoc=new DOMParser().parseFromString(strFromU8(zip[nav.path]),'text/html');
    const navNode=[...ndoc.querySelectorAll('nav')].find(n=>n.getAttribute('epub:type')==='toc'||n.getAttribute('role')==='doc-toc')||ndoc.querySelector('nav');
    for(const a of navNode?.querySelectorAll('a[href]')||[]){try{const href=a.getAttribute('href'),path=resolvePath(nav.path,href),index=pathIndex.get(path);if(index!==undefined)toc.push({title:a.textContent.trim(),chapter:index,fragment:decodeURIComponent(href.split('#')[1]||'')});}catch{}}
  }
  const ncx=[...items.values()].find(n=>n.type==='application/x-dtbncx+xml');
  if(!toc.length&&ncx&&zip[ncx.path]){const n=xml(strFromU8(zip[ncx.path]));for(const point of byLocal(n,'navPoint')){const src=byLocal(point,'content')[0]?.getAttribute('src');if(!src)continue;const idx=pathIndex.get(resolvePath(ncx.path,src));if(idx!==undefined)toc.push({title:byLocal(point,'text')[0]?.textContent||'章节',chapter:idx,fragment:decodeURIComponent(src.split('#')[1]||'')});}}
  const chapters=spine.map((item,index)=>{
    if(!zip[item.path])throw new Error(`EPUB 章节文件缺失：${item.path}`);
    const doc=new DOMParser().parseFromString(strFromU8(zip[item.path]),'text/html');
    for(const image of [...doc.querySelectorAll('img,image')]){
      const src=image.getAttribute('src')||image.getAttribute('xlink:href')||image.getAttribute('href');if(!src||/^(https?:|javascript:|data:)/i.test(src)){image.remove();continue;}
      try{const path=resolvePath(item.path,src);if(zip[path]&&typeFor(path)!=='application/octet-stream'){const img=doc.createElement('img');img.src=dataUrl(zip[path],path);img.alt=image.getAttribute('alt')||'';const target=image.closest('svg')||image;target.replaceWith(img);}else image.remove();}catch{image.remove();}
    }
    for(const a of doc.querySelectorAll('a[href]')){const href=a.getAttribute('href');try{const path=href.startsWith('#')?item.path:resolvePath(item.path,href),idx=pathIndex.get(path);if(idx!==undefined){a.setAttribute('href',`moyue:${idx}#${encodeURIComponent(href.split('#')[1]||'')}`);
      // Footnote/endnote markers: an explicit epub:type or role, or the usual bracketed numeral.
      // The class survives sanitising (data attributes do not), so the reader can offer a preview.
      const kind=a.getAttribute('epub:type')||a.getAttribute('role')||'',label=(a.textContent||'').trim();
      if(/noteref|doc-noteref|footnote|endnote/i.test(kind)||/^[[(]\s*\d{1,3}\s*[\])]$/.test(label)||/^[¹²³⁴⁵⁶⁷⁸⁹⁰]+$/.test(label)){a.classList.add('noteref');a.setAttribute('title','预览注释');}
    }else a.removeAttribute('href');}catch{a.removeAttribute('href');}}
    const styles=[...doc.querySelectorAll('style')].map(n=>n.textContent);
    for(const link of doc.querySelectorAll('link[rel="stylesheet"]')){try{const path=resolvePath(item.path,link.getAttribute('href')||'');if(zip[path])styles.push(strFromU8(zip[path]));}catch{}}
    applyBookStyles(doc,styles);
    const heading=toc.find(t=>t.chapter===index)?.title||doc.querySelector('h1,h2,h3')?.textContent?.trim()||`第 ${index+1} 节`;
    const c=chapter(heading,doc.body.innerHTML,item.path);const viewport=doc.querySelector('meta[name="viewport"]')?.content||'';
    if(byLocal(opf,'meta').some(n=>n.getAttribute('property')==='rendition:layout'&&n.textContent.trim()==='pre-paginated')){c.fixed=true;c.width=Number(viewport.match(/width\s*=\s*([\d.]+)/i)?.[1])||800;c.height=Number(viewport.match(/height\s*=\s*([\d.]+)/i)?.[1])||1100;}
    return c;
  });
  if(!toc.length)toc=chapters.map((c,i)=>({title:c.title,chapter:i,fragment:''}));
  const coverMeta=byLocal(opf,'meta').find(n=>n.getAttribute('name')==='cover')?.getAttribute('content');
  const coverItem=items.get(coverMeta)||[...items.values()].find(n=>n.properties.split(' ').includes('cover-image'));
  let cover='';if(coverItem&&zip[coverItem.path])cover=dataUrl(zip[coverItem.path],coverItem.path);
  const fixed=byLocal(opf,'meta').some(n=>n.getAttribute('property')==='rendition:layout'&&n.textContent==='pre-paginated');
  return {title,author,chapters,toc,cover,fixed,notice:fixed?'此 EPUB 按固定页面比例显示，可在阅读设置中切换正文排版。':''};
}
export async function parseFile(name,bytes) {
  const ext=(name.split('.').pop()||'').toLowerCase();const fallback=name.replace(/\.[^.]+$/,'');
  if(bytes.length>100*1024*1024)throw new Error('单个文件不能超过 100 MB');
  if(!bytes.length)throw new Error('文件为空');
  if(ext==='pdf'){
    if(!strFromU8(bytes.subarray(0,1024)).includes('%PDF-'))throw new Error('不是有效的 PDF 文件');
    const {openPdfDocument}=await import('./pdf-open.js');const doc=await openPdfDocument(bytes);
    try{const meta=await doc.getMetadata().catch(()=>({}));const title=meta.info?.Title;return {title:title&&title.length<200?title:fallback,author:meta.info?.Author||'PDF 文档',kind:'pdf',pages:doc.numPages,chapters:[],toc:await pdfOutline(doc),pdfMode:doc.isNative?'native':'auto'};}finally{await doc.destroy();}
  }
  let parsed;
  if(ext==='epub')parsed=await epub(bytes,fallback);
  else if(ext==='docx'){
    zipRead(bytes);
    const result=await mammoth.convertToHtml({arrayBuffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)},{externalFileAccess:false});
    const doc=new DOMParser().parseFromString(cleanHtml(result.value),'text/html');
    let chapters=[],parts=[],title=fallback;let index=0;
    const flush=()=>{if(parts.length){chapters.push(chapter(title,parts.join('')));parts=[];}};
    for(const child of doc.body.children){if(/^H[12]$/.test(child.tagName)&&parts.length){flush();}if(/^H[12]$/.test(child.tagName))title=child.textContent.trim()||fallback;parts.push(child.outerHTML);index++;}flush();
    if(!chapters.length)throw new Error('DOCX 中没有可读取的内容');
    parsed={title:fallback,author:'Word 文档',chapters};
    try{
      const {renderAsync}=await import('docx-preview');const body=document.createElement('div'),styles=document.createElement('div');
      await renderAsync(bytes,body,styles,{useBase64URL:true,ignoreFonts:true,renderAltChunks:false,ignoreLastRenderedPageBreak:false,renderComments:false});
      const layoutDoc=new DOMParser().parseFromString(body.innerHTML,'text/html');applyBookStyles(layoutDoc,[...styles.querySelectorAll('style')].map(n=>n.textContent));
      parsed.layoutChapters=[...layoutDoc.querySelectorAll('section.docx')].map((page,i)=>{const c=chapter('第 '+(i+1)+' 页',page.innerHTML);c.fixed=true;c.width=parseFloat(page.style.width)*(/pt$/.test(page.style.width)?4/3:1)||794;c.height=parseFloat(page.style.minHeight||page.style.height)*(/pt$/.test(page.style.minHeight||page.style.height)?4/3:1)||1123;c.html='<div class="original-page" style="'+safeStyle(page.style.cssText)+'">'+c.html+'</div>';return c;});
    }catch(error){console.warn('Word original layout unavailable',error);parsed.notice='Word 原版预览未能生成，已保留正文阅读模式。';}
  } else if(ext==='doc')parsed={title:fallback,author:'Word 文档',chapters:await textChapters(extractDoc(bytes),fallback),notice:'旧版 DOC 以正文阅读模式打开，不保留复杂版式。'};
  else if(ext==='txt'||ext==='md')parsed={title:fallback,author:'本地文档',chapters:await textChapters(decodeText(bytes),fallback)};
  else if(ext==='html'||ext==='htm'){const dom=new DOMParser().parseFromString(decodeText(bytes),'text/html');parsed={title:dom.title||fallback,author:'HTML 文档',chapters:[chapter(dom.title||fallback,dom.body.innerHTML)]};}
  else throw new Error('支持 PDF、EPUB、DOCX、DOC、TXT、Markdown 和 HTML 文件');
  parsed.kind='text';parsed.parserVersion=3;parsed.safeContentVersion=1;parsed.toc||=parsed.chapters.map((c,i)=>({title:c.title,chapter:i,fragment:''}));
  parsed.length=parsed.chapters.reduce((sum,c)=>sum+c.length,0);
  return await protectDocumentImages(parsed);
}
async function pdfOutline(doc) {
  const result=[];
  async function visit(items,level=0){for(const item of items||[]){try{let dest=typeof item.dest==='string'?await doc.getDestination(item.dest):item.dest;let page=dest?(typeof dest[0]==='number'?dest[0]:await doc.getPageIndex(dest[0])):0;result.push({title:item.title,page,level});}catch{}await visit(item.items,level+1);}}
  await visit(await doc.getOutline());return result;
}
