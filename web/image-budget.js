import DOMPurify from 'dompurify';
export const IMAGE_PIXELS=4000000,MAX_SOURCE_PIXELS=32000000,CHAPTER_PIXELS=12000000;
const placeholder=message=>'data:image/svg+xml;base64,'+btoa(String.fromCharCode(...new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="640" height="200" fill="#ddd"/><text x="20" y="95" font-size="18">${message}</text></svg>`)));
function svgUrl(svg){const bytes=new TextEncoder().encode(svg);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return'data:image/svg+xml;base64,'+btoa(binary);}
export function imageDimensions(bytes,mime=''){
 const b=bytes,v=new DataView(b.buffer,b.byteOffset,b.byteLength),ascii=(at,n)=>String.fromCharCode(...b.subarray(at,at+n));
 if(b.length>=24&&ascii(1,3)==='PNG')return{width:v.getUint32(16),height:v.getUint32(20)};
 if(b.length>=10&&ascii(0,3)==='GIF')return{width:v.getUint16(6,true),height:v.getUint16(8,true)};
 if(b[0]===255&&b[1]===216){let at=2;while(at+8<b.length){if(b[at++]!==255)continue;let marker=b[at++];while(marker===255)marker=b[at++];if(marker===0xd9||marker===0xda)break;if(marker===1||marker>=0xd0&&marker<=0xd7)continue;const size=v.getUint16(at);if(size<2||at+size>b.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{width:v.getUint16(at+5),height:v.getUint16(at+3)};at+=size;}}
 if(b.length>=30&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'){
  const kind=ascii(12,4);if(kind==='VP8X')return{width:1+b[24]+(b[25]<<8)+(b[26]<<16),height:1+b[27]+(b[28]<<8)+(b[29]<<16)};
  if(kind==='VP8 '&&b[23]===0x9d&&b[24]===1&&b[25]===0x2a)return{width:v.getUint16(26,true)&0x3fff,height:v.getUint16(28,true)&0x3fff};
  if(kind==='VP8L'&&b[20]===0x2f)return{width:1+b[21]+((b[22]&63)<<8),height:1+(b[22]>>6)+(b[23]<<2)+((b[24]&15)<<10)};
 }
 if(mime.includes('svg')){const text=new TextDecoder().decode(b.subarray(0,131072)),tag=text.match(/<svg\b[^>]*>/i)?.[0]||'',box=tag.match(/viewBox\s*=\s*["']([^"']+)/i)?.[1]?.trim().split(/[\s,]+/).map(Number);return{width:Number(tag.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1])||box?.[2]||640,height:Number(tag.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1])||box?.[3]||480};}
 if(mime.includes('avif')){for(let i=4;i+16<b.length&&i<1048576;i++)if(ascii(i,4)==='ispe')return{width:v.getUint32(i+8),height:v.getUint32(i+12)};}
 return null;
}
export async function budgetImage(src){
 try{
  if(!src?.startsWith('data:image/'))throw Error('unsupported image');
  if(src.length>28*1024*1024)throw Error('image too large');
  let blob=await(await fetch(src)).blob();if(blob.size>20*1024*1024||blob.type.includes('avif'))throw Error('image format cannot be bounded safely');
  if(blob.type.includes('svg')){if(blob.size>1024*1024)throw Error('vector image too large');const safe=DOMPurify.sanitize(await blob.text(),{USE_PROFILES:{svg:true},FORBID_TAGS:['script','foreignObject','image','a','style','filter','use','animate','animateTransform','set'],FORBID_ATTR:['style','href','xlink:href']});blob=new Blob([safe],{type:'image/svg+xml'});src=svgUrl(safe);}
  const header=new Uint8Array(await blob.slice(0,1048576).arrayBuffer()),dimensions=imageDimensions(header,blob.type);
  if(!dimensions||!dimensions.width||!dimensions.height||dimensions.width>32768||dimensions.height>32768||dimensions.width*dimensions.height>MAX_SOURCE_PIXELS)throw Error('unsafe image dimensions');
  const pixels=dimensions.width*dimensions.height;if(pixels<=IMAGE_PIXELS&&!blob.type.includes('gif'))return{src,pixels};
  const ratio=Math.min(1,Math.sqrt(IMAGE_PIXELS/pixels)),width=Math.max(1,Math.floor(dimensions.width*ratio)),height=Math.max(1,Math.floor(dimensions.height*ratio));
  const bitmap=await createImageBitmap(blob,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
  try{const canvas=new OffscreenCanvas(width,height);canvas.getContext('2d').drawImage(bitmap,0,0,width,height);const encoded=await canvas.convertToBlob({type:'image/webp',quality:.9});const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(encoded);});return{src:data,pixels:width*height,resized:true};}finally{bitmap.close();}
 }catch{return{src:placeholder('图片过大或格式不支持，原文件仍保留'),pixels:128000,blocked:true};}
}
export async function protectDocumentImages(doc){
 if(doc.imageBudgetVersion===1)return doc;
 const memo=new Map();
 for(const chapter of [...doc.chapters||[],...doc.layoutChapters||[]]){
  if(!chapter.html?.includes('<img'))continue;const dom=new DOMParser().parseFromString(chapter.html,'text/html');let total=0;const decoded=new Set();
  for(const img of dom.querySelectorAll('img')){const src=img.getAttribute('src');let result=memo.get(src);if(!result){result=await budgetImage(src);memo.set(src,result);}if(!decoded.has(result.src)&&total+result.pixels>CHAPTER_PIXELS-128000)result={src:placeholder('本章插图较多，部分图片请查看原文件'),pixels:128000,blocked:true};if(!decoded.has(result.src)){total+=result.pixels;decoded.add(result.src);}img.src=result.src;img.loading='lazy';img.decoding='async';if(result.blocked)img.alt=(img.alt||'图片')+'（超过安全解码限制）';}
  chapter.html=dom.body.innerHTML;await new Promise(r=>setTimeout(r,0));
 }
 if(doc.cover){const result=await budgetImage(doc.cover);doc.cover=result.blocked?'':result.src;}
 doc.imageBudgetVersion=1;return doc;
}
