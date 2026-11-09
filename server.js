#!/usr/bin/env node
'use strict'

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.PORT || 8810)
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1'
const PUBLIC_DIR = path.join(__dirname, 'public')
const DEVICE_USER_AGENT = 'QNXWebClient/1.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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

const server = http.createServer((req, res) => {
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

  handleStatic(req, res, pathname)
})

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`BB10 App Manager (web) listening on http://${LISTEN_HOST}:${PORT}`)
  console.log('Open that address in your browser. Press Ctrl+C to stop.')
})
