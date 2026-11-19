#!/usr/bin/env node
'use strict'

// BB10 / PlayBook backup & restore engine.
//
// Talks to the device management CGI service (the same endpoints BlackBerry
// Link and Sachesi use) over the USB/Wi-Fi network interface:
//
//   GET  http://<host>/cgi-bin/discovery.cgi          device info (HTTP, port 80)
//   GET  https://<host>/cgi-bin/login.cgi             SHA-512 challenge/response login
//   POST https://<host>/cgi-bin/backup.cgi            backup / restore control + tar streams
//   POST https://<host>/cgi-bin/dynamicProperties.cgi device properties
//
// A backup file (.bbb) is a ZIP (zip64-capable, store method) containing
// Manifest.xml and Archive/<category>.tar with the raw tar streams produced by
// the device. Restore uploads those tar streams back verbatim.

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { once } = require('events')
const { Transform, PassThrough } = require('stream')

const DEVICE_USER_AGENT = 'QNXWebClient/1.0'
const CATEGORY_ORDER = ['app', 'media', 'settings']
const CATEGORY_NAMES = {
  app: 'Application Data',
  media: 'Media',
  settings: 'Device Settings and Local Contacts/Calendar Data'
}
const PKG_TYPES = ['system', 'data', 'bin']

const TLS_OPTIONS = {
  rejectUnauthorized: false,
  minVersion: 'TLSv1',
  ciphers: 'DEFAULT:@SECLEVEL=0',
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
}

// Device service ports. Overridable for testing against a mock device.
const DEVICE_HTTP_PORT = Number(process.env.BB10_DEVICE_HTTP_PORT || 80)
const DEVICE_HTTPS_PORT = Number(process.env.BB10_DEVICE_HTTPS_PORT || 443)

// Device request/response traffic is logged to var/backups/wire-<host>.log by
// default (BB10_BACKUP_DEBUG=0 disables) — the protocol is undocumented and
// per-firmware, so the log is the primary diagnostic.
const DEBUG_WIRE = process.env.BB10_BACKUP_DEBUG !== '0'
let WIRE_DIR = null
function wire (host, direction, details) {
  if (!DEBUG_WIRE || !WIRE_DIR) return
  const slug = String(host).replace(/[^A-Za-z0-9._-]/g, '_')
  const line = new Date().toISOString() + ' [' + direction + '] ' + details + '\n'
  fs.appendFile(path.join(WIRE_DIR, 'wire-' + slug + '.log'), line, () => { })
}

class BackupError extends Error {}
class AuthRequiredError extends BackupError {}
class AuthFailedError extends BackupError {}
class BusyError extends BackupError {}
class CancelledError extends BackupError {}

// Thrown when a rev2-specific request is refused and the whole backup attempt
// should be restarted with the legacy protocol.
class FallbackNeededError extends BackupError {}

function crcTable () {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
}
const CRC_TABLE = crcTable()

function crc32 (crc, buf) {
  crc = ~crc
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}

function xmlText (xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)</' + tag + '>', 'i'))
  return m ? m[1] : null
}

function xmlHas (xml, tag) {
  return new RegExp('<' + tag + '(?:\\s[^>]*)?[/>]', 'i').test(xml)
}

