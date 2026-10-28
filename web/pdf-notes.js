export const fragmentsOf=note=>note.fragments?.length?note.fragments:note.pdfPage!==undefined?[note]:[];
export function rotateRect(rect,turns){let r={...rect};for(let i=0;i<((turns%4)+4)%4;i++)r={x:1-r.y-r.h,y:r.x,w:r.h,h:r.w};return r;}
export function layerSelection(layer,range){
  const pre=document.createRange();pre.selectNodeContents(layer);pre.setEnd(range.startContainer,range.startOffset);const start=pre.toString().length;
  const rect=layer.getBoundingClientRect();return{start,end:start+range.toString().length,text:range.toString(),rects:[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({x:(r.left-rect.left)/rect.width,y:(r.top-rect.top)/rect.height,w:r.width/rect.width,h:r.height/rect.height}))};
}
export async function pdfPageModel(doc,index){
  const page=await (doc.getGeometryPage?doc.getGeometryPage(index+1):doc.getPage(index+1,true));let layer;
  try{
    const content=await page.getTextContent();
    if(content.supported){
      let at=0;const runs=content.items.filter(i=>i.str&&i.w&&i.h).map(i=>{const start=at;at+=i.str.length;return {...i,start,end:at};});
      const text=runs.map(i=>i.str).join('');
      const model={text,range(start,end){start=Math.max(0,Math.min(text.length,start));end=Math.max(start,Math.min(text.length,end));return{pdfPage:index,rotation:0,start,end,text:text.slice(start,end),rects:runs.filter(i=>i.end>start&&i.start<end).map(i=>{const a=Math.max(0,start-i.start)/i.str.length,b=Math.min(i.str.length,end-i.start)/i.str.length;return{x:i.x+i.w*a,y:i.y,w:i.w*(b-a),h:i.h};})};},async resolve(start,end){const wanted=text.slice(start,end);if(!wanted)return this.range(start,end);const first=runs.find(r=>r.end>start),last=runs.find(r=>r.end>=end),globalStart=Number.isInteger(first?.globalStart)?first.globalStart+start-first.start:start,globalEnd=Number.isInteger(last?.globalStart)?last.globalStart+end-last.start:end;const exact=await doc.selection(index,globalStart,globalEnd);if(exact.text.replace(/\s/g,'')!==wanted.replace(/\s/g,''))throw Error('系统文字顺序不匹配，无法准确保存；请尝试标准模式');return{...this.range(start,end),rects:exact.rects};}};return model;
    }
    if(!page.getViewport)throw new Error('这一页没有可用的文字层，扫描页需先做 OCR');
    const base=page.getViewport({scale:1,rotation:page.rotate});const viewport=page.getViewport({scale:1000/base.width,rotation:page.rotate});
    const wrap=document.createElement('div');wrap.style.cssText=`position:fixed;left:-20000px;top:0;width:${viewport.width}px;height:${viewport.height}px;visibility:hidden;pointer-events:none;`;
    document.body.append(wrap);
    try{
      const {attachTextLayer}=await import('./pdf.js');await attachTextLayer(page,wrap,viewport);await document.fonts.ready;layer=wrap.querySelector('.textLayer');
      const nodes=[];let length=0;const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){nodes.push({node:n,start:length,end:length+n.length});length+=n.length;}
      const text=nodes.map(n=>n.node.textContent).join('');
      // Capture per-character rectangles once; the detached model contains no live DOM or PDF page.
      const boxes=[];
      if(text.length>200000)throw new Error('这一页文字过多，无法安全调整范围');
      const origin=layer.getBoundingClientRect();
      for(const entry of nodes){for(let i=0;i<entry.node.length;i++){const r=document.createRange();r.setStart(entry.node,i);r.setEnd(entry.node,i+1);const b=r.getBoundingClientRect();boxes.push({x:(b.left-origin.left)/origin.width,y:(b.top-origin.top)/origin.height,w:b.width/origin.width,h:b.height/origin.height});if(boxes.length%512===0)await new Promise(r=>setTimeout(r,0));}}
      return{text,range(start,end){start=Math.max(0,Math.min(text.length,start));end=Math.max(start,Math.min(text.length,end));const rects=[];for(const b of boxes.slice(start,end)){if(!b.w||!b.h)continue;const prev=rects.at(-1);if(prev&&Math.abs(prev.y-b.y)<.001&&Math.abs(prev.h-b.h)<.001&&Math.abs(prev.x+prev.w-b.x)<.003)prev.w=b.x+b.w-prev.x;else rects.push({...b});}return{pdfPage:index,rotation:0,start,end,text:text.slice(start,end),rects};}};
    }finally{wrap.remove();}
  }finally{page.cleanup?.();}
}
export function locateFragment(model,fragment){
  const original=(fragment.rects||[]).map(r=>rotateRect(r,-(fragment.rotation||0)/90));
  let best=null,cost=Infinity,from=0;
  if(fragment.text)for(let count=0;count<1000;count++){const at=model.text.indexOf(fragment.text,from);if(at<0)break;const boxes=model.range(at,at+fragment.text.length).rects;let distance=original.length&&boxes.length?Math.hypot(boxes[0].x-original[0].x,boxes[0].y-original[0].y):at===fragment.start?0:1;if(distance<cost){cost=distance;best={start:at,end:at+fragment.text.length};}from=at+Math.max(1,fragment.text.length);}
  if(best)return best;
  // Older notes only had rectangles. Find the nearest text intersection without modifying them.
  let start=-1,end=0;const rects=original;
  for(let i=0;i<model.text.length;i++){const boxes=model.range(i,i+1).rects;if(boxes.some(b=>rects.some(r=>b.x+b.w>r.x&&b.x<r.x+r.w&&b.y+b.h>r.y&&b.y<r.y+r.h))){if(start<0)start=i;end=i+1;}}
  if(start<0)throw new Error('找不到这条旧划线对应的文字，请核对文字层');return{start,end};
}
