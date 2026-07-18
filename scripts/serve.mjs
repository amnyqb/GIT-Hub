import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root=process.cwd();
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.bin':'application/octet-stream','.png':'image/png'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  const fp=path.join(root,p);
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('nf');return;}
    res.writeHead(200,{'content-type':types[path.extname(fp)]||'application/octet-stream'}); res.end(d);});
}).listen(8099,()=>console.log('serving on 8099'));
