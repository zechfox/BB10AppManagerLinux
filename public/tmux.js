;(function () {
  'use strict'

  var HOST = normalizeHost(new URLSearchParams(location.search).get('host'))
  var DEFAULT_CONFIG = '# ~/.tmux.conf for BerryCore tmux\n'
  var MANAGED_BEGIN = '# bb10-tmux:begin'
  var MANAGED_END = '# bb10-tmux:end'

  var el = {}
  var ws = null
  var connected = false
  var busy = false
  var canWrite = false
  var configText = ''
  var status = {}
  var sessions = []
  var queue = Promise.resolve()
  var active = null
  var dirty = false

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
      'reload', 'apply', 'term-hint', 'st-home', 'st-tmux', 'st-config', 'st-state',
      'st-size', 'st-server', 'session-list', 'mouse', 'base-index', 'renumber-windows',
      'status-bar', 'prefix', 'history', 'status-position', 'mode-keys', 'save',
      'copy-config', 'save-note', 'advanced-config', 'save-raw', 'log', 'clear-log'
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
    el.reconnect.disabled = busy
    el.reload.disabled = !connected || busy
    el.save.disabled = !connected || busy || !canWrite
    el['save-raw'].disabled = !connected || busy || !canWrite
    el.apply.disabled = !connected || busy || !canWrite ||
      status.SERVER !== '1' || !status.TMUX_BIN
  }

  function wsUrl () {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return scheme + '//' + location.host + '/term/' + encodeURIComponent(HOST) + '/ws'
  }

  function makeToken () {
    return 'BB10TX' + Math.random().toString(16).slice(2) + Date.now().toString(16)
  }

  function connect () {
    if (!HOST) return
    if (ws) {
      try { ws.close() } catch (err) { }
    }
    connected = false
    canWrite = false
    status = {}
    sessions = []
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
        .catch(function (err) {
          log('Tmux settings setup failed: ' + err.message)
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
    return 'D="${SANDBOX:+$SANDBOX/data}"; [ -n "$D" ] || D="$HOME"; F="$D/.tmux.conf"; '
  }

  function tmuxPrefix () {
    return 'N="${NATIVE_TOOLS:-/accounts/1000/shared/misc/berrycore}"; T=""; ' +
      'if command -v tmux >/dev/null 2>&1; then T=$(command -v tmux); ' +
      'elif [ -x "$N/bin/tmux" ]; then T="$N/bin/tmux"; fi; '
  }

  function configPath () {
    var home = String(status.HOME || '').replace(/\/+$/, '')
    return (home ? home : '~') + '/.tmux.conf'
  }

  function parseStatus (text) {
    var parsed = {}
    var list = []
    var inSessions = false
    String(text || '').split('\n').forEach(function (line) {
      if (line === 'SESSIONS_BEGIN') {
        inSessions = true
        return
      }
      if (line === 'SESSIONS_END') {
        inSessions = false
        return
      }
      if (inSessions) {
        if (line.trim()) list.push(line.trim())
        return
      }
      var match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (match) parsed[match[1]] = match[2]
    })
    parsed.SESSIONS_LIST = list
    return parsed
  }

  function renderSessions () {
    el['session-list'].textContent = ''
    if (!sessions.length) {
      el['session-list'].hidden = true
      return
    }
    el['session-list'].hidden = false
    sessions.forEach(function (name) {
      var chip = document.createElement('span')
      chip.className = 'tmux-session'
      chip.textContent = name
      el['session-list'].appendChild(chip)
    })
  }

  function refreshStatus () {
    if (!connected) return Promise.reject(new Error('not connected'))
    return runCommand(homePrefix() + tmuxPrefix() +
      'printf "HOME=%s\\n" "$D"; ' +
      'printf "SANDBOX=%s\\n" "${SANDBOX-}"; ' +
      'if [ -d "$D" ] && [ -w "$D" ]; then printf "DIRWRITE=1\\n"; fi; ' +
      'if [ -f "$F" ]; then printf "HASCONF=1\\n"; ' +
      'S=$(wc -c < "$F" 2>/dev/null | tr -d " "); printf "SIZE=%s\\n" "$S"; fi; ' +
      'if [ -n "$T" ]; then printf "TMUX_BIN=%s\\n" "$T"; ' +
      'V=$(HOME="$D" "$T" -V 2>/dev/null | head -1); printf "TMUX_VERSION=%s\\n" "$V"; ' +
      'LIST=$(HOME="$D" "$T" list-sessions -F "#{session_name}" 2>/dev/null); ' +
      'if [ -n "$LIST" ]; then printf "SERVER=1\\n"; ' +
      'printf "SESSIONS_BEGIN\\n%s\\nSESSIONS_END\\n" "$LIST"; fi; fi; true', 15000)
      .then(function (result) {
        status = parseStatus(result.output)
        sessions = status.SESSIONS_LIST || []
        canWrite = status.DIRWRITE === '1'

        el['st-home'].textContent = status.HOME || '\u2014'
        el['st-home'].title = status.HOME || ''
        if (status.TMUX_BIN) {
          el['st-tmux'].textContent = status.TMUX_VERSION || status.TMUX_BIN
          el['st-tmux'].title = status.TMUX_BIN
        } else {
          el['st-tmux'].textContent = 'not installed'
          el['st-tmux'].title = ''
        }
        el['st-config'].textContent = configPath()
        el['st-config'].title = configPath()
        if (status.HASCONF === '1') {
          el['st-state'].textContent = 'present'
          el['st-state'].className = 'ok'
        } else {
          el['st-state'].textContent = 'not created yet'
          el['st-state'].className = 'bad'
        }
        el['st-size'].textContent = status.SIZE ? status.SIZE + ' bytes' : '\u2014'
        el['st-server'].textContent = status.SERVER === '1'
          ? 'running (' + sessions.length + ')'
          : 'not running'
        el['st-server'].className = status.SERVER === '1' ? 'ok' : ''
        renderSessions()

        if (!HOST) {
          showBanner('No device selected. Open a device from the list.', 'bad')
        } else if (!canWrite) {
          showBanner('Term49 home is not writable: ' + (status.HOME || 'unknown') + '. Start term49-web from Term49 on the device.', 'bad')
        } else if (!status.TMUX_BIN) {
          showBanner('tmux is not installed. Run qpkg install tmux on the device, then reconnect.', 'warn')
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
    setBusy(true, 'Loading tmux configuration\u2026')
    return runCommand(homePrefix() +
      'if [ -f "$F" ]; then printf "TMUXCONF_BEGIN\\n"; base64 "$F"; printf "\\nTMUXCONF_END\\n"; ' +
      'else printf "TMUXCONF_MISSING\\n"; fi', 20000).then(function (result) {
      var output = result.output || ''
      if (output.indexOf('TMUXCONF_MISSING') >= 0) {
        applyConfig(DEFAULT_CONFIG)
        log('No .tmux.conf found. Saving will create one.')
        return
      }
      var start = output.indexOf('TMUXCONF_BEGIN')
      var end = output.indexOf('TMUXCONF_END', start + 1)
      if (start < 0 || end < 0) throw new Error('Could not read .tmux.conf')
      var body = output.slice(start + 'TMUXCONF_BEGIN'.length, end)
      applyConfig(fromBase64(body))
      log('Loaded ' + configPath())
    }).catch(function (err) {
      log('Could not load .tmux.conf: ' + err.message)
    }).then(function () {
      setBusy(false)
    })
  }

  function optionLine (line, name) {
    var pattern = new RegExp('^(?:set|set-option|setw|set-window-option)\\s+(?:-g\\s+)?' + name + '\\s+(\\S+)')
    var match = String(line).replace(/\s+#.*$/, '').trim().match(pattern)
    return match ? match[1] : ''
  }

  function parseConfig (text) {
    var result = {
      prefix: 'C-b',
      mouse: false,
      history: 2000,
      baseIndex: false,
      renumber: false,
      status: true,
      statusPosition: 'bottom',
      modeKeys: 'emacs'
    }
    String(text || '').split('\n').forEach(function (line) {
      var value = optionLine(line, 'prefix')
      if (value) result.prefix = value
      value = optionLine(line, 'mouse')
      if (value) result.mouse = value.toLowerCase() === 'on'
      ;['mode-mouse', 'mouse-select-pane', 'mouse-select-window', 'mouse-resize-pane'].forEach(function (name) {
        value = optionLine(line, name)
        if (value && value.toLowerCase() === 'on') result.mouse = true
      })
      value = optionLine(line, 'history-limit')
      if (value && /^\d+$/.test(value)) result.history = Number(value)
      value = optionLine(line, 'base-index')
      if (value && /^\d+$/.test(value) && Number(value) > 0) result.baseIndex = true
      value = optionLine(line, 'pane-base-index')
      if (value && /^\d+$/.test(value) && Number(value) > 0) result.baseIndex = true
      value = optionLine(line, 'renumber-windows')
      if (value) result.renumber = value.toLowerCase() === 'on'
      value = optionLine(line, 'status')
      if (value) result.status = value.toLowerCase() !== 'off'
      value = optionLine(line, 'status-position')
      if (value) result.statusPosition = value.toLowerCase() === 'top' ? 'top' : 'bottom'
      value = optionLine(line, 'mode-keys')
      if (value) result.modeKeys = value.toLowerCase() === 'vi' ? 'vi' : 'emacs'
    })
    return result
  }

  function ensurePrefixOption (value) {
    var found = false
    for (var i = 0; i < el.prefix.options.length; i++) {
      if (el.prefix.options[i].value === value) {
        found = true
        break
      }
    }
    if (found) return
    var option = document.createElement('option')
    option.value = value
    option.textContent = value + ' (from config)'
    el.prefix.appendChild(option)
  }

  function applyConfig (text) {
    var source = String(text || '')
    if (!source.trim()) source = DEFAULT_CONFIG
    configText = source
    var options = parseConfig(source)
    ensurePrefixOption(options.prefix)
    el.prefix.value = options.prefix
    el.mouse.checked = options.mouse
    el.history.value = String(options.history)
    el['base-index'].checked = options.baseIndex
    el['renumber-windows'].checked = options.renumber
    el['status-bar'].checked = options.status
    el['status-position'].value = options.statusPosition
    el['mode-keys'].value = options.modeKeys
    el['advanced-config'].value = source
    dirty = false
    el['save-note'].textContent = ''
    el['save-note'].className = 'term-save-note'
  }

  function versionAtLeast (version, major, minor) {
    var match = String(version || '').match(/(\d+)\.(\d+)/)
    if (!match) return true
    var foundMajor = Number(match[1])
    var foundMinor = Number(match[2])
    return foundMajor > major || (foundMajor === major && foundMinor >= minor)
  }

  function mouseLines (enabled) {
    var value = enabled ? 'on' : 'off'
    if (versionAtLeast(status.TMUX_VERSION, 2, 1)) {
      return ['set -g mouse ' + value]
    }
    return [
      'setw -g mode-mouse ' + value,
      'set -g mouse-select-pane ' + value,
      'set -g mouse-select-window ' + value,
      'set -g mouse-resize-pane ' + value
    ]
  }

  function stripManagedBlock (text) {
    var out = []
    var inside = false
    String(text || '').split('\n').forEach(function (line) {
      if (line.trim() === MANAGED_BEGIN) {
        inside = true
        return
      }
      if (inside) {
        if (line.trim() === MANAGED_END) inside = false
        return
      }
      out.push(line)
    })
    return out.join('\n').replace(/\s*$/, '')
  }

  function buildManagedBlock () {
    var prefix = el.prefix.value || 'C-b'
    var base = el['base-index'].checked ? '1' : '0'
    var lines = [MANAGED_BEGIN]
    lines.push('set -g prefix ' + prefix)
    if (prefix !== 'C-b') lines.push('unbind C-b')
    lines.push('bind ' + prefix + ' send-prefix')
    lines = lines.concat(mouseLines(el.mouse.checked))
    lines.push('set -g history-limit ' + Math.max(0, Math.min(1000000, Number(el.history.value) || 0)))
    lines.push('set -g base-index ' + base)
    lines.push('setw -g pane-base-index ' + base)
    lines.push('set -g renumber-windows ' + (el['renumber-windows'].checked ? 'on' : 'off'))
    lines.push('set -g status ' + (el['status-bar'].checked ? 'on' : 'off'))
    lines.push('set -g status-position ' + el['status-position'].value)
    lines.push('setw -g mode-keys ' + el['mode-keys'].value)
    lines.push(MANAGED_END)
    return lines.join('\n')
  }

  function buildConfig () {
    var base = stripManagedBlock(configText || DEFAULT_CONFIG)
    if (base) base += '\n\n'
    return base + buildManagedBlock() + '\n'
  }

  function markDirty () {
    dirty = true
    el['save-note'].textContent = 'Unsaved changes'
    el['save-note'].className = 'term-save-note dirty'
  }

  function uploadConfig (text) {
    var encoded = toBase64(text)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var init = homePrefix() + 'rm -f "$D/.tmuxcfg.b64"; : > "$D/.tmuxcfg.b64"'
    var final = homePrefix() +
      'if base64 -d "$D/.tmuxcfg.b64" > "$D/.tmuxcfg.new" 2>/dev/null; then ' +
      'if [ -f "$F" ]; then cp "$F" "$F.bak"; fi; ' +
      'mv "$D/.tmuxcfg.new" "$F" && printf "TMUXCONF_SAVED\\n"; ' +
      'else rm -f "$D/.tmuxcfg.new"; printf "TMUXCONF_FAILED\\n"; fi; ' +
      'rm -f "$D/.tmuxcfg.b64"'
    return runCommand(init, 15000).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          if (index === 0 || (index + 1) % 5 === 0 || index === chunks.length - 1) {
            log('Uploading configuration ' + (index + 1) + '/' + chunks.length + '\u2026')
          }
          return runCommand(homePrefix() + 'printf "%s" "' + chunk + '" >> "$D/.tmuxcfg.b64"', 15000)
        })
      })
      return chain
    }).then(function () {
      return runCommand(final, 20000)
    }).then(function (result) {
      if ((result.output || '').indexOf('TMUXCONF_SAVED') < 0) {
        throw new Error('Could not write .tmux.conf on the device')
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
      el['save-note'].textContent = 'Saved \u2014 apply or restart tmux'
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
      if (!window.confirm('The raw config editor has changes that are not reflected in the form. Save the form and discard those raw edits?')) {
        return
      }
    }
    saveConfig(buildConfig(), 'Saving tmux configuration\u2026')
  }

  function saveRaw () {
    var text = String(el['advanced-config'].value || '')
    if (!text.trim()) {
      log('Refusing to save an empty configuration.')
      return
    }
    saveConfig(text.replace(/\s*$/, '\n'), 'Saving raw tmux configuration\u2026')
  }

  function applyToServer () {
    if (!connected || busy || status.SERVER !== '1' || !status.TMUX_BIN) return
    withBusy('Applying .tmux.conf to the running tmux server\u2026', function () {
      return runCommand(homePrefix() + tmuxPrefix() +
        'if [ -n "$T" ] && [ -f "$F" ]; then ' +
        'if OUT=$(HOME="$D" "$T" source-file "$F" 2>&1); then printf "TMUX_APPLIED\\n"; ' +
        'else printf "TMUX_APPLY_FAILED\\n%s\\n" "$OUT"; fi; ' +
        'else printf "TMUX_APPLY_NO_SERVER\\n"; fi', 20000)
        .then(function (result) {
          var output = result.output || ''
          if (output.indexOf('TMUX_APPLIED') >= 0) log('Reloaded .tmux.conf in the running server')
          else log('Could not reload tmux: ' + output)
        })
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
      !window.confirm('Discard unsaved changes and reload .tmux.conf from the device?')) {
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

  function init () {
    cacheElements()
    if (!HOST) {
      el['head-host'].textContent = 'No device selected'
      showBanner('Open a device from the list, then choose Tmux.', 'bad')
      setConnection('bad', 'No device')
      updateButtons()
      return
    }
    el['head-host'].textContent = 'Device ' + HOST
    el['device-link'].href = 'device.html?host=' + encodeURIComponent(HOST)
    el['device-link'].textContent = 'App manager'

    ;['mouse', 'base-index', 'renumber-windows', 'status-bar'].forEach(function (id) {
      el[id].addEventListener('change', markDirty)
    })
    ;['prefix', 'history', 'status-position', 'mode-keys'].forEach(function (id) {
      el[id].addEventListener('change', markDirty)
      el[id].addEventListener('input', markDirty)
    })
    el['advanced-config'].addEventListener('input', markDirty)
    el.save.addEventListener('click', saveForm)
    el['save-raw'].addEventListener('click', saveRaw)
    el['copy-config'].addEventListener('click', copyConfig)
    el['reload'].addEventListener('click', reloadConfig)
    el.reconnect.addEventListener('click', connect)
    el.apply.addEventListener('click', applyToServer)
    el['clear-log'].addEventListener('click', function () { el.log.textContent = '' })

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