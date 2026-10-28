import {chromium} from 'playwright';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}),context=await browser.newContext({viewport:{width:800,height:1067}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));await fs.mkdir('test-results/paper-reader',{recursive:true});
try{
 const target='test-results/paper-reader/scanned-480-pages.pdf';let bytes;
 try{bytes=await fs.readFile(target);}catch{
  await page.goto('http://127.0.0.1:4173');
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),images=[];
  for(let j=0;j<12;j++){
   const data=await page.evaluate(j=>{const c=document.createElement('canvas');c.width=2000;c.height=2800;const ctx=c.getContext('2d'),image=ctx.createImageData(c.width,c.height);let seed=j+1;for(let i=0;i<image.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;const v=195+(seed>>>24)%60;image.data[i]=image.data[i+1]=image.data[i+2]=v;image.data[i+3]=255;}ctx.putImageData(image,0,0);ctx.fillStyle='#222';ctx.font='60px serif';ctx.fillText('Scanned page stress fixture '+(j+1),100,150);ctx.font='32px serif';for(let y=260;y<2600;y+=65)ctx.fillText('This bitmap exercises large scanned pages and bounded rendering.',100,y);return c.toDataURL('image/jpeg',.85).split(',')[1];},j);
   images.push(await pdf.embedJpg(Buffer.from(data,'base64')));
  }
  for(let i=0;i<480;i++){const p=pdf.addPage([595,842]);p.drawImage(images[i%images.length],{x:0,y:0,width:595,height:842});p.drawText('Page '+(i+1),{x:20,y:10,size:10,font,color:rgb(0,0,0)});}
  bytes=await pdf.save();await fs.writeFile(target,bytes);
 }
 assert.ok(bytes.length>10*1024*1024,'Fixture must exceed the old text-export limit');console.log('Fixture '+(bytes.length/1024/1024).toFixed(1)+' MB, 480 pages');
 await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.ReaderApp?.state.books.length===6);await page.locator('#file-picker').setInputFiles(target);await page.waitForFunction(()=>window.ReaderApp.state.books.length===7,{timeout:90000});await page.waitForSelector('.import-status',{state:'detached'});await page.getByRole('button',{name:'阅读 scanned-480-pages',exact:true}).click();await page.waitForFunction(()=>window.ReaderApp.state.pdf?.numPages===480&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.opening,{timeout:90000});
 const timings=[];let maxPixels=0;
 for(let i=0;i<45;i++){
  const t=await page.evaluate(async()=>{const start=performance.now();await window.ReaderApp.turn(1);return performance.now()-start;});timings.push(t);const stats=await page.evaluate(()=>({count:window.ReaderApp.state.pdfCache.size,pixels:[...window.ReaderApp.state.pdfCache.values()].reduce((n,e)=>{const c=e.querySelector('canvas');return n+(c?c.width*c.height:0);},0)}));assert.ok(stats.count<=2);assert.ok(stats.pixels<=8010000);maxPixels=Math.max(maxPixels,stats.pixels);
 }
 await page.evaluate(()=>window.ReaderApp.flush());await page.reload();await page.waitForFunction(()=>window.ReaderApp?.state.pdfPage===45&&!window.ReaderApp.state.busy&&!window.ReaderApp.state.opening,{timeout:90000});assert.deepEqual(errors,[]);
 const backupSize=await page.evaluate(async()=>{const b=await window.ReaderApp.createBackup();return b.size;});assert.ok(backupSize>10*1024*1024);
 const report={pages:480,sizeBytes:bytes.length,turns:45,medianTurnMs:timings.sort((a,b)=>a-b)[22],maxTurnMs:Math.max(...timings),maxCachedPixels:maxPixels,cacheLimit:2,backupBytes:backupSize,progressRestored:true,errors,environment:'Chromium desktop, 800×1067 CSS pixels; not a tablet battery test'};await fs.writeFile('test-results/paper-reader/large-pdf.json',JSON.stringify(report,null,2));console.log('PASS '+JSON.stringify(report));
}finally{await browser.close();}
