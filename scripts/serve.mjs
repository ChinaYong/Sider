import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(workspace, 'dist');
const demoRoot = resolve(workspace, 'demo');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function contained(root, path) {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  try {
    const rawPath = (request.url || '/').split('?')[0];
    const pathname = decodeURIComponent(rawPath);
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const isDemo = pathname.startsWith('/demo/');
    const root = isDemo ? demoRoot : distRoot;
    const requested = isDemo ? pathname.slice('/demo/'.length) : pathname === '/' ? 'panel.html' : pathname.slice(1);
    const candidate = resolve(root, requested);
    if (!contained(root, candidate)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const resolvedRoot = await realpath(root);
    const resolvedCandidate = await realpath(candidate);
    if (!contained(workspace, resolvedRoot) || !contained(resolvedRoot, resolvedCandidate)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (!(await stat(resolvedCandidate)).isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    const body = await readFile(resolvedCandidate);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(resolvedCandidate)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const status = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error instanceof URIError ? 400 : 500;
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(status === 404 ? 'Not found. Run npm run build before previewing.' : status === 400 ? 'Bad request' : 'Server error');
  }
});

server.on('error', (error) => {
  console.error(`预览服务启动失败：${error.message}`);
  process.exitCode = 1;
});

server.listen(4173, '127.0.0.1', () => {
  console.log('Sider 演示侧栏：http://127.0.0.1:4173/');
  console.log('示例文章：http://127.0.0.1:4173/demo/article.html');
});