function decodeXmlEntities (text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

function escapeXml (text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function xmlTagAttrs (xml) {
  const out = []
  const re = /<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*\/?>/g
  let m
  while ((m = re.exec(xml))) {
    const attrs = {}
    const are = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let a
    while ((a = are.exec(m[2]))) {
      attrs[a[1].toLowerCase()] = decodeXmlEntities(a[2] !== undefined ? a[2] : a[3])
    }
    out.push({ tag: m[1], attrs })
  }
  return out
}

function briefXmlError (xml) {
  const text = xmlErrorText(xml)
  return text ? String(text).trim() : ''
}

// True device errors carry an <Error>/<ErrorDescription> element or a
// <Status>Error</Status>. Only consulted when an expected success element is
// absent: some firmwares emit empty <Error></Error> placeholders inside
// perfectly successful responses.
function xmlErrorText (xml) {
  const desc = xmlText(xml, 'ErrorDescription')
  if (desc !== null && desc.trim() !== '') return desc
  const m = xml.match(/<Error(?:\s[^>]*)?>([^<]*)<\/Error>/i)
  if (m && m[1].trim() !== '') return m[1]
  const status = xmlText(xml, 'Status')
  if (status !== null && /^error$/i.test(status.trim())) return 'device reported Error status'
  return null
}

function xmlSnippet (xml) {
  return String(xml).replace(/\s+/g, ' ').trim().slice(0, 400)
}

// The device normally answers a category request with the raw tar stream, but
// errors arrive as XML (sometimes with a text/xml content-type, sometimes with
// octet-stream). Pull the first chunk through the response's own async iterator
// (no pause/resume games, so completion propagates naturally) and only hand out
// a stream once the first byte is confirmed binary. Nothing has been written to
// the ZIP at that point, so a rejection can be retried safely.
// Per-category sizes from an activity-style report (<App>123</App> ...).
function parseActivitySizes (xml) {
  const sizes = {}
  for (const c of CATEGORY_ORDER) {
    const v = parseInt(xmlText(xml, c.charAt(0).toUpperCase() + c.slice(1)), 10)
    if (Number.isFinite(v) && v > 0) sizes[c] = v
  }
  return sizes
}

// Answers one category request. Returns { stream } once the device sends
// binary tar data, { pending: true } for <Status>InProgress</Status> ("still
// packaging, ask again"), { ready: true, sizes } for a Status Ready activity
// report ("data is packaged, perform the get"), or throws for genuine
// refusals.
async function openCategoryStreamOnce (job, session, cat, body, cookieJar, reqPath, method) {
  const res = await deviceRequest(job.host, {
    method: method || 'POST',
    path: reqPath || '/cgi-bin/backup.cgi',
    body: body === null ? undefined : body,
    cookie: session.cookie,
    cookieJar,
    stream: true,
    timeout: 300000,
    onRequest: (rq) => { job.currentReq = rq }
  })
  const ctype = String(res.headers['content-type'] || '')
  const iterator = res[Symbol.asyncIterator]()
  let first
  try {
    first = await iterator.next()
  } catch (err) {
    res.destroy()
    throw err
  }
  if (first.done || !first.value.length || first.value[0] === 0x3c || /xml|text/i.test(ctype)) {
    let detail = first.done ? '' : first.value
    try {
      for (;;) {
        const n = await iterator.next()
        if (n.done) break
        if (!detail) detail = n.value
        else if (detail.length < 65536) detail = Buffer.concat([detail, n.value])
      }
    } catch (err) { }
    res.destroy()
    const xml = detail && detail.length ? detail.toString('latin1') : ''
    // Element identity first: a BackupCheck means "proceed with the get"
    // even though Sachesi-style responses carry Status InProgress.
    if (/<BackupCheck[\s>]/i.test(xml)) {
      return { ready: true, sizes: parseActivitySizes(xml) }
    }
    if (/<Status>\s*InProgress\s*<\/Status>/i.test(xml)) {
      return { pending: true, sizes: parseActivitySizes(xml) }
    }
    if (/<BackupStartActivity[\s>]/i.test(xml)) {
      return { ready: true, sizes: parseActivitySizes(xml) }
    }
    const err = new BackupError('Device refused to send ' + cat +
      (res.statusCode && res.statusCode !== 200 ? ' (HTTP ' + res.statusCode + ')' : '') + ': ' +
      (xml ? xmlSnippet(xml) : '(empty response' +
        (res.statusCode ? ', HTTP ' + res.statusCode : '') +
        (res.headers['content-type'] ? ', ' + res.headers['content-type'] : '') +
        (res.headers['content-length'] !== undefined ? ', length ' + res.headers['content-length'] : '') +
        (res.headers['transfer-encoding'] ? ', ' + res.headers['transfer-encoding'] : '') +
        ')'))
    err.xmlResponse = true
    // This firmware names the per-category parameter "mode", not "type":
    // <Error>'mode' attribute missing. Should be one of: 'app', 'media'...</Error>
    if (/'mode' attribute missing/i.test(xml)) err.useModeParam = true
    throw err
  }
  wire(job.host, '<-', 'stream ' + cat + ': first byte 0x' + first.value[0].toString(16) + ', chunk ' + first.value.length + 'B')
  const out = new PassThrough()
  out.write(first.value)
  ;(async () => {
    try {
      for (;;) {
        const n = await iterator.next()
        if (n.done) {
          out.end()
          return
        }
        if (!out.write(n.value)) await once(out, 'drain')
      }
    } catch (err) {
      out.destroy(err)
    }
  })()
  return { stream: out }
}

function normalizeHost (host) {
  let h = String(host || '').trim().replace(/^\[|\]$/g, '')
  const m = h.match(/^([^:]+):(\d+)$/)
  if (m) h = m[1]
  return h
}

function validHost (host) {
  return /^[A-Za-z0-9._:[\]-]+$/.test(host)
}

function formatStamp (date) {
  const p = (n) => String(n).padStart(2, '0')
  return '' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
    '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
}

// Iterated SHA-512 login hash (little-endian counter || salt || rolling hash).
function hashPass (password, challenge, salt, iterations) {
  let hashed = Buffer.from(password, 'latin1')
  let count = 0
  let challenger = true
  for (;;) {
    const counter = Buffer.alloc(4)
    counter.writeInt32LE(count, 0)
    const buf = Buffer.concat([counter, salt, hashed])
    hashed = crypto.createHash('sha512').update(buf).digest()
    if (count === iterations - 1 && challenger) {
      count = -1
      challenger = false
      hashed = Buffer.concat([Buffer.from(challenge, 'latin1'), hashed])
    }
    if (++count >= iterations) break
  }
  return hashed
}

function deviceRequest (host, options) {
  const method = options.method || 'GET'
  const timeout = options.timeout || 120000
  let body = options.body !== undefined ? options.body : null
  const headers = Object.assign({ 'user-agent': DEVICE_USER_AGENT }, options.headers || {})
  if (options.cookieJar) {
    const c = Array.from(options.cookieJar, ([k, v]) => k + '=' + v).join('; ')
    if (c) headers.cookie = c
    else if (options.cookie) headers.cookie = options.cookie
  } else if (options.cookie) headers.cookie = options.cookie
  if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
    // Qt (QUrlQuery) leaves commas unescaped in query bodies; match it exactly
    // so pkgtype=system,data,bin is not sent as system%2Cdata%2Cbin.
    body = new URLSearchParams(body).toString().replace(/%2C/gi, ',')
    headers['content-type'] = 'application/x-www-form-urlencoded'
  }
  if (body !== null) headers['content-length'] = Buffer.byteLength(body)
  wire(host, '->', method + ' ' + options.path +
    ' | cookie: ' + (headers.cookie || '(none)') +
    (headers['content-type'] ? ' | ' + headers['content-type'] : '') +
    (body !== null ? ' | body: ' + String(body).slice(0, 500) : ''))
  // The device hands out session/backup cookies via Set-Cookie on backup.cgi
  // responses (e.g. the backup ID cookie) and expects them echoed back.
  const absorb = (resHeaders) => {
    if (!options.cookieJar || !resHeaders) return
    const set = resHeaders['set-cookie']
    if (!set) return
    const list = Array.isArray(set) ? set : [set]
    for (const raw of list) {
      const pair = String(raw).split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) options.cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: normalizeHost(host),
      port: DEVICE_HTTPS_PORT,
      method,
      path: options.path,
      headers,
      agent: false,
      ...TLS_OPTIONS
    }, (res) => {
      absorb(res.headers)
      wire(host, '<-', 'status ' + res.statusCode +
        ' | headers: ' + JSON.stringify(res.headers))
      if (options.stream) {
        resolve(res)
        return
      }
      const chunks = []
      let len = 0
      res.on('data', (c) => {
        len += c.length
        if (len > 8 * 1024 * 1024) {
          res.destroy()
          reject(new BackupError('Device sent an unexpectedly large response'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        wire(host, '<-', 'body: ' + body.toString('latin1').replace(/\s+/g, ' ').slice(0, 800))
        resolve({ status: res.statusCode, headers: res.headers, body })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new BackupError('Timeout talking to the device')))
    req.on('error', (err) => {
      if (err instanceof BackupError) reject(err)
      else reject(new BackupError('Could not reach the device at ' + host + ': ' + err.message))
    })
    if (options.onRequest) options.onRequest(req)
    if (body !== null) req.end(body)
    else req.end()
  })
}

function plainRequest (host, reqPath, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: normalizeHost(host),
      port: DEVICE_HTTP_PORT,
      method: 'GET',
      path: reqPath,
      headers: { 'user-agent': DEVICE_USER_AGENT }
    }, (res) => {
      const chunks = []
      let len = 0
      res.on('data', (c) => {
        len += c.length
        if (len > 8 * 1024 * 1024) {
          res.destroy()
          reject(new BackupError('Device sent an unexpectedly large response'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(timeout || 8000, () => req.destroy(new BackupError('Timeout discovering the device')))
    req.on('error', (err) => {
      if (err instanceof BackupError) reject(err)
      else reject(new BackupError('Could not reach the device at ' + host + ': ' + err.message))
    })
    req.end()
  })
}

async function discoverDevice (host) {
  const xml = (await plainRequest(host, '/cgi-bin/discovery.cgi')).toString('latin1')
  if (!/<DeviceCharacteristics/i.test(xml)) {
    throw new BackupError('No BB10 or PlayBook device found at ' + host)
  }
  const pinRaw = xmlText(xml, 'BbPin') || ''
  const pinNumber = Number(pinRaw)
  const minProto = parseInt(xmlText(xml, 'MinSupportedProtocolVersion'), 10)
  const maxProto = parseInt(xmlText(xml, 'MaxSupportedProtocolVersion'), 10)
  let protocol = 1
  if (minProto === 1) protocol = 1
  if (maxProto >= 3) protocol = 3
  return {
    host,
    pin: pinRaw && Number.isFinite(pinNumber) ? pinNumber.toString(16).toUpperCase() : pinRaw,
    name: (xmlText(xml, 'SystemMachine') || '').replace(/_/g, ' '),
    model: xmlText(xml, 'ModelName') || '',
    osType: xmlText(xml, 'OsType') || '',
    osVersion: xmlText(xml, 'PlatformVersion') || '',
    protocol,
    devMode: xmlText(xml, 'DeveloperModeEnabled') === 'true'
  }
}

function sessionCookies (session) {
  const m = new Map()
  if (session && session.cookie) {
    for (const part of session.cookie.split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0) m.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }
  return m
}

// One-shot raw HTTP/1.0 request over TLS; some firmwares only stream backup
// data with HTTP/1.0-style close-delimited responses.
function http10StreamRequest (host, cookie, body, timeoutMs) {
  return new Promise((resolve) => {
    const tls = require('tls')
    const chunks = []
    let total = 0
    let headersDone = false
    let settled = false
    const finish = (extra) => {
      if (settled) return
      settled = true
      resolve(Object.assign({ bytes: total, first: Buffer.concat(chunks).toString('latin1').slice(0, 400) }, extra || {}))
    }
    const sock = tls.connect({ host: normalizeHost(host), port: DEVICE_HTTPS_PORT, ...TLS_OPTIONS }, () => {
      const reqStr = 'POST /cgi-bin/backup.cgi HTTP/1.0\r\n' +
        'Host: ' + normalizeHost(host) + '\r\n' +
        'User-Agent: ' + DEVICE_USER_AGENT + '\r\n' +
        (cookie ? 'Cookie: ' + cookie + '\r\n' : '') +
        'Content-Type: application/x-www-form-urlencoded\r\n' +
        'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
        '\r\n' + body
      sock.write(reqStr)
    })
    const timer = setTimeout(() => {
      sock.destroy()
      finish({ timeout: true })
    }, timeoutMs || 120000)
    sock.on('data', (c) => {
      total += c.length
      if (chunks.length < 40) chunks.push(c)
      if (!headersDone && total > 0) headersDone = true
    })
    sock.on('end', () => { clearTimeout(timer); finish() })
    sock.on('close', () => { clearTimeout(timer); finish() })
    sock.on('error', (err) => { clearTimeout(timer); finish({ error: err.message }) })
  })
}

function cookieFromResponse (res) {
  const set = res.headers && res.headers['set-cookie']
  if (!set || !set.length) return null
  const list = Array.isArray(set) ? set : [set]
  const pairs = []
  for (const raw of list) {
    const pair = String(raw).split(';')[0]
    if (pair.indexOf('=') > 0) pairs.push(pair.trim())
  }
  return pairs.length ? pairs.join('; ') : null
}

function checkXmlAuth (xml) {
  if (/<AuthChallenge[\s>]/i.test(xml)) throw new AuthRequiredError('Device session expired, log in again')
  if (/noauth/i.test(xml)) throw new AuthRequiredError('Device session expired, log in again')
}

async function loginSession (host, password) {
  let device
  try {
    device = await discoverDevice(host)
  } catch (err) {
    device = { host, pin: '', name: '', model: '', osType: '', osVersion: '', protocol: 1, devMode: null }
  }
  // Some firmwares (e.g. 10.3.3.3204) advertise protocol 3 but deny valid
  // credentials at request_version=3 while version 1 works — try the
  // discovered version first, then the other one before giving up.
  const versions = device.protocol === 3 ? [3, 1] : [1, 3]
  let lastXml = null
  for (const ver of versions) {
    const first = await deviceRequest(host, {
      path: '/cgi-bin/login.cgi?request_version=' + ver
    })
    const xml1 = first.body.toString('latin1')
    if (!/<AuthChallenge[\s>]/i.test(xml1)) {
      const status = xmlText(xml1, 'Status')
      if (status === 'OK' || status === 'Success') {
        const cookie = cookieFromResponse(first)
        if (cookie) {
          device.protocol = ver
          return { cookie, device, loggedInAt: Date.now() }
        }
      }
      lastXml = xml1
      continue
    }
    const saltHex = xmlText(xml1, 'Salt') || ''
    const challenge = xmlText(xml1, 'Challenge') || ''
    const icount = parseInt(xmlText(xml1, 'ICount'), 10) || 1
    if (!saltHex || !challenge) {
      lastXml = xml1
      continue
    }
    const answer = hashPass(String(password), challenge, Buffer.from(saltHex, 'hex'), icount)
    const second = await deviceRequest(host, {
      path: '/cgi-bin/login.cgi?challenge_data=' + answer.toString('hex').toUpperCase() +
        '&request_version=' + ver
    })
    const xml2 = second.body.toString('latin1')
    const status = xmlText(xml2, 'Status')
    if (status === 'OK' || status === 'Success') {
      const cookie = cookieFromResponse(second)
      if (!cookie) throw new BackupError('Device did not return a login session')
      device.protocol = ver
      return { cookie, device, loggedInAt: Date.now() }
    }
    lastXml = xml2
    if (status === 'Denied' && ver === versions[versions.length - 1]) {
      throw new AuthFailedError('The device rejected that password')
    }
  }
  const status = lastXml ? xmlText(lastXml, 'Status') : null
  if (status === 'Denied') throw new AuthFailedError('The device rejected that password')
  throw new BackupError('Login failed: ' + (lastXml ? briefXmlError(lastXml) || 'unexpected response' : 'no response'))
}

async function fetchDeviceProps (host, session) {
  try {
    const res = await deviceRequest(host, {
      method: 'POST',
      path: '/cgi-bin/dynamicProperties.cgi',
      body: 'Get%20Dynamic%20Properties=Get%20Dynamic%20Properties',
      cookie: session.cookie
    })
    const xml = res.body.toString('latin1')
    checkXmlAuth(xml)
    const d = session.device
    d.friendlyName = xmlText(xml, 'DeviceName') || d.friendlyName || ''
    d.bbid = xmlText(xml, 'Bbid') || ''
    d.platformVersion = xmlText(xml, 'PlatformVersion') || d.osVersion || ''
    d.radioVersion = xmlText(xml, 'RadioVersion') || ''
    const battery = parseInt(xmlText(xml, 'BatteryLevel'), 10)
    if (Number.isFinite(battery)) d.battery = battery
    const free = parseInt(xmlText(xml, 'FreeApplicationSpace'), 10)
    if (Number.isFinite(free)) d.freeSpace = free
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err
  }
}

function publicDevice (session) {
  const d = session.device
  return {
    host: d.host,
    pin: d.pin || '',
    name: d.name || '',
    friendlyName: d.friendlyName || '',
    model: d.model || '',
    osType: d.osType || '',
    osVersion: d.osVersion || '',
    protocol: d.protocol || 1,
    battery: d.battery !== undefined ? d.battery : null,
    freeSpace: d.freeSpace !== undefined ? d.freeSpace : null
  }
}

// --- ZIP writing (store method, zip64, streaming entries with data descriptors)

function dosDateTime (date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

function zip64Extra (uncomp, comp) {
  const buf = Buffer.alloc(20)
  buf.writeUInt16LE(0x0001, 0)
  buf.writeUInt16LE(16, 2)
  buf.writeBigUInt64LE(uncomp, 4)
  buf.writeBigUInt64LE(comp, 12)
  return buf
}

class ZipWriter {
  constructor (stream) {
    this.stream = stream
    this.offset = 0n
    this.entries = []
    this.closed = false
    this._error = null
    // Absorb async write errors (e.g. writes completing after an abort);
    // _write/close re-check and surface them to the job.
    stream.on('error', (err) => { this._error = err })
  }

  async _write (buf) {
    if (this._error) throw this._error
    if (!this.stream.destroyed && !this.stream.write(buf)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve() }
        const onClose = () => { cleanup(); reject(new BackupError('Backup file stream closed unexpectedly')) }
        const onError = (err) => { cleanup(); reject(err) }
        const cleanup = () => {
          this.stream.removeListener('drain', onDrain)
          this.stream.removeListener('close', onClose)
          this.stream.removeListener('error', onError)
        }
        this.stream.on('drain', onDrain)
        this.stream.on('close', onClose)
        this.stream.on('error', onError)
      })
    }
    this.offset += BigInt(buf.length)
    if (this._error) throw this._error
  }

  async addEntry (name, source, onProgress) {
    if (this.closed) throw new BackupError('Backup file already finished')
    const nameBuf = Buffer.from(name, 'utf8')
    const { time, day } = dosDateTime(new Date())
    const localExtra = zip64Extra(0n, 0n)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(45, 4)
    header.writeUInt16LE(0x0808, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(day, 12)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(localExtra.length, 28)
    const startOffset = this.offset
    await this._write(header)
    await this._write(nameBuf)
    await this._write(localExtra)
    let crc = 0
    let size = 0n
    let done = 0
    if (Buffer.isBuffer(source)) {
      crc = crc32(0, source)
      size = BigInt(source.length)
      done = source.length
      await this._write(source)
    } else {
      for await (const chunk of source) {
        crc = crc32(crc, chunk)
        size += BigInt(chunk.length)
        done += chunk.length
        await this._write(chunk)
        if (onProgress) onProgress(done)
      }
    }
    if (onProgress) onProgress(done)
    const desc = Buffer.alloc(24)
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(crc, 4)
    desc.writeBigUInt64LE(size, 8)
    desc.writeBigUInt64LE(size, 16)
    await this._write(desc)
    this.entries.push({ nameBuf, crc, size, offset: startOffset })
  }

  async close () {
    if (this.closed) return
    this.closed = true
    const { time, day } = dosDateTime(new Date())
    const central = []
    let centralSize = 0n
    let needsZip64 = false
    for (const e of this.entries) {
      const need64 = e.size >= 0xffffffffn || e.offset >= 0xffffffffn
      if (need64) needsZip64 = true
      let extra
      if (need64) {
        extra = Buffer.alloc(28)
        extra.writeUInt16LE(0x0001, 0)
        extra.writeUInt16LE(24, 2)
        extra.writeBigUInt64LE(e.size, 4)
        extra.writeBigUInt64LE(e.size, 12)
        extra.writeBigUInt64LE(e.offset, 20)
      } else {
        extra = Buffer.alloc(0)
      }
      const head = Buffer.alloc(46)
      head.writeUInt32LE(0x02014b50, 0)
      head.writeUInt16LE((3 << 8) | 45, 4)
      head.writeUInt16LE(45, 6)
      head.writeUInt16LE(0x0808, 8)
      head.writeUInt16LE(0, 10)
      head.writeUInt16LE(time, 12)
      head.writeUInt16LE(day, 14)
      head.writeUInt32LE(e.crc, 16)
      head.writeUInt32LE(need64 ? 0xffffffff : Number(e.size), 20)
      head.writeUInt32LE(need64 ? 0xffffffff : Number(e.size), 24)
      head.writeUInt16LE(e.nameBuf.length, 28)
      head.writeUInt16LE(extra.length, 30)
      head.writeUInt32LE(need64 ? 0xffffffff : Number(e.offset), 42)
      central.push(head, e.nameBuf, extra)
      centralSize += BigInt(head.length + e.nameBuf.length + extra.length)
    }
    const cdOffset = this.offset
    for (const buf of central) await this._write(buf)
    if (needsZip64) {
      const z64 = Buffer.alloc(56)
      z64.writeUInt32LE(0x06064b50, 0)
      z64.writeBigUInt64LE(44n, 4)
      z64.writeUInt16LE(45, 12)
      z64.writeUInt16LE(45, 14)
      z64.writeUInt32LE(0, 16)
      z64.writeUInt32LE(0, 20)
      z64.writeBigUInt64LE(BigInt(this.entries.length), 24)
      z64.writeBigUInt64LE(BigInt(this.entries.length), 32)
      z64.writeBigUInt64LE(centralSize, 40)
      z64.writeBigUInt64LE(cdOffset, 48)
      const z64Offset = this.offset
      await this._write(z64)
      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(0x07064b50, 0)
      loc.writeUInt32LE(0, 4)
      loc.writeBigUInt64LE(z64Offset, 8)
      loc.writeUInt32LE(1, 16)
      await this._write(loc)
    }
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    const many = this.entries.length >= 0xffff
    eocd.writeUInt16LE(many ? 0xffff : this.entries.length, 8)
    eocd.writeUInt16LE(many ? 0xffff : this.entries.length, 10)
    if (needsZip64 || centralSize >= 0xffffffffn || cdOffset >= 0xffffffffn) {
      eocd.writeUInt32LE(0xffffffff, 12)
      eocd.writeUInt32LE(0xffffffff, 16)
    } else {
      eocd.writeUInt32LE(Number(centralSize), 12)
      eocd.writeUInt32LE(Number(cdOffset), 16)
    }
    await this._write(eocd)
    await new Promise((resolve) => {
      this.stream.once('close', resolve)
      this.stream.end()
    })
    if (this._error) throw this._error
  }

  async abort () {
    this.closed = true
    this.stream.destroy()
  }
}

// --- ZIP reading (central directory; store + deflate methods)

async function zipOpen (filePath) {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const st = await fh.stat()
    const size = st.size
    const tailLen = Math.min(size, 66000)
    const tail = Buffer.alloc(tailLen)
    const got = (await fh.read(tail, 0, tailLen, size - tailLen)).bytesRead
    if (got !== tailLen) throw new BackupError('Could not read the backup file')
    let eocdPos = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdPos = i
        break
      }
    }
    if (eocdPos < 0) throw new BackupError('Not a valid backup file (no ZIP directory found)')
    let count = tail.readUInt16LE(eocdPos + 10)
    let cdSize = tail.readUInt32LE(eocdPos + 12)
    let cdOffset = tail.readUInt32LE(eocdPos + 16)
    if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
      if (eocdPos >= 20 && tail.readUInt32LE(eocdPos - 20) === 0x07064b50) {
        const z64Offset = tail.readBigUInt64LE(eocdPos - 20 + 8)
        const rec = Buffer.alloc(56)
        const r = await fh.read(rec, 0, 56, Number(z64Offset))
        if (r.bytesRead !== 56 || rec.readUInt32LE(0) !== 0x06064b50) {
          throw new BackupError('Corrupt zip64 backup directory')
        }
        count = Number(rec.readBigUInt64LE(32))
        cdSize = Number(rec.readBigUInt64LE(40))
        cdOffset = Number(rec.readBigUInt64LE(48))
      }
    }
    if (cdSize <= 0 || cdOffset + cdSize > size) throw new BackupError('Corrupt backup directory')
    const cd = Buffer.alloc(cdSize)
    const rd = await fh.read(cd, 0, cdSize, cdOffset)
    if (rd.bytesRead !== cdSize) throw new BackupError('Could not read the backup directory')
    const entries = []
    let p = 0
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      let compSize = cd.readUInt32LE(p + 20)
      let uncompSize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let localOffset = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      const extraEnd = p + 46 + nameLen + extraLen
      let q = p + 46 + nameLen
      while (q + 4 <= extraEnd) {
        const id = cd.readUInt16LE(q)
        const sz = cd.readUInt16LE(q + 2)
        if (id === 0x0001) {
          let r = q + 4
          if (uncompSize === 0xffffffff && r + 8 <= Math.min(q + 4 + sz, extraEnd)) {
            uncompSize = Number(cd.readBigUInt64LE(r))
            r += 8
          }
          if (compSize === 0xffffffff && r + 8 <= Math.min(q + 4 + sz, extraEnd)) {
            compSize = Number(cd.readBigUInt64LE(r))
            r += 8
          }
          if (localOffset === 0xffffffff && r + 8 <= Math.min(q + 4 + sz, extraEnd)) {
            localOffset = Number(cd.readBigUInt64LE(r))
          }
        }
        q += 4 + sz
      }
      entries.push({ name, method, crc, compSize, uncompSize, localOffset })
      p = extraEnd + commentLen
    }
    return { filePath, fh, size, entries }
  } catch (err) {
    await fh.close().catch(() => {})
    throw err
  }
}

