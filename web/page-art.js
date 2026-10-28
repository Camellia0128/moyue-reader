import {Paginator} from './paginator.js';
import {prepareDocument} from './formats.js';
import {renderNativePdfPage} from './native-pdf.js';
export async function pdfThumbnail(pdf,page,width=240,height=330){
  const host=document.createElement('div');host.className='art-host';host.style.cssText=`position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;overflow:hidden`;document.body.append(host);
  try{
    const render=pdf.isNative?renderNativePdfPage:(await import('./pdf.js')).renderPdfPage;await render(pdf,page,host,{});
    const paper=host.querySelector('.pdf-paper'),canvas=paper.querySelector('canvas');
    if(canvas)return canvas.toDataURL('image/jpeg',.82);
    const img=paper.querySelector('img'),copy=document.createElement('canvas');copy.width=img.naturalWidth;copy.height=img.naturalHeight;copy.getContext('2d').drawImage(img,0,0);return copy.toDataURL('image/jpeg',.82);
  }finally{host.remove();}
}
export async function textThumbnail(doc){
  prepareDocument(doc);
  const c=doc.layoutChapters?.[0]||doc.chapters[0];if(!c)return '';
  const host=document.createElement('div');host.className='page-art';host.style.cssText='position:fixed;left:-20000px;top:0;width:580px;height:800px;background:#dddddd;color:#262720;overflow:hidden;--reader-size:23px;--reader-line:1.75;--reader-weight:400;--reader-align:justify;';
  host.style.backgroundColor='#ffffff';host.innerHTML='<div class="page-viewport" style="inset:45px 45px"><article class="flow"></article></div>';document.body.append(host);
  try{const p=new Paginator(host.firstChild,host.querySelector('.flow'));await p.layout(c.html,0,c.fixed?c:null);const {default:html2canvas}=await import('html2canvas');const canvas=await html2canvas(host,{scale:.5,backgroundColor:'#ffffff',logging:false,allowTaint:false});return canvas.toDataURL('image/jpeg',.82);}finally{host.remove();}
}
