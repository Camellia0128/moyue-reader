import * as esbuild from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { generateSamples, makeLegacyDoc } from './samples.mjs';
const root=process.cwd(),out=path.join(root,'app/src/main/assets/web');
await mkdir(out,{recursive:true});
// Only clear the generated asset directory, never project sources or user documents.
// Entries are removed one by one: on Windows the sandboxed delete can refuse to move the
// directory itself to the trash while still allowing individual files to go.
async function cleanDir(dir){
  let entries=[];try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
    const full=path.join(dir,entry.name);
    try{await rm(full,{recursive:true,force:true});}catch(error){console.warn('stale asset kept:',entry.name,error.code||error.message);}
  }
}
await cleanDir(out);await mkdir(out,{recursive:true});
// Every @fontsource CJK face ships a woff and a woff2 copy. Android WebView 110+ always speaks
// woff2, so the woff fallback is dead weight — roughly 7 MB of the APK.
const woff2Only={name:'fontsource-woff2-only',setup(build){
  build.onLoad({filter:/@fontsource[\\/].*\.css$/},async args=>{
    const text=await readFile(args.path,'utf8');
    return {contents:text.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g,''),loader:'css',resolveDir:path.dirname(args.path)};
  });
}};
await esbuild.build({entryPoints:['web/app.js'],bundle:true,splitting:true,format:'esm',outdir:out,platform:'browser',target:'chrome110',minify:true,charset:'utf8',legalComments:'eof',loader:{'.woff2':'file','.woff':'file'},assetNames:'fonts/[name]-[hash]',chunkNames:'chunks/[name]-[hash]',plugins:[woff2Only],logLevel:'info'});
await esbuild.build({entryPoints:['web/dict-worker.js'],bundle:true,format:'esm',outfile:path.join(out,'dict-worker.js'),platform:'browser',target:'chrome110',minify:true,charset:'utf8'});
await cp('web/index.html',path.join(out,'index.html'));
await cp('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',path.join(out,'pdf.worker.mjs'));
for(const dir of ['cmaps','standard_fonts','wasm'])await cp('node_modules/pdfjs-dist/'+dir,path.join(out,dir),{recursive:true});
const samples=await generateSamples(path.join(out,'samples'));
await mkdir('tests/fixtures',{recursive:true});for(const [name,bytes]of Object.entries(samples))await writeFile(path.join('tests/fixtures',name),bytes);await writeFile('tests/fixtures/旧版Word.doc',makeLegacyDoc());
const version=JSON.parse(await readFile('package.json','utf8')).version;
const packages=['pdfjs-dist','mammoth','fflate','dompurify','cfb','@fontsource/noto-serif-sc','docx-preview','html2canvas','jszip','css-line-break','text-segmentation','utrie','pako'];let licenses=`墨阅 ${version} — Third-party notices\n\n`;
for(const pkg of packages){const dir=path.join(root,'node_modules',pkg),meta=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));licenses+=`\n\n=== ${pkg} ${meta.version} (${meta.license||'see below'}) ===\n`;for(const name of await readdir(dir)){if(/^(LICENSE|LICENCE|OFL)(\.|$)/i.test(name)){try{licenses+=await readFile(path.join(dir,name),'utf8');}catch{}}}}
await writeFile(path.join(out,'licenses.txt'),licenses);await writeFile('THIRD-PARTY-NOTICES.txt',licenses);
console.log('Offline reader assets built at '+out);
