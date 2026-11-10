/* =====================================================================
 *  serve.mjs - a static file server for local development.
 * ---------------------------------------------------------------------
 *  You cannot open this app by double-clicking login.html.
 *
 *  A page loaded from file:// is served with `Origin: null`, so the
 *  browser can never match it against the Edge Function's origin
 *  allowlist, and every call to auth-admin is discarded before the page
 *  can read it. The symptom is a bare "Failed to fetch" with no HTTP
 *  status and no server message, which looks exactly like being offline.
 *  Adding "null" or "file://" to ENT_ALLOWED_ORIGIN does NOT fix it and
 *  is not a thing the server should ever be told.
 *
 *  Serving the same folder over http://localhost:5500 gives the page a
 *  real origin, which is the one the allowlist already expects.
 *
 *  No dependencies - Node 18+ only. Nothing here is deployed; this file
 *  is a development convenience and is not part of the app.
 *
 *  Run:  node serve.mjs          then open http://localhost:5500/pages/login.html
 *        node serve.mjs 8080     to use a different port
 * ===================================================================== */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2]) || 5500

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
}

const server = createServer((req, res) => {
  let pathname = decodeURIComponent((req.url || '/').split('?')[0])
  if (pathname === '/') pathname = '/index.html'

  // Contain everything under ROOT: no ../ escapes.
  const target = resolve(join(ROOT, normalize(pathname)))
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return res.end('403 Forbidden')
  }

  // Refuse anything that is not part of the deployed app. Without this the
  // server happily hands out supabase-v2/scripts/.env.local, which holds the
  // SERVICE-ROLE key, to anything that can reach localhost:5500. That key
  // bypasses RLS entirely, so serving it is never acceptable - not even in
  // development, and not even on loopback.
  const rel = target.slice(ROOT.length + 1).split(sep)
  const blocked =
    rel.some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..') ||
    rel[0] === 'node_modules' ||
    /^(supabase-v2[\\/])?scripts$/i.test(rel[0] || '') ||
    (rel[0] === 'supabase-v2' && /^(scripts|backup)$/i.test(rel[1] || '')) ||
    /\.(bak|log|err|sql|mjs|ps1|py|txt)$/i.test(target)
  if (blocked) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return res.end('403 Forbidden: not a public app file')
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('404 Not Found: ' + pathname)
  }

  const type = TYPES[extname(target).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    // The service worker is the point of this app offline, but a stale one
    // is how an old auth.js keeps serving. No-cache in development only.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  })
  createReadStream(target).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  ENT Records v2 - local server')
  console.log('  ----------------------------')
  console.log('  root    : ' + ROOT)
  console.log('  serving : http://localhost:' + PORT + '/')
  console.log('')
  console.log('  Open this, NOT the .html file directly:')
  console.log('    http://localhost:' + PORT + '/              (index.html, the menu)')
  console.log('    http://localhost:' + PORT + '/pages/login.html')
  console.log('')
  console.log('  Every page except index.html is in pages/. An ERR_FILE_NOT_FOUND')
  console.log('  means the file is being opened directly, or an old URL without')
  console.log('  the pages/ prefix is being used.')
  console.log('')
  console.log('  If the Edge Function refuses this origin, allow it once:')
  console.log('    supabase secrets set ENT_ALLOWED_ORIGIN=http://localhost:' + PORT)
  console.log('')
  console.log('  Ctrl+C to stop.')
  console.log('')
})