function zipEntryStream (zip, entry, expectedCrc) {
  return new Promise((resolve, reject) => {
    const lh = Buffer.alloc(30)
    zip.fh.read(lh, 0, 30, entry.localOffset).then((r) => {
      try {
        if (r.bytesRead !== 30 || lh.readUInt32LE(0) !== 0x04034b50) {
          throw new BackupError('Corrupt backup entry: ' + entry.name)
        }
        const nameLen = lh.readUInt16LE(26)
        const extraLen = lh.readUInt16LE(28)
        const dataStart = entry.localOffset + 30 + nameLen + extraLen
        let out
        if (entry.method === 0) {
          out = fs.createReadStream(zip.filePath, {
            start: dataStart,
            end: dataStart + entry.compSize - 1
          })
        } else if (entry.method === 8) {
          const raw = fs.createReadStream(zip.filePath, {
            start: dataStart,
            end: dataStart + entry.compSize - 1
          })
          out = raw.pipe(zlib.createInflateRaw())
        } else {
          throw new BackupError('Unsupported compression in backup entry: ' + entry.name)
        }
        let crc = 0
        let total = 0
        const counted = new Transform({
          transform (chunk, enc, cb) {
            crc = crc32(crc, chunk)
            total += chunk.length
            if (total > entry.uncompSize) {
              cb(new BackupError('Backup entry larger than expected: ' + entry.name))
              return
            }
            cb(null, chunk)
          },
          flush (cb) {
            if (total !== entry.uncompSize) {
              cb(new BackupError('Backup entry is truncated: ' + entry.name))
              return
            }
            if (expectedCrc !== undefined && crc !== expectedCrc) {
              cb(new BackupError('Backup entry failed its checksum: ' + entry.name))
              return
            }
            cb()
          }
        })
        counted.on('error', () => { })
        out.on('error', (err) => counted.destroy(err))
        resolve(counted)
        out.pipe(counted)
      } catch (err) {
        reject(err)
      }
    }).catch(reject)
  })
}

