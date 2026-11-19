#!/usr/bin/env node
'use strict'

const http = require('http')
const https = require('https')
const net = require('net')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { createBackupHandler } = require('./bb-backup')

const PORT = Number(process.env.PORT || 8810)
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1'
const PUBLIC_DIR = path.join(__dirname, 'public')
const ARTIFACTS_DIR = path.join(__dirname, 'var', 'artifacts')
const BACKUPS_DIR = path.join(__dirname, 'var', 'backups')
const DEVICE_USER_AGENT = 'QNXWebClient/1.0'
const TERM49_WEB_PORT = 7681
const handleBackupRoute = createBackupHandler(BACKUPS_DIR, {
  sharedCookie (host) {
    return cookieHeader(host)
  },
  adoptCookie (host, cookie) {
    const jar = getJar(host)
    for (const part of String(cookie).split('; ')) {
      const eq = part.indexOf('=')
      if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }
})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const cookieJars = new Map()

function getJar (host) {
  let jar = cookieJars.get(host)
  if (!jar) {
    jar = new Map()
    cookieJars.set(host, jar)
  }
  return jar
}

function storeCookies (host, setCookie) {
  if (!setCookie) return
  const jar = getJar(host)
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const raw of list) {
    const parts = String(raw).split(';')
    const pair = parts[0]
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    let expired = false
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].trim()
      const lower = attr.toLowerCase()
      if (lower === 'max-age=0') expired = true
      else if (lower.startsWith('max-age=')) {
        const secs = Number(attr.slice(8))
        if (!Number.isNaN(secs) && secs <= 0) expired = true
      } else if (lower.startsWith('expires=')) {
        const when = Date.parse(attr.slice(8))
        if (!Number.isNaN(when) && when <= Date.now()) expired = true
      }
    }
    if (!name) continue
    if (expired || value === 'deleted' || value === '') jar.delete(name)
    else jar.set(name, value)
  }
}

function cookieHeader (host) {
  const jar = cookieJars.get(host)
  if (!jar || jar.size === 0) return null
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ')
}

function parseProxyTarget (url) {
  const prefix = '/proxy/'
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length)
  const slash = rest.indexOf('/')
  const encodedHost = slash < 0 ? rest : rest.slice(0, slash)
  const targetPath = slash < 0 ? '/' : rest.slice(slash)
  let host
  try {
    host = decodeURIComponent(encodedHost)
  } catch (err) {
    return { error: 'Invalid host encoding' }
  }
  if (!host) return { error: 'Missing device host' }
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(host)) return { error: 'Invalid device host' }
  return { host, targetPath }
}

function parseTermTarget (url) {
  const prefix = '/term/'
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length)
  const slash = rest.indexOf('/')
  const encodedHost = slash < 0 ? rest : rest.slice(0, slash)
  const targetPath = slash < 0 ? '/' : rest.slice(slash)
  let host
  try {
    host = decodeURIComponent(encodedHost)
  } catch (err) {
    return { error: 'Invalid host encoding' }
  }
  if (!host) return { error: 'Missing device host' }
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(host)) return { error: 'Invalid device host' }
  return { host, targetPath }
}

function hostnameFromHostHeader (value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end >= 0 ? raw.slice(0, end) : raw
  }
  const first = raw.indexOf(':')
  const last = raw.lastIndexOf(':')
  if (first > 0 && first === last) return raw.slice(0, first)
  return raw
}

function isAllowedLocalHost (req) {
  const name = hostnameFromHostHeader(req.headers.host).toLowerCase()
  const allow = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  if (LISTEN_HOST !== '0.0.0.0' && LISTEN_HOST !== '::') {
    allow.add(String(LISTEN_HOST).toLowerCase())
  }
  if (allow.has(name)) return true
  return LISTEN_HOST === '0.0.0.0' || LISTEN_HOST === '::'
}

function isSameOrigin (origin, hostHeader) {
  try {
    const parsed = new URL(origin)
    return parsed.host.toLowerCase() === String(hostHeader || '').toLowerCase()
  } catch (err) {
    return false
  }
}

