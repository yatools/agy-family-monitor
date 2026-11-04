// Optional build-time fallback for Windows Schannel failures. All remote requests
// still use HTTPS to the official crates.io endpoints and Cargo verifies checksums.
import http from 'node:http';
import { spawn } from 'node:child_process';

const port = 18437;
const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (path === '/config.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ dl: `http://127.0.0.1:${port}/crates`, api: 'https://crates.io' }),
      );
      return;
    }
    const crate = /^\/crates\/([\w-]+)\/([\w.+-]+)\/download$/.exec(path);
    const upstream = crate
      ? `https://static.crates.io/crates/${crate[1]}/${crate[1]}-${crate[2]}.crate`
      : /^\/[\w/.-]+$/.test(path)
        ? `https://index.crates.io${path}`
        : null;
    if (!upstream) {
      response.writeHead(400).end();
      return;
    }
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await fetch(upstream, { signal: AbortSignal.timeout(25000) });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    response.writeHead(result.status, {
      'Content-Type': result.headers.get('content-type') ?? 'application/octet-stream',
    });
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(502).end('Official registry unavailable');
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const child = spawn(
  process.platform === 'win32' ? 'cargo.exe' : 'cargo',
  [
    process.argv[2],
    '--config',
    'source.crates-io.replace-with="agy-official-registry"',
    '--config',
    `source.agy-official-registry.registry="sparse+http://127.0.0.1:${port}/"`,
    ...process.argv.slice(3),
  ],
  { stdio: 'inherit', env: { ...process.env, CARGO_HTTP_MULTIPLEXING: 'false' } },
);
child.once('error', (error) => {
  console.error(error.message);
  server.close();
  process.exitCode = 1;
});
child.once('exit', (code) => {
  server.close();
  process.exitCode = code ?? 1;
});
