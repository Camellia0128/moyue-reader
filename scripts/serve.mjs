import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('app/src/main/assets/web');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.wasm':'application/wasm','.svg':'image/svg+xml','.pdf':'application/pdf'};
const server=http.createServer((req,res)=>{let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));}catch{res.writeHead(400).end();return;}if(file===root)file=path.join(root,'index.html');if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('Reader QA: http://127.0.0.1:'+(process.env.PORT||4173)));