// --- Sessions and jobs

function createBackupHandler (backupsDir, hooks) {
  hooks = hooks || {}
  const sessions = new Map()
  const jobs = new Map()
  const loggedOutHosts = new Set()

  function sharedCookie (host) {
    if (loggedOutHosts.has(host)) return null
    if (hooks.sharedCookie) return hooks.sharedCookie(host)
    return null
  }

  function adoptCookie (host, cookie) {
    if (hooks.adoptCookie) hooks.adoptCookie(host, cookie)
  }

  function placeholderDevice (host) {
    return { host, pin: '', name: '', friendlyName: '', model: '', osType: '', osVersion: '', protocol: 1 }
  }

  WIRE_DIR = backupsDir
  fs.mkdirSync(backupsDir, { recursive: true })
  fs.promises.readdir(backupsDir).then((names) => {
    for (const n of names) {
      if (n.endsWith('.part')) {
        fs.promises.unlink(path.join(backupsDir, n)).catch(() => {})
      }
    }
  }).catch(() => {})

  function requireSession (host) {
    let session = sessions.get(host)
    if ((!session || !session.cookie)) {
      const cookie = sharedCookie(host)
      if (cookie) {
        session = { cookie, device: placeholderDevice(host), loggedInAt: Date.now() }
        sessions.set(host, session)
      }
    }
    if (!session || !session.cookie) throw new AuthRequiredError('Log in to the device first')
    return session
  }

  // Per-job cookie jar seeded with the login session; absorbs the device's
  // Set-Cookie headers (backup ID cookie etc.) across the whole job.
  function jobCookies (session) {
    const cookies = new Map()
    if (session.cookie) {
      for (const part of session.cookie.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
      }
    }
    return cookies
  }

  // Fill in device details (PIN, model, BBID, ...) for adopted or info-less
  // sessions. Best effort: backup/restore only needs the session cookie.
  async function ensureDeviceInfo (host, session) {
    if (session.device && session.device.pin) return
    try {
      session.device = await discoverDevice(host)
    } catch (err) { }
    await fetchDeviceProps(host, session)
  }

  async function deviceXml (host, session, options) {
    const res = await deviceRequest(host, Object.assign({}, options, { cookie: session.cookie }))
    const xml = res.body.toString('latin1')
    checkXmlAuth(xml)
    return xml
  }

  function parseBackupList (xml) {
    const categories = []
    const apps = []
    for (const t of xmlTagAttrs(xml)) {
      const a = t.attrs
      if (a.id && a.name !== undefined && a.bytesize !== undefined) {
        categories.push({
          id: a.id.toLowerCase(),
          name: a.name || CATEGORY_NAMES[a.id.toLowerCase()] || a.id,
          count: parseInt(a.count, 10) || 0,
          bytesize: Number(a.bytesize) || 0,
          perimetertype: (a.perimetertype && a.perimetertype !== 'personal' && a.perimetertype !== '0') ? 1 : 0
        })
      } else if (a.pkgid) {
        apps.push({
          pkgid: a.pkgid,
          name: a.name || a.pkgid,
          bytesize: Number(a.bytesize) || 0,
          version: a.version || '',
          type: a.type || ''
        })
      }
    }
    categories.sort((x, y) => CATEGORY_ORDER.indexOf(x.id) - CATEGORY_ORDER.indexOf(y.id))
    return { categories, apps }
  }

  async function backupList (host, session, cookieJar) {
    // Prefer the per-app (rev2) protocol; fall back to the legacy one for
    // devices that refuse it (PlayBook / older firmware).
    const attempts = session.rev1
      ? [{ query: 'list' }]
      : [{ query: 'list', opt: 'rev2' }, { query: 'list' }]
    let lastXml = null
    let lastErr = null
    for (const body of attempts) {
      const xml = await deviceXml(host, session, {
        method: 'POST',
        path: '/cgi-bin/backup.cgi',
        body,
        cookieJar
      })
      if (xmlHas(xml, 'BackupList')) {
        session.rev1 = !body.opt
        return parseBackupList(xml)
      }
      lastXml = xml
      lastErr = xmlErrorText(xml)
    }
    throw new BackupError('Device reported an error listing backup data: ' +
      (lastErr ? lastErr.trim() : 'no data returned') +
      ' \u2014 response: ' + (lastXml ? xmlSnippet(lastXml) : 'empty'))
  }

  function publicJob (job) {
    if (!job) return null
    return {
      kind: job.kind,
      state: job.state,
      step: job.step || null,
      modes: job.modes,
      category: job.curCategory,
      categoryIndex: job.modes.length ? job.curIndex + 1 : 0,
      categoryCount: job.modes.length,
      bytes: job.bytes,
      total: job.total,
      file: job.file,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null
    }
  }

  function getJob (host) {
    return jobs.get(host) || null
  }

  function cancelJob (host) {
    const job = jobs.get(host)
    if (!job || job.state !== 'running') return false
    job.cancelRequested = true
    if (job.currentReq) {
      try {
        job.currentReq.destroy(new CancelledError('Cancelled'))
      } catch (err) { }
    }
    return true
  }

  function checkCancel (job) {
    if (job.cancelRequested) throw new CancelledError('Cancelled')
  }

  // Best-effort: tell the device any previous backup session is over. Aborted
  // attempts leave dangling sessions that poison later GETs (stale backup IDs,
  // CRC errors), and this firmware reports them via <BackupEnd>. Only sent
  // when a backup cookie exists — with no session the device blocks for a
  // minute and answers "Error starting backup session".
  async function closeBackupSession (host, session, cookies) {
    if (!cookies || !cookies.get('backup')) return
    try {
      await deviceXml(host, session, {
        method: 'POST', path: '/cgi-bin/backup.cgi',
        body: { status: 'success' },
        cookieJar: cookies,
        timeout: 15000
      })
    } catch (err) { }
  }

  async function runBackupJob (job) {
    const host = job.host
    const session = requireSession(host)
    const cookies = jobCookies(session)
    job.step = 'Clearing previous backup state'
    await closeBackupSession(host, session, cookies)
    checkCancel(job)
    job.step = 'Reading device info'
    await ensureDeviceInfo(host, session).catch(() => { })
    job.step = 'Listing backup data'
    let listInfo = null
    try {
      listInfo = await backupList(host, session, cookies)
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err
    }
    checkCancel(job)
    const device = session.device
    const pinSlug = (device.pin || '').replace(/[^A-Za-z0-9]/g, '') || 'device'
    const fileName = 'BB10-' + pinSlug + '-' + formatStamp(new Date()) + '.bbb'
    job.file = fileName
    const finalPath = path.join(backupsDir, fileName)
    const partPath = finalPath + '.part'

    // Attempt 1 uses the per-app (rev2) protocol when allowed. If the device
    // refuses a rev2-specific request, the whole attempt is restarted with the
    // legacy protocol.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rev2 = attempt === 0 && job.rev2 && !session.rev1
      const out = fs.createWriteStream(partPath, { flags: 'w' })
      const zip = new ZipWriter(out)
      try {
        const known = new Map()
        if (listInfo) {
          for (const c of listInfo.categories) {
            if (job.modes.includes(c.id)) known.set(c.id, c)
          }
        }
        const archives = job.modes.map((id) => {
          const c = known.get(id)
          const name = c ? c.name : CATEGORY_NAMES[id]
          const count = c ? c.count : 0
          const bytesize = c ? c.bytesize : -1
          return '<Archive id="' + id + '" name="' + escapeXml(name) + '" count="' + count +
            '" bytesize="' + bytesize + '" keyid="' + escapeXml(device.bbid || '') +
            '" perimetertype="' + (c ? c.perimetertype : 0) + '"/>'
        }).join('')
        const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<BlackBerry_Backup><Version>3.0</Version>' +
          '<Client platform="BB10AppManagerLinux" osversion="Node.js ' + process.version.replace(/^v/, '') +
          '" dtmversion="2.0.0.0"/>' +
          '<SourceDevice pin="' + escapeXml(device.pin || '') + '"><Platform type="QNX" version="' +
          escapeXml(device.osVersion || '10.0.0.0') + '"/></SourceDevice>' +
          '<QnxOSDevice><Archives>' + archives + '</Archives></QnxOSDevice></BlackBerry_Backup>'
        await zip.addEntry('Manifest.xml', Buffer.from(manifest, 'utf8'))

        job.step = 'Preparing backup on device'
        // Start-request ladder: bare mode= (Sachesi's current flow), then the
        // action=backup prefix (Sachesi's own commented-out variant). Accept
        // whichever the device takes; some firmwares also answer the start
        // with the activity report (BackupStartActivity) directly.
        const modeValue = job.modes.join('_')
        const startBodies = rev2
          ? [{ mode: modeValue, opt: 'rev2' }, { action: 'backup', mode: modeValue, opt: 'rev2' }]
          : [{ mode: modeValue }, { action: 'backup', mode: modeValue }]
        let startXml = null
        let startErr = null
        for (const startBody of startBodies) {
          const xml = await deviceXml(job.host, session, {
            method: 'POST', path: '/cgi-bin/backup.cgi', body: startBody,
            cookieJar: cookies,
            onRequest: (rq) => { job.currentReq = rq }
          })
          checkCancel(job)
          if (xmlHas(xml, 'BackupStart') || xmlHas(xml, 'BackupStartActivity')) {
            startXml = xml
            break
          }
          const e = xmlErrorText(xml)
          if (!startErr) {
            startErr = e ? e.trim() : 'unexpected response: ' + xmlSnippet(xml)
          }
        }
        if (!startXml) {
          if (rev2) throw new FallbackNeededError('Device refused to start the backup: ' + (startErr || 'no usable response'))
          throw new BackupError('Device refused to start the backup: ' + (startErr || 'no usable response'))
        }
        // Some firmwares answer the mode request with the activity report
        // (BackupStartActivity + sizes, Status Ready) directly; others want a
        // separate query=activity round trip. Accept both shapes.
        let activityXml = startXml
        if (!xmlHas(startXml, 'BackupStartActivity')) {
          job.step = 'Querying backup sizes'
          const activityBody = rev2 ? { query: 'activity', opt: 'rev2' } : { query: 'activity' }
          activityXml = await deviceXml(job.host, session, {
            method: 'POST', path: '/cgi-bin/backup.cgi', body: activityBody,
            cookieJar: cookies,
            onRequest: (rq) => { job.currentReq = rq }
          })
          checkCancel(job)
          if (!xmlHas(activityXml, 'BackupStartActivity')) {
            const e = xmlErrorText(activityXml)
            if (rev2) throw new FallbackNeededError('Device did not report backup activity: ' +
              (e ? e.trim() : 'unexpected response: ' + xmlSnippet(activityXml)))
            throw new BackupError('Device did not report backup activity: ' +
              (e ? e.trim() : 'unexpected response: ' + xmlSnippet(activityXml)))
          }
        }
        const total = parseInt(xmlText(activityXml, 'TotalSize'), 10)
        job.total = Number.isFinite(total) && total > 0 ? total : 0

        for (let i = 0; i < job.modes.length; i++) {
          checkCancel(job)
          const cat = job.modes[i]
          job.curIndex = i
          job.curCategory = cat
          job.catStart = job.bytes
          job.step = 'Downloading ' + cat
          if (i > 0) {
            job.step = 'Continuing with ' + cat
            const checkXml = await deviceXml(job.host, session, {
              method: 'POST', path: '/cgi-bin/backup.cgi',
              body: { action: 'backup', [paramName]: cat },
              cookieJar: cookies,
              onRequest: (rq) => { job.currentReq = rq }
            })
            checkCancel(job)
            if (!xmlHas(checkXml, 'BackupCheck')) {
              const e = xmlErrorText(checkXml)
              throw new BackupError('Device refused to continue with ' + cat + ': ' +
                (e ? e.trim() : 'unexpected response: ' + xmlSnippet(checkXml)))
            }
          }
          const body = { type: cat }
          const wantRev2 = i === 0 && cat === 'app' && rev2
          if (wantRev2) {
            body.opt = 'rev2'
            body.pkgtype = (job.appTypes && job.appTypes.length ? job.appTypes : PKG_TYPES).join(',')
          }
          // Devices differ in how an archive download ("get") is performed,
          // and slow ones answer with <Status>InProgress</Status> while still
          // packaging (poll patiently — abandoning in-flight GETs corrupts
          // the device's state) or with Status Ready + sizes once the data is
          // waiting. Each variant below is a known GET handshake shape.
          const catSize = {}
          for (const c of CATEGORY_ORDER) {
            const v = parseInt(xmlText(activityXml, c.charAt(0).toUpperCase() + c.slice(1)), 10)
            if (Number.isFinite(v) && v > 0) catSize[c] = v
          }
          let res = null

          // Unified stream loop: alternate type=app and query=activity at a
          // calm cadence. BlackBerry Link-style clients poll activity and let
          // the device reach its serving state; hammering it with varied
          // request shapes makes this firmware create new backup objects
          // (the ID increments per request) and never serve. Handshake
          // variants are a last resort after the loop's budget is spent.
          const streamDeadline = Date.now() + 20 * 60 * 1000
          const errors = []
          const absorbSizes = (sizes) => {
            if (sizes) {
              for (const k of Object.keys(sizes)) {
                if (!catSize[k]) catSize[k] = sizes[k]
              }
            }
          }
          let cycles = 0
          let empties = 0
          let sawReady = false
          let paramName = 'type'
          const streamBody = () => {
            const b = { [paramName]: cat }
            if (wantRev2 && cat === 'app') {
              b.opt = 'rev2'
              b.pkgtype = (job.appTypes && job.appTypes.length ? job.appTypes : PKG_TYPES).join(',')
            }
            return b
          }
          while (!res) {
            checkCancel(job)
            if (Date.now() > streamDeadline) {
              errors.push('device never entered the serving state after 20 minutes')
              break
            }
            cycles++
            const askStream = cycles % 2 === 1
            if (askStream) {
              job.step = sawReady
                ? 'Backup packaged, requesting stream (' + cat + ')'
                : 'Waiting for device to prepare ' + cat
              let out
              try {
                out = await openCategoryStreamOnce(job, session, cat, streamBody(), cookies)
              } catch (err) {
                if (err instanceof CancelledError) throw err
                if (!err.xmlResponse) throw err
                if (err.useModeParam) {
                  paramName = 'mode'
                  empties = 0
                  wire(job.host, '--', 'device wants mode= parameter for category requests')
                  await new Promise((resolve) => setTimeout(resolve, 1000))
                  continue
                }
                empties++
                if (empties >= 6) errors.push('direct: ' + err.message)
                await new Promise((resolve) => setTimeout(resolve, 3000))
                continue
              }
              if (out.stream) {
                res = out.stream
                break
              }
              absorbSizes(out.sizes)
              if (out.ready) sawReady = true
              await new Promise((resolve) => setTimeout(resolve, 3000))
            } else {
              job.step = sawReady
                ? 'Backup packaged, requesting stream (' + cat + ')'
                : 'Waiting for device to prepare ' + cat
              try {
                const activityBody = rev2 ? { query: 'activity', opt: 'rev2' } : { query: 'activity' }
                const xml = await deviceXml(job.host, session, {
                  method: 'POST', path: '/cgi-bin/backup.cgi', body: activityBody,
                  cookieJar: cookies,
                  onRequest: (rq) => { job.currentReq = rq }
                })
                absorbSizes(parseActivitySizes(xml))
                if (xmlErrorText(xml) !== null) {
                  errors.push('activity: ' + (xmlErrorText(xml) || '').trim())
                }
                if (xmlHas(xml, 'BackupStartActivity') || xmlHas(xml, 'BackupCheck')) {
                  // sizes/state absorbed above; the next odd cycle asks for the stream
                }
              } catch (err) {
                if (err instanceof CancelledError) throw err
                if (!err.xmlResponse) throw err
                errors.push('activity: ' + err.message)
                await new Promise((resolve) => setTimeout(resolve, 3000))
              }
              await new Promise((resolve) => setTimeout(resolve, 2000))
            }
          }

          // Phase B: GET handshake fallbacks for devices that never stream on
          // the plain request.
          if (!res) {
            const tryVariant = async (att) => {
              for (;;) {
                checkCancel(job)
                let out
                try {
                  if (att.pre) {
                    await deviceXml(job.host, session, {
                      method: 'POST', path: '/cgi-bin/backup.cgi', body: att.pre,
                      cookieJar: cookies,
                      onRequest: (rq) => { job.currentReq = rq }
                    })
                    checkCancel(job)
                  }
                  out = await openCategoryStreamOnce(job, session, cat, att.body, cookies, att.path || '/cgi-bin/backup.cgi', att.method)
                } catch (err) {
                  if (err instanceof CancelledError) throw err
                  if (!err.xmlResponse) throw err
                  return err.message
                }
                if (out.stream) {
                  res = out.stream
                  if (att.legacy) session.rev1 = true
                  return null
                }
                absorbSizes(out.sizes)
                if (out.ready) {
                  return 'device answered with the activity report instead of the stream'
                }
                if (Date.now() > streamDeadline) {
                  return 'device never entered the serving state after 20 minutes'
                }
                job.step = 'Trying ' + att.label + ' for ' + cat
                await new Promise((resolve) => setTimeout(resolve, 2000))
              }
            }
            const pkgValue = (job.appTypes && job.appTypes.length ? job.appTypes : PKG_TYPES).join(',')
            const sizeQ = catSize[cat] ? '&size=' + catSize[cat] : ''
            const backupId = cookies.get('backupid') || cookies.get('BackupID') || ''
            const idQ = backupId ? '&backupid=' + encodeURIComponent(backupId) : ''
            const variants = [
              { label: 'plain retry', body: { type: cat }, legacy: true },
              { label: 'mode-param', body: { mode: cat }, legacy: true },
              { label: 'mode-param+rev2', body: { mode: cat, opt: 'rev2', pkgtype: pkgValue } }
            ]
            if (catSize[cat]) {
              variants.push({ label: 'action=get+size', body: { action: 'get', type: cat, size: catSize[cat] } })
              variants.push({ label: 'restore-style', path: '/cgi-bin/backup.cgi?action=backup&type=' + cat + sizeQ, body: '', legacy: true })
              variants.push({ label: 'two-step', pre: { action: 'backup', type: cat }, body: { type: cat }, legacy: true })
              variants.push({ label: 'query+size', path: '/cgi-bin/backup.cgi?type=' + cat + sizeQ, body: '', legacy: true })
              variants.push({ label: 'query action=get', path: '/cgi-bin/backup.cgi?action=get&type=' + cat + sizeQ, body: '', legacy: true })
              variants.push({ label: 'rev2+size', body: { type: cat, opt: 'rev2', pkgtype: pkgValue, size: catSize[cat] } })
              variants.push({ label: 'rev2 two-step+size', pre: { action: 'backup', type: cat, opt: 'rev2', pkgtype: pkgValue, size: catSize[cat] }, body: { type: cat, opt: 'rev2', pkgtype: pkgValue, size: catSize[cat] } })
              variants.push({ label: 'query+rev2+size', path: '/cgi-bin/backup.cgi?type=' + cat + '&opt=rev2&pkgtype=' + encodeURIComponent(pkgValue) + sizeQ, body: '', legacy: true })
              variants.push({ label: 'restore-style+backupid', path: '/cgi-bin/backup.cgi?action=backup&type=' + cat + sizeQ + idQ, body: '', legacy: true })
              variants.push({ label: 'query+size+backupid', path: '/cgi-bin/backup.cgi?type=' + cat + sizeQ + idQ, body: '', legacy: true })
              variants.push({ label: 'action=get+size+backupid', body: { action: 'get', type: cat, size: catSize[cat], backupid: backupId } })
              variants.push({ label: 'http-get+size', method: 'GET', path: '/cgi-bin/backup.cgi?type=' + cat + sizeQ, body: null, legacy: true })
            } else {
              variants.push({ label: 'query string', path: '/cgi-bin/backup.cgi?type=' + cat, body: '', legacy: true })
            }
            for (const att of variants) {
              const failed = await tryVariant(att)
              if (failed) errors.push(att.label + ': ' + failed)
              if (res) break
            }
          }
          if (!res) {
            const detail = errors.length ? errors.join(' | ') : 'no response'
            if (wantRev2) throw new FallbackNeededError('Device refused to send ' + cat + ' (' + detail + ')')
            throw new BackupError('Device refused to send ' + cat + ' (' + detail + ')')
          }
          try {
            await zip.addEntry('Archive/' + cat + '.tar', res, (n) => {
              job.bytes = job.catStart + n
            })
          } finally {
            res.destroy()
          }
        }
        checkCancel(job)
        job.step = 'Finalizing backup'
        const finishXml = await deviceXml(job.host, session, {
          method: 'POST', path: '/cgi-bin/backup.cgi', body: { action: 'backup' },
          cookieJar: cookies,
          onRequest: (rq) => { job.currentReq = rq }
        })
        if (!xmlHas(finishXml, 'BackupCheck')) {
          const e = xmlErrorText(finishXml)
          throw new BackupError('Device did not confirm backup completion: ' +
            (e ? e.trim() : 'unexpected response: ' + xmlSnippet(finishXml)))
        }
        await deviceXml(job.host, session, {
          method: 'POST', path: '/cgi-bin/backup.cgi', body: { status: 'success' },
          cookieJar: cookies,
          onRequest: (rq) => { job.currentReq = rq }
        })
        await zip.close()
        await fs.promises.rename(partPath, finalPath)
        job.state = 'done'
        break
      } catch (err) {
        await zip.abort()
        await fs.promises.unlink(partPath).catch(() => {})
        if (!(err instanceof AuthRequiredError)) {
          await closeBackupSession(job.host, session, cookies).catch(() => {})
        }
        if (err instanceof FallbackNeededError && attempt === 0 && !job.cancelRequested) {
          session.rev1 = true
          job.bytes = 0
          job.total = 0
          job.curIndex = 0
          job.curCategory = null
          job.catStart = 0
          job.step = 'Retrying with legacy backup protocol'
          job.rev1AttemptError = err.message
          continue
        }
        if (err instanceof CancelledError) job.state = 'cancelled'
        else if (err instanceof AuthRequiredError) {
          sessions.delete(host)
          job.state = 'error'
        } else job.state = 'error'
        const lastError = err instanceof CancelledError ? err.message
          : (job.step ? job.step + ': ' + err.message : err.message)
        let combined = job.rev1AttemptError
          ? 'rev2 attempt: ' + job.rev1AttemptError + ' | legacy attempt: ' + lastError
          : lastError
        if (/CRC error/i.test(combined)) {
          combined += ' \u2014 reboot the device once to clear its stuck backup state, then retry'
        }
        job.error = combined
        break
      } finally {
        job.currentReq = null
      }
    }
    job.finishedAt = Date.now()
  }

  function safeBackupName (name) {
    if (!name || !/^[\w][\w .()-]*\.bbb$/i.test(name)) return null
    const resolved = path.resolve(backupsDir, name)
    if (path.dirname(resolved) !== path.resolve(backupsDir)) return null
    return resolved
  }

  function categoryFromEntryName (name) {
    const m = name.match(/^Archive\/(app|media|settings)\.tar$/i)
    return m ? m[1].toLowerCase() : null
  }

  async function runRestoreJob (job) {
    const host = job.host
    const session = requireSession(host)
    const cookies = jobCookies(session)
    job.step = 'Clearing previous backup state'
    await closeBackupSession(host, session, cookies)
    checkCancel(job)
    job.step = 'Reading backup file'
    const filePath = safeBackupName(job.file)
    if (!filePath) throw new BackupError('Unknown backup file')
    const zip = await zipOpen(filePath)
    try {
      const present = zip.entries
        .map((e) => ({ cat: categoryFromEntryName(e.name), entry: e }))
        .filter((x) => x.cat)
      if (!present.length) throw new BackupError('This backup file contains no restorable archives')
      const selected = job.modes && job.modes.length
        ? job.modes
          .map((m) => present.find((x) => x.cat === m))
          .filter(Boolean)
        : present.slice()
      selected.sort((a, b) => CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat))
      if (!selected.length) throw new BackupError('The backup file does not contain the selected categories')
      job.modes = selected.map((x) => x.cat)
      const totalsize = selected.reduce((s, x) => s + x.entry.uncompSize, 0)
      if (!totalsize) throw new BackupError('The selected archives are empty')
      job.total = totalsize
      job.step = 'Preparing restore on device'
      const startXml = await deviceXml(host, session, {
        method: 'POST',
        path: '/cgi-bin/backup.cgi',
        body: { action: 'restore', mode: job.modes.join('_'), totalsize: String(totalsize) },
        cookieJar: cookies,
        onRequest: (rq) => { job.currentReq = rq }
      })
      checkCancel(job)
      if (!xmlHas(startXml, 'RestoreStart')) {
        const e = xmlErrorText(startXml)
        throw new BackupError('Device refused to start the restore: ' +
          (e ? e.trim() : 'unexpected response: ' + xmlSnippet(startXml)))
      }
      for (let i = 0; i < selected.length; i++) {
        checkCancel(job)
        const { cat, entry } = selected[i]
        job.curIndex = i
        job.curCategory = cat
        job.catStart = job.bytes
        job.step = 'Uploading ' + cat
        const source = await zipEntryStream(zip, entry, entry.crc)
        let sent = 0
        const counter = new Transform({
          transform (chunk, enc, cb) {
            sent += chunk.length
            job.bytes = job.catStart + sent
            cb(null, chunk)
          }
        })
        counter.on('error', () => { })
        source.pipe(counter)
        const replyXml = await new Promise((resolve, reject) => {
          let ended = false
          const headers = {
            'user-agent': DEVICE_USER_AGENT,
            'content-type': 'application/octet-stream',
            'content-length': entry.uncompSize,
            cookie: Array.from(cookies, ([k, v]) => k + '=' + v).join('; ') || session.cookie
          }
          const req = https.request({
            hostname: normalizeHost(host),
            port: DEVICE_HTTPS_PORT,
            method: 'POST',
            path: '/cgi-bin/backup.cgi?action=restore&type=' + cat + '&size=' + entry.uncompSize,
            headers,
            agent: false,
            timeout: 300000,
            ...TLS_OPTIONS
          }, (res) => {
            const chunks = []
            let len = 0
            res.on('data', (c) => {
              len += c.length
              if (len < 1048576) chunks.push(c)
            })
            res.on('end', () => {
              ended = true
              resolve(Buffer.concat(chunks).toString('latin1'))
            })
            res.on('error', (err) => reject(err))
          })
          req.on('timeout', () => req.destroy(new BackupError('Timeout talking to the device')))
          req.on('error', (err) => {
            if (err instanceof BackupError) reject(err)
            else reject(new BackupError('Could not reach the device at ' + host + ': ' + err.message))
          })
          req.on('close', () => {
            if (!ended) reject(new BackupError('Connection closed during restore'))
          })
          job.currentReq = req
          source.on('error', (err) => req.destroy(err))
          counter.pipe(req)
        })
        checkXmlAuth(replyXml)
        if (!xmlHas(replyXml, 'RestoreSend')) {
          const e = xmlErrorText(replyXml)
          throw new BackupError('Device rejected the ' + cat + ' archive: ' +
            (e ? e.trim() : 'no confirmation \u2014 the device may not accept this backup. Response: ' +
              xmlSnippet(replyXml)))
        }
      }
      checkCancel(job)
      job.step = 'Finalizing restore'
      await deviceXml(host, session, {
        method: 'POST', path: '/cgi-bin/backup.cgi', body: { status: 'success' },
        cookieJar: cookies,
        onRequest: (rq) => { job.currentReq = rq }
      })
      job.state = 'done'
    } catch (err) {
      if (!(err instanceof AuthRequiredError)) {
        await closeBackupSession(host, session, cookies).catch(() => {})
      }
      if (err instanceof CancelledError) job.state = 'cancelled'
      else if (err instanceof AuthRequiredError) {
        sessions.delete(host)
        job.state = 'error'
      } else job.state = 'error'
      job.error = err instanceof CancelledError ? err.message
        : (job.step ? job.step + ': ' + err.message : err.message)
    } finally {
      job.currentReq = null
      job.finishedAt = Date.now()
      await zip.fh.close().catch(() => {})
    }
  }

  function startJob (host, kind, options) {
    const existing = jobs.get(host)
    if (existing && existing.state === 'running') {
      throw new BusyError('A backup or restore is already running for this device')
    }
    const job = {
      host,
      kind,
      state: 'running',
      step: 'Starting',
      modes: options.modes || [],
      rev2: !!options.rev2,
      appTypes: options.appTypes || null,
      file: options.file || null,
      curIndex: 0,
      curCategory: null,
      catStart: 0,
      bytes: 0,
      total: 0,
      error: null,
      rev1AttemptError: null,
      cancelRequested: false,
      currentReq: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    jobs.set(host, job)
    const runner = kind === 'backup' ? runBackupJob : runRestoreJob
    runner(job).catch((err) => {
      job.state = 'error'
      job.error = job.step ? job.step + ': ' + err.message : err.message
      job.finishedAt = Date.now()
    })
    return job
  }

  async function listBackupFiles () {
    const names = await fs.promises.readdir(backupsDir).catch(() => [])
    const out = []
    for (const n of names) {
      if (!/\.bbb$/i.test(n)) continue
      const st = await fs.promises.stat(path.join(backupsDir, n)).catch(() => null)
      if (!st || !st.isFile()) continue
      let entries = null
      try {
        const z = await zipOpen(path.join(backupsDir, n))
        entries = z.entries
          .map((e) => ({ category: categoryFromEntryName(e.name), size: e.uncompSize }))
          .filter((e) => e.category)
        await z.fh.close()
      } catch (err) {
        entries = null
      }
      out.push({ file: n, size: st.size, mtime: st.mtimeMs, entries })
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  function sendJson (res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache'
    })
    res.end(body)
  }

  function readJsonBody (req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let len = 0
      req.on('data', (c) => {
        len += c.length
        if (len > 1024 * 1024) {
          reject(new BackupError('Request too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (!len) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (err) {
          reject(new BackupError('Invalid JSON body'))
        }
      })
      req.on('error', reject)
    })
  }

  return async function handleBackupRoute (req, res) {
    const fullUrl = req.url || '/'
    const qi = fullUrl.indexOf('?')
    const pathname = qi < 0 ? fullUrl : fullUrl.slice(0, qi)
    if (!pathname.startsWith('/backup/')) return false
    const query = new URLSearchParams(qi < 0 ? '' : fullUrl.slice(qi + 1))
    const rest = pathname.slice('/backup/'.length)
    const slash = rest.indexOf('/')
    const encodedHost = slash < 0 ? rest : rest.slice(0, slash)
    const action = slash < 0 ? '' : rest.slice(slash + 1)
    let host = ''
    try {
      host = decodeURIComponent(encodedHost)
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid host encoding' })
      return true
    }
    if (!host || !validHost(host) || !/^api\//.test(action)) {
      sendJson(res, 404, { error: 'Unknown backup endpoint' })
      return true
    }
    const apiAction = action.slice(4)
    const session = sessions.get(host)

    try {
      if (apiAction === 'login' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const password = String(body.password || '')
        if (!password) throw new BackupError('Password required')
        const newSession = await loginSession(host, password)
        sessions.set(host, newSession)
        loggedOutHosts.delete(host)
        adoptCookie(host, newSession.cookie)
        await fetchDeviceProps(host, newSession)
        sendJson(res, 200, { ok: true, device: publicDevice(newSession) })
        return true
      }

      if (apiAction === 'info' && req.method === 'GET') {
        let s = session
        if ((!s || !s.cookie)) {
          const cookie = sharedCookie(host)
          if (cookie) {
            s = { cookie, device: placeholderDevice(host), loggedInAt: Date.now() }
            sessions.set(host, s)
          }
        }
        if (s && s.cookie && s.device && !s.device.pin) {
          await ensureDeviceInfo(host, s).catch(() => { })
        }
        sendJson(res, 200, {
          loggedIn: !!(s && s.cookie),
          device: s ? publicDevice(s) : null,
          job: publicJob(getJob(host))
        })
        return true
      }

      if (apiAction === 'logout' && req.method === 'POST') {
        sessions.delete(host)
        loggedOutHosts.add(host)
        sendJson(res, 200, { ok: true })
        return true
      }

      if (apiAction === 'list' && req.method === 'GET') {
        const s = requireSession(host)
        const list = await backupList(host, s)
        sendJson(res, 200, {
          categories: list.categories,
          apps: list.apps,
          device: publicDevice(s)
        })
        return true
      }

      if (apiAction === 'status' && req.method === 'GET') {
        sendJson(res, 200, { job: publicJob(getJob(host)) })
        return true
      }

      if (apiAction === 'backup' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const modes = Array.isArray(body.modes) ? body.modes : []
        const cleanModes = CATEGORY_ORDER.filter((c) => modes.includes(c))
        if (!cleanModes.length) throw new BackupError('Select at least one category to back up')
        const appTypes = Array.isArray(body.appTypes)
          ? PKG_TYPES.filter((t) => body.appTypes.includes(t))
          : PKG_TYPES.slice()
        requireSession(host)
        const job = startJob(host, 'backup', {
          modes: cleanModes,
          rev2: body.rev2 === undefined ? true : !!body.rev2,
          appTypes
        })
        sendJson(res, 200, { ok: true, job: publicJob(job) })
        return true
      }

      if (apiAction === 'restore' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const file = String(body.file || '')
        const modes = Array.isArray(body.modes)
          ? CATEGORY_ORDER.filter((c) => body.modes.includes(c))
          : []
        requireSession(host)
        const job = startJob(host, 'restore', { file, modes })
        sendJson(res, 200, { ok: true, job: publicJob(job) })
        return true
      }

      if (apiAction === 'cancel' && req.method === 'POST') {
        sendJson(res, 200, { ok: cancelJob(host) })
        return true
      }

      if (apiAction === 'wirelog' && req.method === 'GET') {
        const file = path.join(backupsDir, 'wire-' + normalizeHost(host).replace(/[^A-Za-z0-9._-]/g, '_') + '.log')
        const data = await fs.promises.readFile(file, 'utf8').catch(() => '')
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache'
        })
        res.end(data || '(no device traffic recorded yet)')
        return true
      }

      if (apiAction === 'wirelog' && req.method === 'DELETE') {
        const file = path.join(backupsDir, 'wire-' + normalizeHost(host).replace(/[^A-Za-z0-9._-]/g, '_') + '.log')
        await fs.promises.writeFile(file, '').catch(() => {})
        sendJson(res, 200, { ok: true })
        return true
      }

      if (apiAction === 'debug-http10' && req.method === 'GET') {
        const s = requireSession(host)
        const jarHeader = Array.from(sessionCookies(s), ([k, v]) => k + '=' + v).join('; ')
        const result = await http10StreamRequest(host, jarHeader, query.get('body') || 'type=app&opt=rev2&pkgtype=system,data,bin')
        sendJson(res, 200, result)
        return true
      }

      if (apiAction === 'files' && req.method === 'GET') {
        sendJson(res, 200, { files: await listBackupFiles() })
        return true
      }

      if (apiAction === 'download' && req.method === 'GET') {
        const filePath = safeBackupName(String(query.get('file') || ''))
        if (!filePath) throw new BackupError('Unknown backup file')
        const st = await fs.promises.stat(filePath).catch(() => null)
        if (!st || !st.isFile()) throw new BackupError('Backup file not found')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': st.size,
          'content-disposition': 'attachment; filename="' + path.basename(filePath) + '"',
          'cache-control': 'no-cache'
        })
        fs.createReadStream(filePath).pipe(res)
        return true
      }

      if (apiAction === 'delete' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const filePath = safeBackupName(String(body.file || ''))
        if (!filePath) throw new BackupError('Unknown backup file')
        await fs.promises.unlink(filePath).catch(() => {})
        sendJson(res, 200, { ok: true })
        return true
      }

      sendJson(res, 404, { error: 'Unknown backup endpoint' })
      return true
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        sessions.delete(host)
        sendJson(res, 401, { error: err.message, authRequired: true })
      } else if (err instanceof AuthFailedError) {
        sendJson(res, 401, { error: err.message, authFailed: true })
      } else if (err instanceof BusyError) {
        sendJson(res, 409, { error: err.message })
      } else if (err instanceof CancelledError) {
        sendJson(res, 409, { error: err.message })
      } else if (err instanceof BackupError) {
        sendJson(res, 502, { error: err.message })
      } else {
        sendJson(res, 500, { error: err.message })
      }
      return true
    }
  }
}

module.exports = {
  createBackupHandler,
  hashPass,
  crc32,
  ZipWriter,
  zipOpen,
  zipEntryStream
}
