if (!Promise.withResolvers) Promise.withResolvers=function(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',location.href).href;
export async function openPdf(bytes,password,{signal}={}) {
  // Native WebView interception is not guaranteed for worker-originated requests in
  // compatibility containers. Load CMaps/fonts/decoders via the document thread.
  const task=pdfjs.getDocument({data:bytes,password,cMapUrl:new URL('./cmaps/',location.href).href,cMapPacked:true,standardFontDataUrl:new URL('./standard_fonts/',location.href).href,wasmUrl:new URL('./wasm/',location.href).href,isEvalSupported:false,useSystemFonts:true,useWorkerFetch:false,isOffscreenCanvasSupported:false,isImageDecoderSupported:false});
  let timer,onAbort;
  try{return await Promise.race([task.promise,new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('PDF 网页引擎打开超时'));task.destroy().catch(()=>{});},15000);onAbort=()=>{reject(new DOMException('已取消打开','AbortError'));task.destroy().catch(()=>{});};if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});})]);}
  finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
}
export async function renderPdfPage(doc,index,host,{zoom=1,rotate=0,crop=false,fitWidth=false,column='off'}={}) {
  const page=await doc.getPage(index+1);const width=host.clientWidth,height=host.clientHeight;const base=page.getViewport({scale:1,rotation:page.rotate+rotate});
  let bounds={x:0,y:0,w:base.width,h:base.height};
  // Column reading is a half-page crop; everything below already works in cropped coordinates.
  if(column==='left'||column==='right'){const half=base.width/2;bounds={x:column==='left'?0:half,y:0,w:half,h:base.height};}
  else if(crop){
    const scanScale=Math.min(1,700/base.width),scanViewport=page.getViewport({scale:scanScale,rotation:page.rotate+rotate});const scan=document.createElement('canvas');scan.width=Math.ceil(scanViewport.width);scan.height=Math.ceil(scanViewport.height);const ctx=scan.getContext('2d',{willReadFrequently:true,alpha:false});
    await page.render({canvasContext:ctx,viewport:scanViewport}).promise;const data=ctx.getImageData(0,0,scan.width,scan.height).data;
    let x1=scan.width,y1=scan.height,x2=0,y2=0;
    for(let y=0;y<scan.height;y+=2)for(let x=0;x<scan.width;x+=2){const i=(y*scan.width+x)*4;if(data[i]<230||data[i+1]<230||data[i+2]<230){x1=Math.min(x1,x);x2=Math.max(x2,x);y1=Math.min(y1,y);y2=Math.max(y2,y);}}
    if(x2>x1&&y2>y1){const pad=12;bounds.x=Math.max(0,x1/scanScale-pad);bounds.y=Math.max(0,y1/scanScale-pad);bounds.w=Math.min(base.width-bounds.x,(x2-x1)/scanScale+pad*2);bounds.h=Math.min(base.height-bounds.y,(y2-y1)/scanScale+pad*2);}
  }
  let scale=(fitWidth?width/bounds.w:Math.min(width/bounds.w,height/bounds.h))*zoom;
  const ratio=Math.min(window.devicePixelRatio||1,2);
  // Bound bitmap allocation on low-memory tablets while keeping logical dimensions.
  const renderRatio=Math.min(ratio,Math.sqrt(4000000/(base.width*base.height*scale*scale)));
  const viewport=page.getViewport({scale,rotation:page.rotate+rotate});const canvas=document.createElement('canvas');canvas.width=Math.round(viewport.width*renderRatio);canvas.height=Math.round(viewport.height*renderRatio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
  const wrap=document.createElement('div');wrap.className='pdf-paper';wrap.style.width=bounds.w*scale+'px';wrap.style.height=bounds.h*scale+'px';wrap.style.overflow='hidden';wrap.dataset.fullWidth=viewport.width;wrap.dataset.fullHeight=viewport.height;wrap.dataset.cropX=bounds.x*scale;wrap.dataset.cropY=bounds.y*scale;
  canvas.style.position='absolute';canvas.style.left=-bounds.x*scale+'px';canvas.style.top=-bounds.y*scale+'px';wrap.append(canvas);
  const layer=document.createElement('div');layer.className='textLayer';layer.style.setProperty('--scale-factor',scale);layer.style.width=viewport.width+'px';layer.style.height=viewport.height+'px';layer.style.left=-bounds.x*scale+'px';layer.style.top=-bounds.y*scale+'px';wrap.append(layer);
  const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:context,viewport,transform:renderRatio===1?null:[renderRatio,0,0,renderRatio,0,0]}).promise;
  let text={items:[]};
  try{text=await page.getTextContent();await new pdfjs.TextLayer({textContentSource:text,container:layer,viewport}).render();}
  catch(error){layer.remove();console.warn('PDF text layer unavailable; keeping rendered page',error);}
  host.replaceChildren(wrap);page.cleanup();return {text:text.items.map(t=>t.str).join(' '),wrap};
}
export async function attachTextLayer(page,wrap,viewport,left=0,top=0){
  const layer=document.createElement('div');layer.className='textLayer';layer.style.cssText=`width:${viewport.width}px;height:${viewport.height}px;left:${left}px;top:${top}px`;layer.style.setProperty('--scale-factor',viewport.scale);wrap.append(layer);
  try{await new pdfjs.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport}).render();}catch(error){layer.remove();throw error;}
}
