;(function () {
  'use strict'

  var HOST = normalizeHost(new URLSearchParams(location.search).get('host'))
  var DEFAULT_FONT = '/usr/fonts/font_repository/monotype/andalemo.ttf'
  var DEFAULT_CONFIG = [
    'font_path = "' + DEFAULT_FONT + '";',
    'font_size = 24;',
    'text_color = [ 255, 255, 255 ];',
    'background_color = [ 0, 0, 0 ];',
    'screen_idle_awake = false;',
    'auto_show_vkb = true;',
    'allow_resize_columns = false;',
    'tty_encoding = "UTF-8";',
    ''
  ].join('\n')

  var THEMES = [
    { name: 'Default', fg: '#ffffff', bg: '#000000' },
    { name: 'BerryCore', fg: '#eeeeee', bg: '#300a24' },
    { name: 'Solarized Dark', fg: '#839496', bg: '#002b36' },
    { name: 'Solarized Light', fg: '#657b83', bg: '#fdf6e3' },
    { name: 'Gruvbox Dark', fg: '#ebdbb2', bg: '#282828' },
    { name: 'Nord', fg: '#d8dee9', bg: '#2e3440' },
    { name: 'Dracula', fg: '#f8f8f2', bg: '#282a36' },
    { name: 'Green', fg: '#00ff00', bg: '#000000' },
    { name: 'Amber', fg: '#ffb000', bg: '#000000' },
    { name: 'Paper', fg: '#1f2937', bg: '#f8fafc' }
  ]

  var el = {}
  var ws = null
  var connected = false
  var busy = false
  var canWrite = false
  var configText = ''
  var configMode = 'auto'
  var configName = 'term49rc'
  var status = {}
  var queue = Promise.resolve()
  var active = null
  var dirty = false
  var classicStatus = {}
  var classicUploaded = false
  var classicPromise = null
  var classicTimer = null

  function normalizeHost (value) {
    var host = String(value || '').trim()
    if (!host) return ''
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    host = host.replace(/[/?#].*$/, '')
    host = host.replace(/\/+$/, '')
    return host.toLowerCase()
  }

  function $(id) {
    return document.getElementById(id)
  }

  function cacheElements () {
    var ids = [
      'head-host', 'device-link', 'banner-card', 'banner', 'conn-state', 'reconnect',
      'reload', 'term-hint', 'st-home', 'st-config', 'st-state', 'st-size', 'config-file', 'theme-list',
      'fg-color', 'fg-hex', 'bg-color', 'bg-hex', 'preview', 'font-path', 'font-list',
      'font-size', 'font-size-range', 'scan-fonts', 'default-font', 'auto-show-vkb',
      'screen-awake', 'allow-resize', 'tty-encoding', 'save', 'copy-config', 'save-note',
      'advanced-config', 'save-raw', 'log', 'clear-log',
      'classic-state', 'cl-toolchain', 'cl-deps', 'cl-build', 'cl-runtime', 'cl-auto', 'cl-running',
      'cl-note', 'cl-refresh', 'cl-toolchain-btn', 'cl-fetch-btn', 'cl-build-btn', 'cl-install-btn',
      'cl-enable-btn', 'cl-disable-btn', 'cl-launch-btn', 'cl-stop-btn', 'cl-log',
      'cl-log-build', 'cl-log-fetch', 'cl-log-tc', 'cl-log-term'
    ]
    ids.forEach(function (id) {
      el[id] = $(id)
    })
  }

  function timestamp () {
    return new Date().toLocaleTimeString()
  }

  function log (text) {
    if (!el.log) return
    var line = '[' + timestamp() + '] ' + String(text)
    el.log.textContent += (el.log.textContent ? '\n' : '') + line
    if (el.log.textContent.length > 120000) {
      el.log.textContent = el.log.textContent.slice(-90000)
    }
    el.log.scrollTop = el.log.scrollHeight
  }

  function clean (text) {
    return String(text || '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x08/g, '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function showBanner (text, kind) {
    el.banner.textContent = text
    el.banner.className = 'term-banner' + (kind ? ' ' + kind : '')
    el['banner-card'].hidden = false
  }

  function hideBanner () {
    el['banner-card'].hidden = true
  }

  function setConnection (state, text) {
    el['conn-state'].textContent = text
    el['conn-state'].className = 'badge' + (state ? ' ' + state : '')
  }

  function setBusy (value, label) {
    busy = value
    if (value && label) log(label)
    updateButtons()
  }

  function updateButtons () {
    if (!el.reconnect) return
    el.reconnect.disabled = busy
    el.reload.disabled = !connected || busy
    el.save.disabled = !connected || busy || !canWrite
    el['save-raw'].disabled = !connected || busy || !canWrite
    el['scan-fonts'].disabled = !connected || busy
    el['config-file'].disabled = busy
    updateClassicButtons()
  }

  function wsUrl () {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return scheme + '//' + location.host + '/term/' + encodeURIComponent(HOST) + '/ws'
  }

  function makeToken () {
    return 'BB10TM' + Math.random().toString(16).slice(2) + Date.now().toString(16)
  }

  function connect () {
    if (!HOST) return
    if (ws) {
      try { ws.close() } catch (err) { }
    }
    connected = false
    canWrite = false
    status = {}
    updateButtons()
    setConnection('warn', 'Connecting\u2026')
    log('Connecting to term49-web for ' + HOST)

    var socket = new WebSocket(wsUrl())
    ws = socket

    socket.onopen = function () {
      if (ws !== socket) return
      connected = true
      setConnection('ok', 'Connected')
      el['term-hint'].hidden = true
      log('Connected to term49-web')
      runCommand('stty -echo 2>/dev/null; PS1=""; unset PROMPT_COMMAND; true', 5000)
        .then(refreshStatus)
        .then(function () {
          if (canWrite) return loadConfig()
        })
        .then(function () {
          return refreshClassic().catch(function () { })
        })
        .catch(function (err) {
          log('Term49 settings setup failed: ' + err.message)
        })
    }

    socket.onmessage = function (event) {
      if (ws !== socket) return
      if (typeof event.data !== 'string') return
      if (!active) return
      active.data += event.data
      checkActive()
    }

    socket.onerror = function () {
      if (ws !== socket) return
      setConnection('bad', 'Error')
    }

    socket.onclose = function () {
      if (ws !== socket) return
      connected = false
      canWrite = false
      if (active) {
        clearTimeout(active.timer)
        var reject = active.reject
        active = null
        reject(new Error('term49-web connection closed'))
      }
      setConnection('bad', 'Disconnected')
      el['term-hint'].hidden = false
      showBanner('Could not reach term49-web on ' + HOST + '. Start it in Term49, then reconnect.', 'bad')
      log('term49-web disconnected')
      updateButtons()
    }
  }

  function checkActive () {
    if (!active) return
    var beginIndex = active.data.lastIndexOf(active.begin)
    if (beginIndex < 0) return
    var afterBegin = active.data.slice(beginIndex + active.begin.length)
    var endIndex = afterBegin.indexOf(active.end)
    if (endIndex < 0) return
    var output = afterBegin.slice(0, endIndex)
    var afterEnd = afterBegin.slice(endIndex + active.end.length)
    var codeMatch = afterEnd.match(/^(\d+)/)
    if (!codeMatch) return

    var current = active
    active = null
    clearTimeout(current.timer)
    current.resolve({ output: clean(output), code: Number(codeMatch[1]) })
  }

  function runCommand (command, timeoutMs) {
    var task = function () {
      return new Promise(function (resolve, reject) {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('term49-web is not connected'))
          return
        }
        var token = makeToken()
        active = {
          begin: token + '_B',
          end: token + '_E:',
          data: '',
          resolve: resolve,
          reject: reject,
          timer: null
        }
        active.timer = setTimeout(function () {
          if (!active) return
          var partial = clean(active.data)
          active = null
          try { ws.send('\x03') } catch (err) { }
          reject(new Error('Timed out waiting for the device shell' + (partial ? '\n' + partial : '')))
        }, timeoutMs || 15000)

        var wrapped = 'M=' + token +
          '; printf "\\n${M}_B\\n"; { ' + command + ' ; } 2>&1; RC=$?; ' +
          'printf "\\n${M}_E:%s\\n" "$RC"\n'
        ws.send(wrapped)
      })
    }
    var result = queue.then(task, task)
    queue = result.catch(function () { })
    return result
  }

  function homePrefix () {
    return 'D="${SANDBOX:+$SANDBOX/data}"; [ -n "$D" ] || D="$HOME"; P="$D/.term49rc"; Q="$D/.term48rc"; R="$D/.term49cjkrc"; '
  }

  function configFile () {
    if (configName === 'term48rc') return '.term48rc'
    if (configName === 'term49cjkrc') return '.term49cjkrc'
    return '.term49rc'
  }

  function configPrefix () {
    return homePrefix() + 'F="$D/' + configFile() + '"; '
  }

  function configPath () {
    var home = String(status.HOME || '').replace(/\/+$/, '')
    return (home ? home : '~') + '/' + configFile()
  }

  function chooseConfigName () {
    if (configMode !== 'auto') return configMode
    var path = String(status.SANDBOX || '') + ' ' + String(status.HOME || '')
    var berryCore = /com\.update\.Term49|Term48/i.test(path)
    var hasCjk = status.HASCJK === '1'
    var has49 = status.HAS49 === '1'
    var has48 = status.HAS48 === '1'
    // The Classic companion reads .term49cjkrc when its auto-start is enabled.
    if (hasCjk && status.AUTO === '1') return 'term49cjkrc'
    if (has49 && !has48) return 'term49rc'
    if (has48 && !has49) return 'term48rc'
    if (hasCjk) return 'term49cjkrc'
    if (has49 && has48) return berryCore ? 'term48rc' : 'term49rc'
    return berryCore ? 'term48rc' : 'term49rc'
  }

  function updateConfigOptions () {
    var auto = el['config-file'].querySelector('option[value="auto"]')
    var optionCjk = el['config-file'].querySelector('option[value="term49cjkrc"]')
    var option49 = el['config-file'].querySelector('option[value="term49rc"]')
    var option48 = el['config-file'].querySelector('option[value="term48rc"]')
    if (!auto || !option49 || !option48) return
    auto.textContent = 'Auto-detect (.' + configName + ')'
    if (optionCjk) optionCjk.textContent = '.term49cjkrc' + (status.HASCJK === '1' ? ' \u2014 present' : '')
    option49.textContent = '.term49rc' + (status.HAS49 === '1' ? ' \u2014 present' : '')
    option48.textContent = '.term48rc' + (status.HAS48 === '1' ? ' \u2014 present' : '')
    el.save.textContent = 'Save to ' + configFile()
  }

  function parseStatus (text) {
    var parsed = {}
    String(text || '').split('\n').forEach(function (line) {
      var match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (match) parsed[match[1]] = match[2]
    })
    return parsed
  }

  function refreshStatus () {
    if (!connected) return Promise.reject(new Error('not connected'))
    return runCommand(homePrefix() +
      'printf "HOME=%s\\n" "$D"; ' +
      'printf "SANDBOX=%s\\n" "${SANDBOX-}"; ' +
      'if [ -d "$D" ] && [ -w "$D" ]; then printf "DIRWRITE=1\\n"; fi; ' +
      'if [ -f "$P" ]; then printf "HAS49=1\\n"; ' +
      'S=$(wc -c < "$P" 2>/dev/null | tr -d " "); printf "SIZE49=%s\\n" "$S"; fi; ' +
      'if [ -f "$Q" ]; then printf "HAS48=1\\n"; ' +
      'S=$(wc -c < "$Q" 2>/dev/null | tr -d " "); printf "SIZE48=%s\\n" "$S"; fi; ' +
      'if [ -f "$R" ]; then printf "HASCJK=1\\n"; ' +
      'S=$(wc -c < "$R" 2>/dev/null | tr -d " "); printf "SIZECJK=%s\\n" "$S"; fi; ' +
      '[ -f /accounts/1000/shared/misc/term49-cjk/enabled ] && printf "AUTO=1\\n"; ' +
      'true', 15000).then(function (result) {
      status = parseStatus(result.output)
      canWrite = status.DIRWRITE === '1'
      configName = chooseConfigName()
      var hasActive = configName === 'term49rc' ? status.HAS49 === '1'
        : configName === 'term48rc' ? status.HAS48 === '1'
          : status.HASCJK === '1'
      var activeSize = configName === 'term49rc' ? status.SIZE49
        : configName === 'term48rc' ? status.SIZE48
          : status.SIZECJK

      el['st-home'].textContent = status.HOME || '\u2014'
      el['st-home'].title = status.HOME || ''
      el['st-config'].textContent = configPath()
      el['st-config'].title = configPath()
      if (hasActive) {
        el['st-state'].textContent = 'present'
        el['st-state'].className = 'ok'
      } else {
        el['st-state'].textContent = 'not created yet'
        el['st-state'].className = 'bad'
      }
      el['st-size'].textContent = activeSize ? activeSize + ' bytes' : '\u2014'
      el['config-file'].value = configMode
      updateConfigOptions()

      if (!HOST) {
        showBanner('No device selected. Open a device from the list.', 'bad')
      } else if (!canWrite) {
        showBanner('Term49 home is not writable: ' + (status.HOME || 'unknown') + '. Start term49-web from Term49 on the device.', 'bad')
      } else if (status.HAS49 === '1' && status.HAS48 === '1') {
        showBanner('Both .term49rc and .term48rc exist. Currently editing ' + configFile() + '. If Term49 ignores changes, select the other file above.', 'warn')
      } else if (!status.SANDBOX) {
        showBanner('SANDBOX is not set. Using detected Term49 home: ' + (status.HOME || 'unknown') + '. Start term49-web from Term49 if this is wrong.', 'warn')
      } else {
        hideBanner()
      }
      updateButtons()
      return status
    }).catch(function (err) {
      canWrite = false
      updateButtons()
      throw err
    })
  }

  function atobBytes (text) {
    var binary = atob(text)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function fromBase64 (text) {
    var b64 = String(text || '').replace(/\s+/g, '')
    while (b64.length % 4) b64 += '='
    if (window.TextDecoder) {
      try {
        return new TextDecoder('utf-8').decode(atobBytes(b64))
      } catch (err) { }
    }
    return decodeURIComponent(escape(atob(b64)))
  }

  function toBase64 (text) {
    try {
      return btoa(unescape(encodeURIComponent(text)))
    } catch (err) {
      return btoa(text)
    }
  }

  function loadConfig () {
    if (!connected || !canWrite) return Promise.resolve()
    setBusy(true, 'Loading Term49 configuration\u2026')
    return runCommand(configPrefix() +
      'if [ -f "$F" ]; then printf "TERM49RC_BEGIN\\n"; base64 "$F"; printf "\\nTERM49RC_END\\n"; ' +
      'else printf "TERM49RC_MISSING\\n"; fi', 20000).then(function (result) {
      var output = result.output || ''
      if (output.indexOf('TERM49RC_MISSING') >= 0) {
        configText = DEFAULT_CONFIG
        applyConfig(configText)
        log('No ' + configFile() + ' found. Save to create one.')
        return
      }
      var start = output.indexOf('TERM49RC_BEGIN')
      var end = output.indexOf('TERM49RC_END', start + 1)
      if (start < 0 || end < 0) throw new Error('Could not read ' + configFile())
      var body = output.slice(start + 'TERM49RC_BEGIN'.length, end)
      configText = fromBase64(body)
      applyConfig(configText)
      log('Loaded ' + configPath())
    }).catch(function (err) {
      log('Could not load ' + configFile() + ': ' + err.message)
    }).then(function () {
      setBusy(false)
    })
  }

  function skipBlockComment (text, index) {
    var end = text.indexOf('*/', index + 2)
    return end < 0 ? text.length : end + 2
  }

  function skipLineComment (text, index) {
    var end = text.indexOf('\n', index)
    return end < 0 ? text.length : end + 1
  }

  function skipSpaceAndComments (text, index) {
    var i = index
    var n = text.length
    while (i < n) {
      var ch = text.charAt(i)
      var next = text.charAt(i + 1)
      if (/\s/.test(ch)) {
        i++
      } else if (ch === '/' && next === '/') {
        i = skipLineComment(text, i)
      } else if (ch === '/' && next === '*') {
        i = skipBlockComment(text, i)
      } else if (ch === '#') {
        i = skipLineComment(text, i)
      } else {
        break
      }
    }
    return i
  }

  function scanValue (text, index) {
    var i = index
    var n = text.length
    var depth = 0
    var inString = false
    while (i < n) {
      var ch = text.charAt(i)
      var next = text.charAt(i + 1)
      if (inString) {
        if (ch === '\\') {
          i += 2
        } else {
          if (ch === '"') inString = false
          i++
        }
        continue
      }
      if (ch === '"') {
        inString = true
        i++
        continue
      }
      if (ch === '/' && next === '/') {
        i = skipLineComment(text, i)
        continue
      }
      if (ch === '/' && next === '*') {
        i = skipBlockComment(text, i)
        continue
      }
      if (ch === '#') {
        i = skipLineComment(text, i)
        continue
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++
        i++
        continue
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth > 0) depth--
        i++
        continue
      }
      if (ch === ';' && depth === 0) return i
      i++
    }
    return i
  }

  function parseAssignments (text) {
    var source = String(text || '')
    var result = []
    var i = 0
    var n = source.length
    while (i < n) {
      i = skipSpaceAndComments(source, i)
      if (i >= n) break
      var ch = source.charAt(i)
      if (!/[A-Za-z_]/.test(ch)) {
        i++
        continue
      }
      var keyStart = i
      while (i < n && /[A-Za-z0-9_-]/.test(source.charAt(i))) i++
      var key = source.slice(keyStart, i)
      var afterKey = skipSpaceAndComments(source, i)
      if (source.charAt(afterKey) !== '=' && source.charAt(afterKey) !== ':') {
        i = afterKey + 1
        continue
      }
      var valueStart = afterKey + 1
      var valueEnd = scanValue(source, valueStart)
      result.push({
        key: key,
        keyStart: keyStart,
        valueStart: valueStart,
        valueEnd: valueEnd,
        end: Math.min(valueEnd + 1, n)
      })
      i = Math.min(valueEnd + 1, n)
    }
    return result
  }

  function assignmentFor (text, key) {
    var list = parseAssignments(text)
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i]
    }
    return null
  }

  function rawValue (text, key) {
    var assignment = assignmentFor(text, key)
    if (!assignment) return ''
    return text.slice(assignment.valueStart, assignment.valueEnd).trim()
  }

  function setValue (text, key, value) {
    var source = String(text || '')
    var assignment = assignmentFor(source, key)
    if (!assignment) {
      return source.replace(/\s*$/, '') + '\n' + key + ' = ' + value + ';\n'
    }
    var raw = source.slice(assignment.valueStart, assignment.valueEnd)
    var lead = raw.match(/^\s*/)[0]
    var trail = raw.match(/\s*$/)[0]
    return source.slice(0, assignment.valueStart) + lead + value + trail + source.slice(assignment.valueEnd)
  }

  function decodeLibString (value) {
    var match = String(value || '').trim().match(/^"([\s\S]*)"$/)
    if (!match) return String(value || '').trim()
    return match[1].replace(/\\(x[0-9a-fA-F]{2}|[\s\S])/g, function (all, esc) {
      if (esc.charAt(0) === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16))
      switch (esc) {
        case 'n': return '\n'
        case 'r': return '\r'
        case 't': return '\t'
        case 'b': return '\b'
        case 'f': return '\f'
        case '\\': return '\\'
        case '"': return '"'
        default: return esc
      }
    })
  }

  function quoteLibString (value) {
    return '"' + String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') + '"'
  }

  function parseColor (value) {
    var match = String(value || '').match(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/)
    if (!match) return null
    return [
      Math.max(0, Math.min(255, Number(match[1]))),
      Math.max(0, Math.min(255, Number(match[2]))),
      Math.max(0, Math.min(255, Number(match[3])))
    ]
  }

  function parseBoolean (value, fallback) {
    var text = String(value || '').trim().toLowerCase()
    if (text === 'true') return true
    if (text === 'false') return false
    return fallback
  }

  function parseInteger (value, fallback) {
    var number = Number(String(value || '').trim())
    return isFinite(number) ? Math.round(number) : fallback
  }

  function normalizeHex (value) {
    var match = String(value || '').trim().match(/^#?([0-9a-fA-F]{6})$/)
    return match ? '#' + match[1].toLowerCase() : null
  }

  function rgbToHex (color) {
    return '#' + color.map(function (part) {
      return ('0' + Number(part).toString(16)).slice(-2)
    }).join('')
  }

  function hexToRgb (hex) {
    var value = normalizeHex(hex)
    if (!value) return null
    return [
      parseInt(value.slice(1, 3), 16),
      parseInt(value.slice(3, 5), 16),
      parseInt(value.slice(5, 7), 16)
    ]
  }

  function applyConfig (text) {
    var source = String(text || DEFAULT_CONFIG)
    var fg = parseColor(rawValue(source, 'text_color')) || [255, 255, 255]
    var bg = parseColor(rawValue(source, 'background_color')) || [0, 0, 0]
    var fontPath = decodeLibString(rawValue(source, 'font_path')) || DEFAULT_FONT
    var fontSize = parseInteger(rawValue(source, 'font_size'), 24)
    var autoVkb = parseBoolean(rawValue(source, 'auto_show_vkb'), true)
    var screenAwake = parseBoolean(rawValue(source, 'screen_idle_awake'), false)
    var allowResize = parseBoolean(rawValue(source, 'allow_resize_columns'), false)
    var encoding = decodeLibString(rawValue(source, 'tty_encoding')) || 'UTF-8'

    el['fg-color'].value = rgbToHex(fg)
    el['fg-hex'].value = rgbToHex(fg)
    el['bg-color'].value = rgbToHex(bg)
    el['bg-hex'].value = rgbToHex(bg)
    el['font-path'].value = fontPath
    el['font-size'].value = String(fontSize)
    el['font-size-range'].value = String(Math.max(6, Math.min(72, fontSize)))
    el['auto-show-vkb'].checked = autoVkb
    el['screen-awake'].checked = screenAwake
    el['allow-resize'].checked = allowResize
    el['tty-encoding'].value = encoding
    el['advanced-config'].value = source
    dirty = false
    el['save-note'].textContent = ''
    el['save-note'].className = 'term-save-note'
    markTheme()
    updatePreview()
  }

  function buildConfig () {
    var source = configText || DEFAULT_CONFIG
    var fg = hexToRgb(el['fg-color'].value) || [255, 255, 255]
    var bg = hexToRgb(el['bg-color'].value) || [0, 0, 0]
    var fontPath = String(el['font-path'].value || '').trim() || DEFAULT_FONT
    var fontSize = parseInteger(el['font-size'].value, 24)
    var encoding = String(el['tty-encoding'].value || '').trim() || 'UTF-8'

    source = setValue(source, 'font_path', quoteLibString(fontPath))
    source = setValue(source, 'font_size', String(fontSize))
    source = setValue(source, 'text_color', '[ ' + fg.join(', ') + ' ]')
    source = setValue(source, 'background_color', '[ ' + bg.join(', ') + ' ]')
    source = setValue(source, 'auto_show_vkb', el['auto-show-vkb'].checked ? 'true' : 'false')
    source = setValue(source, 'screen_idle_awake', el['screen-awake'].checked ? 'true' : 'false')
    source = setValue(source, 'allow_resize_columns', el['allow-resize'].checked ? 'true' : 'false')
    source = setValue(source, 'tty_encoding', quoteLibString(encoding))
    return source.replace(/\s*$/, '\n')
  }

  function markDirty () {
    dirty = true
    el['save-note'].textContent = 'Unsaved changes'
    el['save-note'].className = 'term-save-note dirty'
  }

  function updatePreview () {
    var fg = normalizeHex(el['fg-hex'].value) || '#ffffff'
    var bg = normalizeHex(el['bg-hex'].value) || '#000000'
    var size = parseInteger(el['font-size'].value, 14)
    if (size < 8) size = 8
    if (size > 32) size = 32
    el.preview.style.setProperty('--preview-fg', fg)
    el.preview.style.setProperty('--preview-bg', bg)
    el.preview.style.setProperty('--preview-size', size + 'px')
  }

  function findTheme () {
    var fg = normalizeHex(el['fg-hex'].value)
    var bg = normalizeHex(el['bg-hex'].value)
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].fg === fg && THEMES[i].bg === bg) return i
    }
    return -1
  }

  function markTheme () {
    var active = findTheme()
    var buttons = el['theme-list'].querySelectorAll('.term-theme')
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', Number(buttons[i].getAttribute('data-theme')) === active)
    }
  }

  function renderThemes () {
    THEMES.forEach(function (theme, index) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'term-theme'
      button.setAttribute('data-theme', String(index))
      button.title = 'Text ' + theme.fg + ', background ' + theme.bg

      var swatch = document.createElement('span')
      swatch.className = 'term-swatch'
      swatch.style.background = theme.bg
      swatch.style.color = theme.fg
      swatch.textContent = 'Aa'

      var name = document.createElement('span')
      name.className = 'term-theme-name'
      name.textContent = theme.name

      button.appendChild(swatch)
      button.appendChild(name)
      button.addEventListener('click', function () {
        el['fg-color'].value = theme.fg
        el['fg-hex'].value = theme.fg
        el['bg-color'].value = theme.bg
        el['bg-hex'].value = theme.bg
        markDirty()
        markTheme()
        updatePreview()
      })
      el['theme-list'].appendChild(button)
    })
  }

  function setColor (which, value) {
    var hex = normalizeHex(value)
    if (!hex) return false
    el[which + '-color'].value = hex
    el[which + '-hex'].value = hex
    return true
  }

  function uploadConfig (text) {
    var encoded = toBase64(text)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var init = homePrefix() + 'rm -f "$D/.term49cfg.b64"; : > "$D/.term49cfg.b64"'
    var final = configPrefix() +
      'if base64 -d "$D/.term49cfg.b64" > "$D/.term49cfg.new" 2>/dev/null; then ' +
      'if [ -f "$F" ]; then cp "$F" "$F.bak"; fi; ' +
      'mv "$D/.term49cfg.new" "$F" && printf "TERM49RC_SAVED\\n"; ' +
      'else rm -f "$D/.term49cfg.new"; printf "TERM49RC_FAILED\\n"; fi; ' +
      'rm -f "$D/.term49cfg.b64"'
    return runCommand(init, 15000).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          if (index === 0 || (index + 1) % 5 === 0 || index === chunks.length - 1) {
            log('Uploading configuration ' + (index + 1) + '/' + chunks.length + '\u2026')
          }
          return runCommand(homePrefix() + 'printf "%s" "' + chunk + '" >> "$D/.term49cfg.b64"', 15000)
        })
      })
      return chain
    }).then(function () {
      return runCommand(final, 20000)
    }).then(function (result) {
      if ((result.output || '').indexOf('TERM49RC_SAVED') < 0) {
        throw new Error('Could not write ' + configFile() + ' on the device')
      }
      log('Saved ' + configPath())
    })
  }

  function saveConfig (text, label) {
    if (!connected || !canWrite || busy) return
    setBusy(true, label)
    uploadConfig(text).then(function () {
      configText = text
      el['advanced-config'].value = text
      dirty = false
      el['save-note'].textContent = 'Saved \u2014 reopen Term49 to apply'
      el['save-note'].className = 'term-save-note'
      return refreshStatus()
    }).catch(function (err) {
      log('Error: ' + err.message)
      el['save-note'].textContent = 'Save failed'
      el['save-note'].className = 'term-save-note dirty'
    }).then(function () {
      setBusy(false)
    })
  }

  function saveForm () {
    if (dirty && el['advanced-config'].value && el['advanced-config'].value !== configText) {
      var raw = el['advanced-config'].value
      if (!window.confirm('The raw config editor has changes that are not reflected in the form. Save the form and discard those raw edits?')) {
        return
      }
    }
    saveConfig(buildConfig(), 'Saving Term49 configuration\u2026')
  }

  function saveRaw () {
    var text = String(el['advanced-config'].value || '')
    if (!text.trim()) {
      log('Refusing to save an empty configuration.')
      return
    }
    saveConfig(text.replace(/\s*$/, '\n'), 'Saving raw Term49 configuration\u2026')
  }

  function scanFonts () {
    if (!connected) return
    setBusy(true, 'Scanning device fonts\u2026')
    runCommand(homePrefix() +
      'for base in "$D" /usr/fonts/font_repository /accounts/1000/shared/misc; do ' +
      '[ -d "$base" ] && find "$base" 2>/dev/null; done | grep -E -i "\\.(ttf|otf)$" | head -300', 30000)
      .then(function (result) {
        var seen = {}
        var fonts = []
        String(result.output || '').split('\n').forEach(function (line) {
          var path = line.trim()
          if (!path || path.charAt(0) !== '/') return
          if (seen[path]) return
          seen[path] = true
          fonts.push(path)
        })
        el['font-list'].textContent = ''
        fonts.forEach(function (path) {
          var option = document.createElement('option')
          option.value = path
          el['font-list'].appendChild(option)
        })
        log(fonts.length ? 'Found ' + fonts.length + ' font files.' : 'No .ttf or .otf files found.')
      })
      .catch(function (err) {
        log('Font scan failed: ' + err.message)
      })
      .then(function () {
        setBusy(false)
      })
  }

  function copyConfig () {
    var advanced = el['advanced-config'].value
    var text = dirty && advanced && advanced !== configText ? advanced : buildConfig()
    function done (ok) {
      log(ok ? 'Configuration copied.' : 'Copy failed; select the raw config manually.')
      if (ok) {
        el['save-note'].textContent = 'Copied'
        el['save-note'].className = 'term-save-note'
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true) }, function () { done(false) })
      return
    }
    var area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
      done(true)
    } catch (err) {
      done(false)
    }
    document.body.removeChild(area)
  }

  function reloadConfig () {
    if (dirty && typeof window.confirm === 'function' &&
      !window.confirm('Discard unsaved changes and reload ' + configFile() + ' from the device?')) {
      return
    }
    withBusy('Reloading configuration\u2026', function () {
      return refreshStatus().then(function () {
        if (canWrite) return loadConfig()
      })
    })
  }

  function withBusy (label, task) {
    if (busy || !connected) return
    setBusy(true, label)
    Promise.resolve()
      .then(task)
      .catch(function (err) {
        log('Error: ' + err.message)
      })
      .then(function () {
        setBusy(false)
      })
  }

  var CLASSIC_VERSION = '1'

  function classicPrefix () {
    return 'D="${SANDBOX:+$SANDBOX/data}"; [ -n "$D" ] || D="$HOME"; CD="$D/.classic"; '
  }

  function classicCheckCommand () {
    return classicPrefix() +
      'if [ -f "$CD/term49-classic.sh" ] && grep -q "^CLASSIC_HELPER_VERSION=' + CLASSIC_VERSION + '$" "$CD/term49-classic.sh" 2>/dev/null; then echo CLASSIC_OK; else echo CLASSIC_MISSING; fi'
  }

  function uploadClassicHelper (text) {
    var encoded = toBase64(text)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var initCmd = classicPrefix() + 'mkdir -p "$CD"; chmod 700 "$CD"; rm -f "$CD/.helper.b64"; : > "$CD/.helper.b64"'
    var finalCmd = classicPrefix() +
      'if base64 -d "$CD/.helper.b64" > "$CD/term49-classic.sh" 2>/dev/null; then chmod 700 "$CD/term49-classic.sh"; echo CLASSIC_UPLOADED; else echo CLASSIC_UPLOAD_FAILED; fi; rm -f "$CD/.helper.b64"'
    return runCommand(initCmd, 15000).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          if (index === 0 || (index + 1) % 8 === 0 || index === chunks.length - 1) {
            log('Uploading Classic helper ' + (index + 1) + '/' + chunks.length + '\u2026')
          }
          return runCommand('printf "%s" "' + chunk + '" >> "$CD/.helper.b64"', 15000)
        })
      })
      return chain
    }).then(function () {
      return runCommand(finalCmd, 15000)
    }).then(function (result) {
      if (result.output.indexOf('CLASSIC_UPLOADED') < 0) {
        throw new Error('Could not install the Classic helper on the device')
      }
      classicUploaded = true
      log('Classic helper installed in Term49 home')
    })
  }

  function ensureClassicHelper () {
    if (classicUploaded) return Promise.resolve()
    if (classicPromise) return classicPromise
    classicPromise = runCommand(classicCheckCommand(), 10000)
      .then(function (result) {
        if (result.output.indexOf('CLASSIC_OK') >= 0) {
          classicUploaded = true
          return
        }
        return fetch('term49-classic.sh', { cache: 'no-store' }).then(function (response) {
          if (!response.ok) throw new Error('could not load term49-classic.sh from the app')
          return response.text()
        }).then(uploadClassicHelper)
      })
      .then(function () {
        classicPromise = null
      })
      .catch(function (err) {
        classicPromise = null
        throw err
      })
    return classicPromise
  }

  function classicRun (action, timeout) {
    return ensureClassicHelper().then(function () {
      return runCommand(classicPrefix() + 'sh "$CD/term49-classic.sh" ' + action, timeout || 30000)
    })
  }

  function classicMark (element, ok, text) {
    if (!element) return
    element.textContent = text
    element.className = ok === true ? 'ok' : ok === false ? 'bad' : ''
  }

  function classicJobsBusy () {
    return classicStatus.TC_JOB === 'running' ||
      classicStatus.FETCH_JOB === 'running' ||
      classicStatus.BUILD_JOB === 'running'
  }

  function stopClassicPoll () {
    if (classicTimer) {
      clearInterval(classicTimer)
      classicTimer = null
    }
  }

  function startClassicPoll () {
    stopClassicPoll()
    classicTimer = setInterval(function () {
      if (!connected || busy || active) return
      refreshClassic().catch(function () { })
    }, 4000)
  }

  function refreshClassic () {
    if (!el['cl-refresh']) return Promise.resolve()
    if (!connected) return Promise.reject(new Error('not connected'))
    return classicRun('status', 30000).then(function (result) {
      classicStatus = parseStatus(result.output)
      var jobsRunning = classicJobsBusy()

      classicMark(el['cl-toolchain'], classicStatus.TOOLCHAIN === '1',
        classicStatus.TOOLCHAIN === '1' ? 'gcc 4.6.3 + SDK' : 'not installed')
      var deps = classicStatus.TREE === '1' && classicStatus.DEPS === '1'
      classicMark(el['cl-deps'], deps,
        deps ? 'ready' + (classicStatus.TKVER ? ' (' + classicStatus.TKVER + ')' : '') : 'not fetched')
      var buildState = classicStatus.BUILD_JOB || 'none'
      var buildText = buildState === 'running' ? 'building\u2026'
        : buildState === 'ok' ? (classicStatus.BUILT === '1' ? 'built' : 'done')
          : buildState.indexOf('failed') === 0 ? buildState
            : classicStatus.BUILT === '1' ? 'built' : '\u2014'
      classicMark(el['cl-build'], classicStatus.BUILT === '1' && buildState !== 'failed:0', buildText)
      classicMark(el['cl-runtime'], classicStatus.RUNTIME === '1' && classicStatus.BIN === '1',
        classicStatus.BIN === '1' ? (classicStatus.RUNTIME === '1' ? 'installed' : 'partial') : 'not installed')
      classicMark(el['cl-auto'], classicStatus.AUTO === '1',
        classicStatus.AUTO === '1' ? 'enabled' : 'disabled')
      classicMark(el['cl-running'], classicStatus.RUNNING !== '0' && classicStatus.RUNNING,
        classicStatus.RUNNING && classicStatus.RUNNING !== '0'
          ? 'pid ' + classicStatus.RUNNING
          : (classicStatus.FORE && classicStatus.FORE !== '0' ? 'idle (Term49 foreground)' : '\u2014'))

      var overall = classicStatus.RUNNING && classicStatus.RUNNING !== '0'
        ? 'running'
        : classicStatus.AUTO === '1' ? 'enabled' : classicStatus.BIN === '1' ? 'installed' : '\u2014'
      el['classic-state'].textContent = overall
      el['classic-state'].className = 'badge' +
        (overall === 'running' ? ' ok' : overall === 'enabled' ? ' ok' : '')

      updateClassicButtons()

      if (jobsRunning) startClassicPoll()
      else stopClassicPoll()
      return classicStatus
    })
  }

  function updateClassicButtons () {
    if (!el['cl-refresh']) return
    var s = classicStatus
    var idle = connected && !busy
    el['cl-refresh'].disabled = !connected || busy
    el['cl-toolchain-btn'].disabled = !(idle && s.TOOLCHAIN !== '1')
    el['cl-fetch-btn'].disabled = !idle
    el['cl-build-btn'].disabled = !(idle && s.TOOLCHAIN === '1' && s.TREE === '1' && s.DEPS === '1')
    el['cl-install-btn'].disabled = !(idle && s.BUILT === '1')
    el['cl-enable-btn'].disabled = !(idle && s.BIN === '1' && s.AUTO !== '1')
    el['cl-disable-btn'].disabled = !(idle && s.AUTO === '1')
    el['cl-launch-btn'].disabled = !(idle && s.BIN === '1' && (!s.RUNNING || s.RUNNING === '0'))
    el['cl-stop-btn'].disabled = !(idle && s.RUNNING && s.RUNNING !== '0')
  }

  function classicAction (name, label, timeout) {
    if (busy || !connected) return
    setBusy(true, label)
    classicRun(name, timeout || 60000).then(function (result) {
      if (result.output) log(result.output)
      return refreshClassic().then(function () {
        return refreshStatus().catch(function () { })
      })
    }).catch(function (err) {
      log('Error: ' + err.message)
      return refreshClassic().catch(function () { })
    }).then(function () {
      setBusy(false)
    })
  }

  function classicLogView (which) {
    if (busy || !connected) return
    setBusy(true, 'Reading ' + which + ' log\u2026')
    classicRun('log ' + which + ' 40', 30000).then(function (result) {
      el['cl-log'].textContent = result.output || '(empty)'
    }).catch(function (err) {
      log('Error: ' + err.message)
    }).then(function () {
      setBusy(false)
    })
  }

  function init () {
    cacheElements()
    configMode = el['config-file'].value || 'auto'
    renderThemes()
    if (!HOST) {
      el['head-host'].textContent = 'No device selected'
      showBanner('Open a device from the list, then choose Term49.', 'bad')
      setConnection('bad', 'No device')
      updateButtons()
      return
    }
    el['head-host'].textContent = 'Device ' + HOST
    el['device-link'].href = 'device.html?host=' + encodeURIComponent(HOST)
    el['device-link'].textContent = 'App manager'

    el['fg-color'].addEventListener('input', function () {
      setColor('fg', el['fg-color'].value)
      markDirty()
      markTheme()
      updatePreview()
    })
    el['bg-color'].addEventListener('input', function () {
      setColor('bg', el['bg-color'].value)
      markDirty()
      markTheme()
      updatePreview()
    })
    el['fg-hex'].addEventListener('input', function () {
      if (!setColor('fg', el['fg-hex'].value)) return
      markDirty()
      markTheme()
      updatePreview()
    })
    el['bg-hex'].addEventListener('input', function () {
      if (!setColor('bg', el['bg-hex'].value)) return
      markDirty()
      markTheme()
      updatePreview()
    })
    el['font-size-range'].addEventListener('input', function () {
      el['font-size'].value = el['font-size-range'].value
      markDirty()
      updatePreview()
    })
    el['font-size'].addEventListener('input', function () {
      var size = parseInteger(el['font-size'].value, 24)
      el['font-size-range'].value = String(Math.max(6, Math.min(72, size)))
      markDirty()
      updatePreview()
    })
    el['config-file'].addEventListener('change', function () {
      var next = el['config-file'].value
      if (next !== 'auto' && next !== 'term49rc' && next !== 'term48rc' && next !== 'term49cjkrc') next = 'auto'
      if (next === configMode) return
      if (dirty && typeof window.confirm === 'function' &&
        !window.confirm('Discard unsaved changes and switch config file?')) {
        el['config-file'].value = configMode
        return
      }
      configMode = next
      dirty = false
      if (!connected) {
        configName = chooseConfigName()
        el['st-config'].textContent = configPath()
        el.save.textContent = 'Save to ' + configFile()
        return
      }
      withBusy('Switching config file\u2026', function () {
        return refreshStatus().then(function () {
          if (canWrite) return loadConfig()
        })
      })
    })
    el['font-path'].addEventListener('input', markDirty)
    el['auto-show-vkb'].addEventListener('change', markDirty)
    el['screen-awake'].addEventListener('change', markDirty)
    el['allow-resize'].addEventListener('change', markDirty)
    el['tty-encoding'].addEventListener('input', markDirty)
    el['advanced-config'].addEventListener('input', markDirty)
    el['default-font'].addEventListener('click', function () {
      el['font-path'].value = DEFAULT_FONT
      markDirty()
    })
    el['scan-fonts'].addEventListener('click', scanFonts)
    el['save'].addEventListener('click', saveForm)
    el['save-raw'].addEventListener('click', saveRaw)
    el['copy-config'].addEventListener('click', copyConfig)
    el['reload'].addEventListener('click', reloadConfig)
    el['reconnect'].addEventListener('click', connect)
    el['clear-log'].addEventListener('click', function () { el.log.textContent = '' })

    if (el['cl-refresh']) {
      el['cl-refresh'].addEventListener('click', function () {
        withBusy('Refreshing companion status\u2026', refreshClassic)
      })
      el['cl-toolchain-btn'].addEventListener('click', function () {
        classicAction('toolchain', 'Installing GCC toolchain on the device (108 MB download)\u2026', 60000)
      })
      el['cl-fetch-btn'].addEventListener('click', function () {
        classicAction('fetch', 'Fetching toolkit source and dependencies on the device\u2026', 60000)
      })
      el['cl-build-btn'].addEventListener('click', function () {
        classicAction('build', 'Compiling Term49-Classic on the device\u2026', 60000)
      })
      el['cl-install-btn'].addEventListener('click', function () {
        if (typeof window.confirm === 'function' &&
          !window.confirm('Install the Term49-Classic runtime files? Your stock Term49 app is not modified.')) {
          return
        }
        classicAction('install', 'Installing companion runtime\u2026')
      })
      el['cl-enable-btn'].addEventListener('click', function () {
        if (typeof window.confirm === 'function' &&
          !window.confirm('Enable auto-start? This appends a guarded block to .profile (backed up first). ' +
            'Remove term49-cjk/enabled any time to return to stock Term49.')) {
          return
        }
        classicAction('enable', 'Enabling auto-start\u2026')
      })
      el['cl-disable-btn'].addEventListener('click', function () {
        classicAction('disable', 'Disabling auto-start\u2026')
      })
      el['cl-launch-btn'].addEventListener('click', function () {
        classicAction('launch', 'Launching companion (device must be unlocked with Term49 in the foreground)\u2026')
      })
      el['cl-stop-btn'].addEventListener('click', function () {
        classicAction('stop', 'Stopping companion\u2026')
      })
      el['cl-log-build'].addEventListener('click', function () { classicLogView('build') })
      el['cl-log-fetch'].addEventListener('click', function () { classicLogView('fetch') })
      el['cl-log-tc'].addEventListener('click', function () { classicLogView('tc') })
      el['cl-log-term'].addEventListener('click', function () { classicLogView('terminal') })
    }

    window.addEventListener('beforeunload', function (event) {
      if (dirty) {
        event.preventDefault()
        event.returnValue = ''
      }
      if (ws) {
        try { ws.close() } catch (err) { }
      }
    })

    updateButtons()
    connect()
  }

  init()
})()