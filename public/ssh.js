;(function () {
  'use strict'

  var HOST = normalizeHost(new URLSearchParams(location.search).get('host'))
  var el = {}
  var ws = null
  var connected = false
  var busy = false
  var homeReady = false
  var status = {}
  var queue = Promise.resolve()
  var active = null
  var pollTimer = null
  var polling = false
  var lastKeyCount = null

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
      'term-hint', 'st-home', 'st-dir', 'st-hostkey', 'st-keys', 'st-sshd', 'st-auto',
      'refresh', 'start', 'stop', 'auto-on', 'auto-off', 'key-list', 'refresh-keys',
      'key-text', 'key-file', 'add-key', 'client-config', 'copy-config', 'log', 'clear-log'
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
    el.banner.className = 'ssh-banner' + (kind ? ' ' + kind : '')
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
    var canAct = connected && !busy && homeReady
    el.refresh.disabled = !connected || busy
    el.start.disabled = !(canAct && status.SSHD_BIN === '1')
    el.stop.disabled = !canAct
    el['auto-on'].disabled = !(canAct && status.SETTINGS_BIN === '1')
    el['auto-off'].disabled = !(canAct && status.SETTINGS_BIN === '1')
    el['add-key'].disabled = !(canAct && status.BASE64 === '1')
    el['refresh-keys'].disabled = !connected || busy
    el.reconnect.disabled = busy
  }

  function wsUrl () {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return scheme + '//' + location.host + '/term/' + encodeURIComponent(HOST) + '/ws'
  }

  function makeToken () {
    return 'BB10AM' + Math.random().toString(16).slice(2) + Date.now().toString(16)
  }

  function connect () {
    if (!HOST) return
    if (ws) {
      try { ws.close() } catch (err) { }
    }
    stopPolling()
    connected = false
    homeReady = false
    status = {}
    lastKeyCount = null
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
      startPolling()
      runCommand('stty -echo 2>/dev/null; PS1=""; unset PROMPT_COMMAND; true', 5000)
        .catch(function (err) {
          log('Shell preparation failed: ' + err.message)
        })
        .then(function () {
          return ensureHelper()
        })
        .then(function () {
          return refreshStatus()
        })
        .catch(function (err) {
          log('SSH setup failed: ' + err.message)
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
      homeReady = false
      stopPolling()
      lastKeyCount = null
      helperUploaded = false
      helperPromise = null
      if (active) {
        clearTimeout(active.timer)
        var reject = active.reject
        active = null
        reject(new Error('term49-web connection closed'))
      }
      setConnection('bad', 'Disconnected')
      el['term-hint'].hidden = false
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

  var HELPER_VERSION = '3'
  var HELPER_PREFIX = 'D="${SANDBOX:+$SANDBOX/data}"; [ -n "$D" ] || D="$HOME"; H="$D/.ssh"; '
  var helperUploaded = false
  var helperPromise = null

  function helperCommand (action) {
    return HELPER_PREFIX + 'sh "$H/ssh-helper.sh" ' + action
  }

  function helperCheckCommand () {
    return HELPER_PREFIX +
      'if [ -f "$H/ssh-helper.sh" ] && grep -q "^HELPER_VERSION=' + HELPER_VERSION + '$" "$H/ssh-helper.sh" 2>/dev/null; then echo HELPER_OK; else echo HELPER_MISSING; fi'
  }

  function uploadHelper (text) {
    var encoded = toBase64(text)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var init = HELPER_PREFIX + 'mkdir -p "$H"; chmod 700 "$H"; rm -f "$H/.helper.b64"; : > "$H/.helper.b64"'
    var final = HELPER_PREFIX +
      'if base64 -d "$H/.helper.b64" > "$H/ssh-helper.sh" 2>/dev/null; then chmod 700 "$H/ssh-helper.sh"; echo HELPER_UPLOADED; else echo HELPER_UPLOAD_FAILED; fi; rm -f "$H/.helper.b64"'
    return runCommand(init, 15000).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          if (index === 0 || (index + 1) % 5 === 0 || index === chunks.length - 1) {
            log('Uploading SSH helper ' + (index + 1) + '/' + chunks.length + '\u2026')
          }
          return runCommand('printf "%s" "' + chunk + '" >> "$H/.helper.b64"', 15000)
        })
      })
      return chain
    }).then(function () {
      return runCommand(final, 15000)
    }).then(function (result) {
      if (result.output.indexOf('HELPER_UPLOADED') < 0) {
        throw new Error('Could not install the SSH helper on the device')
      }
      helperUploaded = true
      log('SSH helper installed in Term49 home')
    })
  }

  function ensureHelper () {
    if (helperUploaded) return Promise.resolve()
    if (helperPromise) return helperPromise
    helperPromise = runCommand(helperCheckCommand(), 10000)
      .then(function (result) {
        if (result.output.indexOf('HELPER_OK') >= 0) {
          helperUploaded = true
          return
        }
        return fetch('ssh-helper.sh', { cache: 'no-store' }).then(function (response) {
          if (!response.ok) throw new Error('could not load ssh-helper.sh from the app')
          return response.text()
        }).then(uploadHelper)
      })
      .then(function () {
        helperPromise = null
      })
      .catch(function (err) {
        helperPromise = null
        throw err
      })
    return helperPromise
  }

  function parseStatus (text) {
    var parsed = {}
    String(text || '').split('\n').forEach(function (line) {
      var match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (match) parsed[match[1]] = match[2]
    })
    return parsed
  }

  function mark (element, ok, text) {
    element.textContent = text
    element.className = ok ? 'ok' : 'bad'
  }

  function parseKeyList (text) {
    var keys = []
    var current = null
    String(text || '').split('\n').forEach(function (line) {
      var match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!match) return
      var name = match[1]
      var value = match[2]
      if (name === 'KEY_INDEX') {
        if (current) keys.push(current)
        current = { index: Number(value) }
        return
      }
      if (!current) return
      if (name === 'KEY_TYPE') current.type = value
      else if (name === 'KEY_BITS') current.bits = value
      else if (name === 'KEY_FP') current.fp = value
      else if (name === 'KEY_COMMENT') current.comment = value
    })
    if (current) keys.push(current)
    return keys
  }

  function renderKeyList (keys) {
    var list = el['key-list']
    if (!list) return
    list.textContent = ''
    if (!keys.length) {
      var empty = document.createElement('p')
      empty.className = 'ssh-note'
      empty.textContent = 'No authorized keys yet.'
      list.appendChild(empty)
      return
    }
    keys.forEach(function (key) {
      var row = document.createElement('div')
      row.className = 'ssh-key-item'

      var meta = document.createElement('div')
      meta.className = 'ssh-key-meta'

      var title = document.createElement('div')
      title.className = 'ssh-key-title'
      title.textContent = '#' + key.index + '  ' + (key.type || 'key') + '  ' + (key.bits || '?') + ' bits'

      var fp = document.createElement('code')
      fp.textContent = key.fp || 'unknown'

      var comment = document.createElement('div')
      comment.className = 'ssh-key-comment'
      comment.textContent = key.comment || '(no comment)'

      meta.appendChild(title)
      meta.appendChild(fp)
      meta.appendChild(comment)

      var actions = document.createElement('div')
      actions.className = 'ssh-key-actions'

      var replace = document.createElement('button')
      replace.type = 'button'
      replace.className = 'primary small'
      replace.textContent = 'Replace'
      replace.title = 'Replace this key with the key in the box below'
      replace.addEventListener('click', function () { replaceKey(key) })

      var revoke = document.createElement('button')
      revoke.type = 'button'
      revoke.className = 'primary small'
      revoke.textContent = 'Revoke'
      revoke.title = 'Remove this key from authorized_keys'
      revoke.addEventListener('click', function () { revokeKey(key) })

      actions.appendChild(replace)
      actions.appendChild(revoke)

      row.appendChild(meta)
      row.appendChild(actions)
      list.appendChild(row)
    })
  }

  function refreshKeys () {
    if (!connected) return Promise.resolve()
    return runHelper('list-keys', 20000).then(function (result) {
      renderKeyList(parseKeyList(result.output))
    }).catch(function (err) {
      log('Could not list authorized keys: ' + err.message)
    })
  }

  function refreshStatus (withKeys) {
    if (!connected) return Promise.reject(new Error('not connected'))
    return ensureHelper().then(function () {
      return runCommand(helperCommand('status'), 15000)
    }).then(function (result) {
      status = parseStatus(result.output)
      var home = status.HOME_REAL || ''
      var exists = status.HOME_EXISTS === '1'
      var writable = status.HOME_WRITABLE === '1'

      el['st-home'].textContent = home || '\u2014'
      el['st-home'].title = home
      el['st-dir'].textContent = status.SSH_DIR || '\u2014'
      el['st-dir'].title = status.SSH_DIR || ''
      mark(el['st-hostkey'], status.HOST_KEY === '1', status.HOST_KEY === '1' ? 'present' : 'missing')
      el['st-keys'].textContent = status.AUTH_KEYS || '0'
      mark(el['st-sshd'], status.SSHD_LISTEN === '1', status.SSHD_LISTEN === '1' ? 'listening on 2022' : 'not listening')
      mark(el['st-auto'], status.AUTOSTART === '1', status.AUTOSTART === '1' ? 'enabled' : 'disabled')

      homeReady = exists && writable && !!status.SANDBOX

      if (!HOST) {
        showBanner('No device selected. Open a device from the list.', 'bad')
      } else if (!status.SANDBOX) {
        showBanner('Could not read $SANDBOX from the term49-web shell. Start term49-web from Term49 on the device, then reconnect.', 'bad')
      } else if (!exists || !writable) {
        showBanner('Term49 home is not accessible: ' + (home || 'unknown') + '. Start term49-web from Term49 on the device.', 'bad')
      } else if (status.SSHD_BIN !== '1') {
        showBanner('BerryCore OpenSSH is missing under $NATIVE_TOOLS. Install BerryCore first.', 'bad')
      } else if (status.HELPER_VERSION !== HELPER_VERSION) {
        showBanner('The SSH helper on the device is out of date. Reconnect to upload the current version.', 'warn')
      } else {
        hideBanner()
      }

      var keyCount = status.AUTH_KEYS || '0'
      var needKeys = withKeys !== false || lastKeyCount !== keyCount
      lastKeyCount = keyCount
      updateClientConfig()
      updateButtons()
      if (needKeys) return refreshKeys().then(function () { return status })
      return status
    })
  }

  function stopPolling () {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    polling = false
  }

  function startPolling () {
    stopPolling()
    pollTimer = setInterval(function () {
      if (!connected || busy || active || polling) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      polling = true
      refreshStatus(false).catch(function () { }).then(function () {
        polling = false
      })
    }, 5000)
  }

  function updateClientConfig () {
    var lines = [
      'Host ' + (HOST || 'bb10'),
      '  HostName ' + (HOST || 'bb10'),
      '  User blackberry',
      '  Port 2022',
      '  IdentityFile ~/.ssh/id_rsa_bb10',
      '  HostKeyAlgorithms +ssh-rsa',
      '  PubkeyAcceptedAlgorithms +ssh-rsa',
      '  KexAlgorithms +diffie-hellman-group14-sha1',
      '  ServerAliveInterval 30'
    ]
    el['client-config'].textContent = lines.join('\n')
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

  function runHelper (action, timeout) {
    return ensureHelper().then(function () {
      return runCommand(helperCommand(action), timeout || 20000)
    })
  }

  function startSshd () {
    return withBusy('Starting sshd on 2022\u2026', function () {
      return runHelper('start', 150000).then(function (result) {
        log(result.output || '(no output)')
        return refreshStatus()
      })
    })
  }

  function stopSshd () {
    return withBusy('Stopping sshd\u2026', function () {
      return runHelper('stop', 20000).then(function (result) {
        log(result.output || '(no output)')
        return refreshStatus()
      })
    })
  }

  function setAutostart (enabled) {
    return withBusy((enabled ? 'Enabling' : 'Disabling') + ' sshd auto-start\u2026', function () {
      return runHelper(enabled ? 'autostart-on' : 'autostart-off', 150000).then(function (result) {
        log(result.output || '(no output)')
        if (enabled) {
          log('Auto-start writes Term49\'s real profile. It runs on the next Term49 login.')
        }
        return refreshStatus()
      })
    })
  }

  function toBase64 (text) {
    try {
      return btoa(unescape(encodeURIComponent(text)))
    } catch (err) {
      return btoa(text)
    }
  }

  function readKeyLine () {
    var line = String(el['key-text'].value || '').replace(/\r/g, '').trim()
    if (!line) {
      log('Paste a public key first.')
      return null
    }
    var lines = line.split('\n').map(function (item) { return item.trim() }).filter(Boolean)
    if (lines.length !== 1) {
      log('Add one public key at a time (found ' + lines.length + ' non-empty lines).')
      return null
    }
    line = lines[0]
    if (line.length > 8192) {
      log('That key is too long.')
      return null
    }
    if (!/(^|\s)(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]{20,}/.test(line)) {
      log('That does not look like an OpenSSH public key.')
      return null
    }
    return line
  }

  function uploadKeyLine (line) {
    var encoded = toBase64(line)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var init = HELPER_PREFIX + 'mkdir -p "$H"; chmod 700 "$H"; rm -f "$H/.key.b64"; : > "$H/.key.b64"'

    return ensureHelper().then(function () {
      return runCommand(init, 15000)
    }).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          log('Uploading key ' + (index + 1) + '/' + chunks.length + '\u2026')
          return runCommand('printf "%s" "' + chunk + '" >> "$H/.key.b64"', 15000)
        })
      })
      return chain
    })
  }

  function addKey () {
    var line = readKeyLine()
    if (!line) return
    withBusy('Adding authorized key\u2026', function () {
      return uploadKeyLine(line).then(function () {
        return runHelper('add-key', 20000)
      }).then(function (result) {
        log(result.output || '(no output)')
        el['key-text'].value = ''
        el['key-file'].value = ''
        return refreshStatus()
      })
    })
  }

  function replaceKey (key) {
    var line = readKeyLine()
    if (!line) return
    if (typeof window.confirm === 'function' && !window.confirm('Replace authorized key #' + key.index + '?')) {
      return
    }
    withBusy('Replacing authorized key #' + key.index + '\u2026', function () {
      return uploadKeyLine(line).then(function () {
        return runHelper('replace-key ' + key.index, 20000)
      }).then(function (result) {
        log(result.output || '(no output)')
        el['key-text'].value = ''
        el['key-file'].value = ''
        return refreshStatus()
      })
    })
  }

  function revokeKey (key) {
    if (typeof window.confirm === 'function' && !window.confirm('Revoke authorized key #' + key.index + ' (' + (key.fp || 'unknown') + ')?')) {
      return
    }
    withBusy('Revoking authorized key #' + key.index + '\u2026', function () {
      return runHelper('revoke-key ' + key.index, 20000).then(function (result) {
        log(result.output || '(no output)')
        return refreshStatus()
      })
    })
  }

  function readKeyFile () {
    var file = el['key-file'].files && el['key-file'].files[0]
    if (!file) return
    var reader = new FileReader()
    reader.onload = function () {
      el['key-text'].value = String(reader.result || '').trim()
      log('Loaded ' + file.name)
    }
    reader.onerror = function () {
      log('Could not read ' + file.name)
    }
    reader.readAsText(file)
  }

  function copyConfig () {
    var text = el['client-config'].textContent || ''
    if (!text) return
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        log('Client config copied.')
      }, function () {
        log('Copy failed; select the text manually.')
      })
      return
    }
    var area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
      log('Client config copied.')
    } catch (err) {
      log('Copy failed; select the text manually.')
    }
    document.body.removeChild(area)
  }

  function init () {
    cacheElements()
    updateClientConfig()
    if (!HOST) {
      el['head-host'].textContent = 'No device selected'
      showBanner('Open a device from the list, then choose SSH.', 'bad')
      setConnection('bad', 'No device')
      updateButtons()
      return
    }
    el['head-host'].textContent = 'Device ' + HOST
    el['device-link'].href = 'device.html?host=' + encodeURIComponent(HOST)
    el['device-link'].textContent = 'App manager'

    el.reconnect.addEventListener('click', connect)
    el.refresh.addEventListener('click', function () {
      withBusy('Refreshing status\u2026', refreshStatus)
    })
    el.start.addEventListener('click', startSshd)
    el.stop.addEventListener('click', stopSshd)
    el['auto-on'].addEventListener('click', function () { setAutostart(true) })
    el['auto-off'].addEventListener('click', function () { setAutostart(false) })
    el['add-key'].addEventListener('click', addKey)
    el['refresh-keys'].addEventListener('click', function () {
      withBusy('Refreshing authorized keys\u2026', refreshKeys)
    })
    el['key-file'].addEventListener('change', readKeyFile)
    el['copy-config'].addEventListener('click', copyConfig)
    el['clear-log'].addEventListener('click', function () { el.log.textContent = '' })

    window.addEventListener('beforeunload', function () {
      if (ws) {
        try { ws.close() } catch (err) { }
      }
    })

    updateButtons()
    connect()
  }

  init()
})()