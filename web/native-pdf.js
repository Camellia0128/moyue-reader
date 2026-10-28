const requests=new Map();
export const nativePdfAvailable=()=>typeof window.Android?.beginPdf==='function';
export function nativePdfResult(value){const pending=requests.get(value?.request);if(!pending)return;requests.delete(value.request);clearTimeout(pending.timer);if(value.ok)pending.resolve(value);else pending.reject(new Error(value.message||'系统 PDF 兼容引擎无法打开此文件'));}
function request(run,timeout=20000){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{requests.delete(id);reject(new Error('系统 PDF 引擎响应超时，可以返回书库后重试'));},timeout);requests.set(id,{resolve,reject,timer});try{run(id);}catch(e){clearTimeout(timer);requests.delete(id);reject(e);}});}
export async function openNativePdf(bytes,{signal,bytesLoader}={}){
  if(!nativePdfAvailable())throw new Error('当前安装版本没有系统 PDF 兼容引擎');
  const token=window.Android.beginPdf();if(!token)throw new Error('无法建立 PDF 兼容会话，请返回书库后重试');
  try{
    for(let start=0;start<bytes.length;start+=98304){
      if(signal?.aborted)throw new DOMException('已取消打开','AbortError');
      const chunk=bytes.subarray(start,start+98304);let binary='';for(let i=0;i<chunk.length;i+=8192)binary+=String.fromCharCode(...chunk.subarray(i,i+8192));
      if(!window.Android.appendPdf(token,btoa(binary)))throw new Error('PDF 兼容缓存写入失败，请检查设备存储空间');
      if(start%393216===0)await new Promise(r=>setTimeout(r,0));
    }
    const info=await request(id=>window.Android.openPdf(token,id));
    if(signal?.aborted)throw new DOMException('已取消打开','AbortError');
    if(bytesLoader)bytes=null;
    let companion=null,companionTask=null,dead=false;
    const companionPage=async index=>{if(!companionTask)companionTask=import('./pdf.js').then(async({openPdf})=>{const data=bytesLoader?await bytesLoader():bytes.slice();if(dead||signal?.aborted)throw new DOMException('PDF 会话已关闭','AbortError');return openPdf(data,undefined,{signal});}).then(pdf=>{if(dead){pdf.destroy();throw new Error('PDF 会话已关闭');}companion=pdf;return pdf;});return(await companionTask).getPage(index);};
    const doc={isNative:true,numPages:info.pages,token,getMetadata:async()=>({info:{}}),getOutline:async()=>null,
      async getGeometryPage(index){try{return await companionPage(index);}catch{return doc.getPage(index,true);}},
      async selection(index,start,end){if(!window.Android.pdfSelection)throw new Error('当前安装版本不支持精确文字范围');return request(id=>window.Android.pdfSelection(token,index,start,end,id));},
      async getPage(index,nativeOnly=false){
        let nativeText;
        try{if(window.Android.pdfText)nativeText=await request(id=>window.Android.pdfText(token,index-1,nativeOnly,id));}catch(error){console.debug('Native PDF text unavailable',error);}
        if(nativeText?.supported)return {getTextContent:async()=>nativeText,cleanup(){}};
        if(nativeOnly&&!doc.textRequested&&!companionTask)return {getTextContent:async()=>({items:[]}),cleanup(){}};
        try{return await companionPage(index);}
        catch(error){doc.textUnavailable=true;return {getTextContent:async()=>({items:[]}),cleanup(){}};}
      },
      async destroy(){dead=true;window.Android.releasePdf(token);if(companion)await companion.destroy();}
    };return doc;
  }catch(e){window.Android.releasePdf(token);throw e;}
}
export async function renderNativePdfPage(doc,index,host,{zoom=1,rotate=0,crop=false,fitWidth=false,column='off'}={}){
  const ratio=Math.min(devicePixelRatio||1,2),width=host.clientWidth,height=host.clientHeight;
  const info=await request(id=>window.Android.renderPdf(doc.token,index,Math.round(width*ratio*zoom),Math.round(height*ratio*zoom),rotate,id));
  // The platform renderer already hands back a JPEG it keeps until the session rotates its
  // four-image window, so no canvas snapshot is needed to keep the page stable.
  const image=new Image();image.alt=`PDF 第 ${index+1} 页（兼容模式）`;image.src=info.url;await image.decode();
  let bounds={x:0,y:0,w:info.width,h:info.height};
  if(column==='left'||column==='right'){const half=info.width/2;bounds={x:column==='left'?0:half,y:0,w:half,h:info.height};}
  else if(crop){const scan=document.createElement('canvas');scan.width=info.width;scan.height=info.height;const ctx=scan.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,scan.width,scan.height).data;let x1=scan.width,y1=scan.height,x2=0,y2=0;
    for(let y=0;y<scan.height;y+=3)for(let x=0;x<scan.width;x+=3){const i=(y*scan.width+x)*4;if(pixels[i]<230||pixels[i+1]<230||pixels[i+2]<230){x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y);}}
    if(x2>x1&&y2>y1){bounds.x=Math.max(0,x1-12);bounds.y=Math.max(0,y1-12);bounds.w=Math.min(scan.width-bounds.x,x2-x1+24);bounds.h=Math.min(scan.height-bounds.y,y2-y1+24);}
  }
  const scale=(fitWidth?width/bounds.w:Math.min(width/bounds.w,height/bounds.h))*zoom;
  const wrap=document.createElement('div');wrap.className='pdf-paper';wrap.style.cssText=`width:${bounds.w*scale}px;height:${bounds.h*scale}px;overflow:hidden`;
  wrap.dataset.fullWidth=info.width*scale;wrap.dataset.fullHeight=info.height*scale;wrap.dataset.cropX=bounds.x*scale;wrap.dataset.cropY=bounds.y*scale;
  image.style.cssText=`position:absolute;width:${info.width*scale}px;height:${info.height*scale}px;left:${-bounds.x*scale}px;top:${-bounds.y*scale}px;max-width:none`;image.alt=`PDF 第 ${index+1} 页（兼容模式）`;wrap.append(image);host.replaceChildren(wrap);
  (async()=>{try{
    const page=await doc.getPage(index+1,true),content=await page.getTextContent();
    if(content.supported){const layer=document.createElement('div');layer.className='textLayer native-text-layer';layer.style.cssText=`width:${info.width*scale}px;height:${info.height*scale}px;left:${-bounds.x*scale}px;top:${-bounds.y*scale}px;`;
      for(const item of content.items){if(!item.str||!item.w||!item.h)continue;let rect={...item};for(let turn=0;turn<rotate/90;turn++)rect={...rect,x:1-rect.y-rect.h,y:rect.x,w:rect.h,h:rect.w};const span=document.createElement('span');span.textContent=item.str;span.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.w*100}%;height:${rect.h*100}%;font-size:${Math.max(1,rect.h*info.height*scale)}px;`;layer.append(span);}wrap.append(layer);
    }else if(page.getViewport){const {attachTextLayer}=await import('./pdf.js');const viewport=page.getViewport({scale:info.width*scale/page.getViewport({scale:1,rotation:page.rotate+rotate}).width,rotation:page.rotate+rotate});await attachTextLayer(page,wrap,viewport,-bounds.x*scale,-bounds.y*scale);}
    page.cleanup();
  }catch(error){console.debug('Optional compatible PDF text layer skipped',error);}})();
  return{wrap,text:''};
}
