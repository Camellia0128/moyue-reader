import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as CFB from 'cfb';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const paragraphs=[
  '清晨醒来，窗外的山还藏在薄雾里。昨夜的一场小雨，把院子里的石阶洗得发亮。我推开窗，一阵带着草木气息的风吹进来，屋子也仿佛跟着醒了。',
  '沿着门前的小路往上走，树林渐渐密起来。树叶上的水珠偶尔落下，落在肩头，也落在安静的泥土上。远处传来几声鸟鸣，随后又是一段长长的寂静。',
  '我在一块平整的石头上坐下，看阳光一点点穿过枝叶。那些平日里急着寻找答案的问题，此刻忽然没有那么要紧了。山里的时间很慢，慢得足够让人把一口气呼吸完整。',
  '回去的时候，炊烟已经从屋顶升起。有人在院子里晾衣服，有人提着篮子经过小桥。一天就这样开始了，没有特别的仪式，却让人觉得踏实。',
  '午后的阳光落在窗台上，山风翻动着桌边的书页。我泡了一壶茶，坐在院子的木椅上，听风穿过树梢的声音。远处的山依旧安静，偶尔有云影从峰顶掠过，投下淡淡的阴影。',
  '不一会儿，村里的小路上传来脚步声。是邻居张叔挑着一担新摘的菜，笑着和我打了个招呼。我们在院子里聊了几句，关于今年的雨水，关于山上的野花，也关于镇上新开的集市。',
  '傍晚时，天边的云被落日染成了浅金色。山谷里升起一层薄薄的烟雾，几户人家的灯火陆续亮起。远处传来狗吠声，又渐渐归于平静。',
  '我收起书，走到院门口，望着渐暗的山林。一天的时光就这样慢慢沉淀下来，像山间的风，轻轻吹过，却留在了心里。',
];
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
export function makeEpub(title='山间来信',chapterNames=['第一章 山路','第二章 一封来信','第三章 林中的清晨','第四章 傍晚的灯火']) {
  const files={mimetype:strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')};
  files['OEBPS/content.opf']=strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">moyue-${title}</dc:identifier><dc:title>${title}</dc:title><dc:creator>墨阅示例</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-10-27T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>${chapterNames.map((_,i)=>`<item id="c${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapterNames.map((_,i)=>`<itemref idref="c${i}"/>`).join('')}</spine></package>`);
  files['OEBPS/nav.xhtml']=strToU8(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${chapterNames.map((name,i)=>`<li><a href="chapter${i}.xhtml#start">${name}</a></li>`).join('')}</ol></nav></body></html>`);
  for(let i=0;i<chapterNames.length;i++)files[`OEBPS/chapter${i}.xhtml`]=strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapterNames[i]}</title></head><body><h2 id="start">${chapterNames[i]}</h2>${Array.from({length:38},(_,j)=>`<p>${paragraphs[(j+i*2)%paragraphs.length]}</p>`).join('')}<p>本节完。<a href="chapter${(i+1)%chapterNames.length}.xhtml#start">继续阅读下一节</a></p></body></html>`);
  return zipSync(files,{level:6});
}
export function makeDocx(title='墨阅使用指南'){
  const files={
    '[Content_Types].xml':strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'word/styles.xml':strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>')
  };
  const p=(text,heading=false)=>`<w:p>${heading?'<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>':''}<w:r><w:t>${escape(text)}</w:t></w:r></w:p>`;
  files['word/document.xml']=strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p(title,true)}${p('欢迎使用墨阅。这是一份真正的 DOCX 示例文件，用于介绍阅读器的基本功能。')}${p('导入与本地书库',true)}${p('点击书库顶部的导入，可以选择 PDF、EPUB、Word、TXT、Markdown 和 HTML 文件。书籍导入后会保存在本机，离线也可以打开。重复导入相同内容时会自动跳过。')}${p('翻页与排版',true)}${p('点屏幕顶部展开工具栏。点左边缘返回上一页，点正文的大部分区域进入下一页。也可以滑动翻页，或使用设备音量键。')}${p('点击 Aa 可以设置字体、字号、字重、行距、边距和页面主题。排版改变后会保留当前文字位置。')}${p('格式支持',true)}<w:tbl>${[['格式','阅读方式'],['EPUB / TXT','重新分页，可调整字号'],['PDF','保留原版，可缩放与旋转'],['DOCX','段落、标题、表格与图片'],['DOC','提取正文阅读']].map(row=>`<w:tr>${row.map(t=>`<w:tc>${p(t)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>${p('划线、笔记与书签',true)}${p('长按文字选择内容，可以划线、添加笔记或复制。书签用于记录当前阅读位置；所有笔记都可以导出为 Markdown。扫描 PDF 如果没有文字层，则无法选择和搜索。')}${p('保护自己的阅读记录',true)}${p('应用不需要网络权限，不上传文件。卸载应用或清除应用数据会删除本地副本与记录，请保留原始文件并导出重要笔记。')}<w:sectPr/></w:body></w:document>`);
  return zipSync(files,{level:6});
}
export function makeLegacyDoc(text='旧版 Word 文档测试。\r这是第二段正文。\r'){
  const bytes=Buffer.from(text,'utf16le'),word=Buffer.alloc(4096+bytes.length);word.writeUInt16LE(0xa5ec,0);word.writeUInt16LE(0x00c1,2);word.writeUInt16LE(0x0200,10);word.writeUInt32LE(512,24);word.writeUInt32LE(512+bytes.length,28);word.writeUInt16LE(14,32);word.writeUInt16LE(22,62);word.writeUInt32LE(text.length,76);word.writeUInt16LE(93,152);word.writeUInt32LE(0,418);word.writeUInt32LE(21,422);bytes.copy(word,512);
  const table=Buffer.alloc(21);table[0]=2;table.writeUInt32LE(16,1);table.writeUInt32LE(0,5);table.writeUInt32LE(text.length,9);table.writeUInt32LE(512,15);
  const ole=CFB.utils.cfb_new();CFB.utils.cfb_add(ole,'WordDocument',word);CFB.utils.cfb_add(ole,'1Table',table);return CFB.write(ole,{type:'buffer'});
}
export async function makePdf(){
  const pdf=await PDFDocument.create();pdf.setTitle('城市与步行');pdf.setAuthor('墨阅示例');const serif=await pdf.embedFont(StandardFonts.TimesRoman),sans=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const text='A walk begins with a little attention. The shade of a tree, a bench beside a shop and the space between two buildings can change how a street feels. Walking lets us notice what speed usually hides. A comfortable city leaves room for people to pause, look around and meet one another.';
  for(let pageIndex=0;pageIndex<8;pageIndex++){
    const page=pdf.addPage([595,842]);page.drawText('WALKING THE CITY',{x:52,y:770,size:26,font:bold,color:rgb(.13,.14,.12)});page.drawText('Notes on streets, shade and everyday life',{x:53,y:744,size:11,font:sans});page.drawLine({start:{x:52,y:725},end:{x:543,y:725},thickness:.7,color:rgb(.5,.5,.47)});
    const heading=['01  Begin at the corner','02  Leave room to pause','03  Under the shade','04  The everyday street'][pageIndex%4];page.drawText(heading,{x:52,y:690,size:17,font:bold});
    for(let column=0;column<2;column++){
      const words=(text+' '+text).split(' ');let line='',y=660;for(const word of words){const next=line?line+' '+word:word;if(serif.widthOfTextAtSize(next,11)>224){page.drawText(line,{x:52+column*255,y,size:11,font:serif});y-=17;line=word;}else line=next;}if(line)page.drawText(line,{x:52+column*255,y,size:11,font:serif});
    }
    page.drawRectangle({x:52,y:190,width:491,height:190,color:rgb(.94,.94,.91)});
    for(let i=0;i<7;i++){const x=65+i*69,h=65+(i%3)*25;page.drawRectangle({x,y:225,width:52,height:h,borderColor:rgb(.3,.32,.28),borderWidth:.7,color:rgb(.86,.87,.83)});for(let j=0;j<3;j++)page.drawLine({start:{x:x+8,y:238+j*15},end:{x:x+44,y:238+j*15},thickness:.5,color:rgb(.4,.42,.38)});}
    page.drawLine({start:{x:52,y:218},end:{x:543,y:218},thickness:2});page.drawText('A street is a place to live, not only a place to pass through.',{x:52,y:164,size:10,font:serif});page.drawText(String(pageIndex+1),{x:294,y:47,size:10,font:sans});
  }
  return await pdf.save();
}
export async function generateSamples(dir){await mkdir(dir,{recursive:true});const samples={
  '山间来信.epub':makeEpub(),
  '海边的一天.epub':makeEpub('海边的一天',['第一章 海风','第二章 慢下来的午后','第三章 归途']),
  '墨阅使用指南.docx':makeDocx(),
  '城市与步行.pdf':await makePdf(),
  '日常的秩序.txt':strToU8('日常的秩序\n\n第一章 留白\n'+paragraphs.join('\n\n')+'\n\n第二章 慢一点\n'+paragraphs.slice().reverse().join('\n\n')),
  '阅读摘录.html':strToU8('<!doctype html><html><head><title>阅读摘录</title></head><body><h2>读书时，留下一点回声</h2><p>这是一份 HTML 文档示例，可以像电子书一样调整排版。</p><blockquote>阅读使我们有机会，在自己的生活之外，多走几段路。</blockquote><p>长按这一段文字，试着划线或写下笔记。所有摘录都可以从阅读工具栏导出。</p></body></html>')
};for(const [name,bytes]of Object.entries(samples))await writeFile(path.join(dir,name),bytes);await writeFile(path.join(dir,'index.json'),JSON.stringify(Object.keys(samples)));return samples;}