function proxyTermRequest (req, res, target) {
  if (!isAllowedLocalHost(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('Method not allowed')
    return
  }

  const { host, targetPath } = target
  const hostname = host.replace(/^\[|\]$/g, '')

  const headers = Object.assign({}, req.headers)
  delete headers.cookie
  delete headers.origin
  delete headers.referer
  headers.host = host + ':' + TERM49_WEB_PORT
  headers.connection = 'close'

  let proxyReq
  try {
    proxyReq = http.request({
      hostname,
      port: TERM49_WEB_PORT,
      method: req.method,
      path: targetPath,
      headers
    }, (proxyRes) => {
      const outHeaders = Object.assign({}, proxyRes.headers)
      delete outHeaders.connection
      delete outHeaders['keep-alive']
      delete outHeaders['transfer-encoding']
      res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, outHeaders)
      proxyRes.pipe(res)
      proxyRes.on('error', () => res.destroy())
    })
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Terminal proxy setup failed: ' + err.message)
    return
  }

  proxyReq.setTimeout(8000, () => proxyReq.destroy(new Error('timeout')))
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    res.end('Could not reach term49-web on ' + host + ':' + TERM49_WEB_PORT + ': ' + err.message)
  })
  proxyReq.end()
}

function handleTermUpgrade (req, socket, head) {
  const target = parseTermTarget(req.url || '')
  if (!target || target.error) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (target.targetPath !== '/ws' && target.targetPath !== '/ws/') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (!isAllowedLocalHost(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (req.headers.origin && !isSameOrigin(req.headers.origin, req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  const hostname = target.host.replace(/^\[|\]$/g, '')
  let upstream
  try {
    upstream = net.connect(TERM49_WEB_PORT, hostname)
  } catch (err) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  let connected = false

  upstream.setNoDelay(true)
  upstream.setTimeout(10000, () => upstream.destroy(new Error('timeout')))

  upstream.on('connect', () => {
    connected = true
    upstream.setTimeout(0)

    const wsKey = String(req.headers['sec-websocket-key'] || '')
    const wsVersion = String(req.headers['sec-websocket-version'] || '13')
    if (!wsKey) {
      upstream.destroy()
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const targetHost = target.host + ':' + TERM49_WEB_PORT
    const lines = [
      'GET /ws HTTP/1.1',
      'Host: ' + targetHost,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + wsKey,
      'Sec-WebSocket-Version: ' + wsVersion,
      'Origin: http://' + targetHost
    ]
    if (req.headers['sec-websocket-protocol']) {
      lines.push('Sec-WebSocket-Protocol: ' + req.headers['sec-websocket-protocol'])
    }
    if (req.headers['user-agent']) {
      lines.push('User-Agent: ' + req.headers['user-agent'])
    }
    lines.push('', '')

    upstream.write(lines.join('\r\n'))
    if (head && head.length) upstream.write(head)

    upstream.pipe(socket)
    socket.pipe(upstream)
  })

  upstream.on('error', (err) => {
    if (!socket.destroyed) {
      if (!connected) {
        socket.write(
          'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n' +
          'Could not reach term49-web on ' + target.host + ':' + TERM49_WEB_PORT + '. ' +
          'Start it on the device with: term49-web'
        )
      }
      socket.destroy()
    }
  })

  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
}

function setCors (headers) {
  headers['access-control-allow-origin'] = '*'
  headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
  headers['access-control-allow-headers'] = '*'
}

function proxyRequest (req, res, target) {
  if (req.method === 'OPTIONS') {
    const headers = {}
    setCors(headers)
    res.writeHead(204, headers)
    res.end()
    return
  }

  const { host, targetPath } = target

  let targetUrl
  try {
    targetUrl = new URL('https://' + host + targetPath)
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Invalid device address')
    return
  }

  const headers = Object.assign({}, req.headers)
  delete headers.host
  delete headers.cookie
  delete headers.origin
  delete headers.referer
  headers.host = targetUrl.host
  headers['user-agent'] = DEVICE_USER_AGENT
  headers['accept-encoding'] = 'identity'

  const cookie = cookieHeader(host)
  if (cookie) headers.cookie = cookie

  let proxyReq
  try {
    proxyReq = https.request({
      hostname: targetUrl.hostname.replace(/^\[|\]$/g, ''),
      port: targetUrl.port || 443,
      method: req.method,
      path: targetUrl.pathname + targetUrl.search,
      headers,
      rejectUnauthorized: false,
      minVersion: 'TLSv1',
      ciphers: 'DEFAULT:@SECLEVEL=0',
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
    }, (proxyRes) => {
      storeCookies(host, proxyRes.headers['set-cookie'])

      const outHeaders = Object.assign({}, proxyRes.headers)
      delete outHeaders['set-cookie']
      delete outHeaders.connection
      delete outHeaders['keep-alive']
      delete outHeaders['transfer-encoding']

      const contentType = String(outHeaders['content-type'] || '')
      if (!/xml/i.test(contentType)) {
        outHeaders['content-type'] = 'application/octet-stream'
      }
      setCors(outHeaders)

      res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, outHeaders)
      proxyRes.pipe(res)
      proxyRes.on('error', () => res.destroy())
    })
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Proxy setup failed: ' + err.message)
    return
  }

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, Object.assign({
        'content-type': 'text/plain; charset=utf-8'
      }, {}))
    }
    res.end('Could not reach device ' + host + ': ' + err.message)
  })

  req.on('aborted', () => proxyReq.destroy())
  req.pipe(proxyReq)
}

