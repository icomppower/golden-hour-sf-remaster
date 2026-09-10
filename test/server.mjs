import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {'.html':'text/html','.js':'text/javascript','.json':'application/json',
  '.glb':'model/gltf-binary','.ktx2':'image/ktx2','.bin':'application/octet-stream',
  '.png':'image/png','.css':'text/css'};
export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
                        'Cache-Control': 'no-store'});
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(port, () => r({server, port: server.address().port})));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const {port} = await serve(Number(process.argv[2]) || 8099);
  console.log('serving', ROOT, 'on http://localhost:' + port);
}