function sendFile (res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': 'no-cache'
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

function sendArtifact (req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('Method not allowed')
    return
  }
  let rel = pathname.slice('/artifacts/'.length)
  try {
    rel = decodeURIComponent(rel)
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad request')
    return
  }
  if (!rel || rel.includes('..') || rel.includes('/') || rel.includes('\\')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad artifact name')
    return
  }
  const filePath = path.join(ARTIFACTS_DIR, rel)
  if (!filePath.startsWith(ARTIFACTS_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Artifact not found. Build it with tools/build-pi-package.sh.')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath).pipe(res)
  })
}

function handleStatic (req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  try {
    rel = decodeURIComponent(rel)
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad request')
    return
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel))
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  sendFile(res, filePath)
}

function routeRequest (req, res) {
  const fullUrl = req.url || '/'
  const queryIndex = fullUrl.indexOf('?')
  const pathname = queryIndex < 0 ? fullUrl : fullUrl.slice(0, queryIndex)

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('ok')
    return
  }

  if (pathname.startsWith('/proxy/')) {
    const target = parseProxyTarget(fullUrl)
    if (!target || target.error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(target ? target.error : 'Bad proxy URL')
      return
    }
    proxyRequest(req, res, target)
    return
  }

  if (pathname.startsWith('/term/')) {
    const target = parseTermTarget(fullUrl)
    if (!target || target.error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(target ? target.error : 'Bad terminal URL')
      return
    }
    proxyTermRequest(req, res, target)
    return
  }

  if (pathname.startsWith('/artifacts/')) {
    sendArtifact(req, res, pathname)
    return
  }

  handleStatic(req, res, pathname)
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleBackupRoute(req, res))
    .then((handled) => {
      if (!handled) routeRequest(req, res)
    })
    .catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('Internal error: ' + err.message)
    })
})

server.on('upgrade', (req, socket, head) => {
  const fullUrl = req.url || '/'
  const queryIndex = fullUrl.indexOf('?')
  const pathname = queryIndex < 0 ? fullUrl : fullUrl.slice(0, queryIndex)
  if (pathname.startsWith('/term/')) {
    handleTermUpgrade(req, socket, head)
    return
  }
  socket.destroy()
})

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`BB10 App Manager (web) listening on http://${LISTEN_HOST}:${PORT}`)
  console.log('Open that address in your browser. Press Ctrl+C to stop.')
})
