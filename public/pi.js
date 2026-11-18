;(function () {
  'use strict'

  var HOST = normalizeHost(new URLSearchParams(location.search).get('host'))
  var el = {}
  var ws = null
  var connected = false
  var busy = false
  var status = {}
  var queue = Promise.resolve()
  var active = null
  var pollTimer = null
  var polling = false
  var helperUploaded = false
  var helperPromise = null
  var existingLoaded = false
  var PI_HELPER_VERSION = '1'
  var HELPER_PREFIX = 'D="${SANDBOX:+$SANDBOX/data}"; [ -n "$D" ] || D="$HOME"; PD="$D/.pihelper"; '

  function normalizeHost (value) {
    var host = String(value || '').trim()
    if (!host) return ''
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    host = host.replace(/[/?#].*$/, '')
    host = host.replace(/\/+$/, '')
    return host.toLowerCase()
  }

  function $ (id) {
    return document.getElementById(id)
  }

  function cacheElements () {
    var ids = [
      'head-host', 'device-link', 'banner-card', 'banner', 'conn-state', 'reconnect',
      'term-hint', 'st-home', 'st-root', 'st-node', 'st-pkg', 'st-launcher', 'st-creds',
      'st-nodezip', 'st-qpkgnode', 'st-pkgzip', 'st-pkginst', 'st-scripts', 'st-guard',
      'st-berrycloud', 'refresh', 'pi-nodezip-btn', 'pi-node-btn', 'pi-selftest-btn',
      'pi-artifact-url', 'artifact-note', 'pi-pkgpull-btn', 'pi-pkginstall-btn',
      'pi-scripts-btn', 'pi-launcher-btn', 'pi-settings-btn', 'pi-configure-btn', 'log', 'clear-log',
      'pi-cfg-providers', 'pi-cfg-add', 'pi-cfg-btn', 'pi-cfg-status'
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

  function wsUrl () {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return scheme + '//' + location.host + '/term/' + encodeURIComponent(HOST) + '/ws'
  }

  function makeToken () {
    return 'BB10PI' + Math.random().toString(16).slice(2) + Date.now().toString(16)
  }

  function connect () {
    if (!HOST) return
    if (ws) {
      try { ws.close() } catch (err) { }
    }
    stopPolling()
    connected = false
    status = {}
    helperUploaded = false
    helperPromise = null
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
        .catch(function (err) {
          log('Pi pane setup failed: ' + err.message)
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
      stopPolling()
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
    current.resolve({ output: clean(output), code: Number(codeMatch[0]) })
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

  function helperCheckCommand () {
    return HELPER_PREFIX +
      'if [ -f "$PD/pi-classic.sh" ] && grep -q "^PI_HELPER_VERSION=' + PI_HELPER_VERSION + '$" "$PD/pi-classic.sh" 2>/dev/null; then echo PIHELPER_OK; else echo PIHELPER_MISSING; fi'
  }

  function toBase64 (text) {
    try {
      return btoa(unescape(encodeURIComponent(text)))
    } catch (err) {
      return btoa(text)
    }
  }

  function uploadHelper (text) {
    var encoded = toBase64(text)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var initCmd = HELPER_PREFIX + 'mkdir -p "$PD"; chmod 700 "$PD"; rm -f "$PD/.helper.b64"; : > "$PD/.helper.b64"'
    var finalCmd = HELPER_PREFIX +
      'if base64 -d "$PD/.helper.b64" > "$PD/pi-classic.sh" 2>/dev/null; then chmod 700 "$PD/pi-classic.sh"; echo PIHELPER_UPLOADED; else echo PIHELPER_UPLOAD_FAILED; fi; rm -f "$PD/.helper.b64"'
    return runCommand(initCmd, 15000).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          if (index === 0 || (index + 1) % 8 === 0 || index === chunks.length - 1) {
            log('Uploading Pi helper ' + (index + 1) + '/' + chunks.length + '\u2026')
          }
          return runCommand('printf "%s" "' + chunk + '" >> "$PD/.helper.b64"', 15000)
        })
      })
      return chain
    }).then(function () {
      return runCommand(finalCmd, 15000)
    }).then(function (result) {
      if (result.output.indexOf('PIHELPER_UPLOADED') < 0) {
        throw new Error('Could not install the Pi helper on the device')
      }
      helperUploaded = true
      log('Pi helper installed in Term49 home')
    })
  }

  function ensureHelper () {
    if (helperUploaded) return Promise.resolve()
    if (helperPromise) return helperPromise
    helperPromise = runCommand(helperCheckCommand(), 10000)
      .then(function (result) {
        if (result.output.indexOf('PIHELPER_OK') >= 0) {
          helperUploaded = true
          return
        }
        return fetch('pi-classic.sh', { cache: 'no-store' }).then(function (response) {
          if (!response.ok) throw new Error('could not load pi-classic.sh from the app')
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

  function decodeUtf8Base64 (b64) {
    var bin = atob(String(b64 || '').replace(/\s+/g, ''))
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    var out = ''
    try {
      out = new TextDecoder('utf-8').decode(bytes)
    } catch (err) {
      out = decodeURIComponent(escape(bin))
    }
    return out
  }

  function loadExistingConfig () {
    if (existingLoaded) return Promise.resolve()
    existingLoaded = true
    return helperRun('cfg-read', 30000).then(function (result) {
      if (result.output.indexOf('CFG=none') >= 0) {
        if (el['pi-cfg-status']) el['pi-cfg-status'].textContent = 'No existing Pi configuration in this terminal home. Fill the form to create one.'
        return
      }
      var line = result.output.split('\n').filter(function (l) {
        return l.indexOf('CFG_B64=') === 0
      })[0]
      if (!line) return
      var cfg
      try {
        cfg = JSON.parse(decodeUtf8Base64(line.slice(8)))
      } catch (err) {
        log('Could not parse the existing Pi configuration: ' + err.message)
        return
      }
      var providers = cfg && cfg.models && cfg.models.providers
      if (!providers) return
      el['pi-cfg-providers'].textContent = ''
      Object.keys(providers).forEach(function (pid) {
        var p = providers[pid] || {}
        addProviderRow({
          'pi-p-name': pid,
          'pi-p-endpoint': (p.baseUrl || '').replace(/\/?$/, '') + '/chat/completions',
          'pi-p-key': p.apiKey || '',
          'pi-p-models': ((p.models || []).map(function (m) { return m.id })).join(', ')
        })
      })
      var count = Object.keys(providers).length
      if (el['pi-cfg-status']) {
        el['pi-cfg-status'].textContent = 'Loaded existing configuration: ' + count + ' provider(s)' +
          (cfg.settings && cfg.settings.defaultModel
            ? ', default ' + cfg.settings.defaultProvider + ' / ' + cfg.settings.defaultModel +
              '. Editing replaces it (a timestamped .bak is kept).'
            : '.')
      }
      log('Loaded existing Pi configuration (' + count + ' provider(s))')
    })
  }

  function helperRun (action, timeout) {
    return ensureHelper().then(function () {
      return runCommand(HELPER_PREFIX + 'sh "$PD/pi-classic.sh" ' + action, timeout || 30000)
    })
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
    if (!element) return
    element.textContent = text
    element.className = ok === true ? 'ok' : ok === false ? 'bad' : ''
  }

  function jobsBusy () {
    return status.NODE_JOB === 'running' ||
      status.NODEZIP_JOB === 'running' ||
      status.PKG_JOB === 'running'
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
      polling = true
      refreshStatus().catch(function () { }).then(function () {
        polling = false
      })
    }, 4000)
  }

  function artifactBase () {
    return String(el['pi-artifact-url'].value || '').trim().replace(/\/+$/, '')
  }

  function updateArtifactNote () {
    if (!el['artifact-note']) return
    var host = location.hostname
    var loopback = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1'
    var base = artifactBase()
    if (loopback) {
      el['artifact-note'].textContent = 'The device cannot pull from ' + (host || 'this host') +
        ' (loopback). Enter the USB/Wi-Fi address of this machine, e.g. http://169.254.x.x:8810/artifacts,' +
        ' and run the app with LISTEN_HOST=0.0.0.0.'
    } else if (!base) {
      el['artifact-note'].textContent = 'Suggested base: http://' + host + ':8810/artifacts'
    } else {
      el['artifact-note'].textContent = 'Device will pull ' + base + '/pi-package.zip (+ .sha256).'
    }
  }

  function renderStatus () {
    mark(el['st-home'], status.HOME, status.HOME || '\u2014')
    mark(el['st-root'], status.ROOT, status.ROOT || '\u2014')
    mark(el['st-node'], status.PRIVNODE === '1',
      status.PRIVNODE === '1' ? (status.NODE_VERSION || 'installed') : 'not installed')
    mark(el['st-pkg'], status.PACKAGE === '1', status.PACKAGE === '1' ? 'installed' : 'not installed')
    mark(el['st-launcher'], status.LAUNCHER === '1', status.LAUNCHER === '1' ? 'bin/pi' : 'not installed')
    mark(el['st-creds'], status.CREDS === '1', status.CREDS === '1' ? 'configured' : 'not configured')
    mark(el['st-nodezip'], status.NODEZIP === '1', status.NODEZIP === '1' ? 'on device (verified)' : 'not fetched')
    mark(el['st-qpkgnode'], status.QPKG_NODE === '1', status.QPKG_NODE === '1' ? 'installed' : 'not installed')
    mark(el['st-pkgzip'], status.PKGZIP === '1', status.PKGZIP === '1' ? 'on device' : 'not pulled')
    mark(el['st-pkginst'], status.PACKAGE === '1', status.PACKAGE === '1' ? 'installed' : 'not installed')
    mark(el['st-scripts'], status.SCRIPTS === '1', status.SCRIPTS === '1' ? 'ready' : 'not fetched')
    mark(el['st-guard'], status.GUARD === '1', status.GUARD === '1' ? 'installed' : 'not installed')
    mark(el['st-berrycloud'], status.BERRYCLOUD === '1', status.BERRYCLOUD === '1' ? 'present' : 'absent')

    var jobs = jobsBusy()
    var running = []
    if (status.NODE_JOB === 'running') running.push('node install')
    if (status.NODEZIP_JOB === 'running') running.push('node zip fetch')
    if (status.PKG_JOB === 'running') running.push('package pull')
    el['conn-state'].textContent = jobs ? ('Working: ' + running.join(', ')) : 'Connected'
    el['conn-state'].className = 'badge' + (jobs ? ' warn' : ' ok')

    if (status.CREDS === '1') {
      el['pi-cfg-btn'].textContent = 'Replace configuration (backs up first)'
    } else {
      el['pi-cfg-btn'].textContent = 'Write Pi configuration'
    }
    loadExistingConfig().catch(function () { })

    updateButtons()
    updateArtifactNote()

    if (jobs) startPolling()
    else stopPolling()
  }

  function refreshStatus () {
    if (!connected) return Promise.reject(new Error('not connected'))
    return helperRun('status', 30000).then(function (result) {
      status = parseStatus(result.output)
      renderStatus()
      if (!HOST) {
        showBanner('No device selected. Open a device from the list.', 'bad')
      } else if (!status.HOME) {
        showBanner('Could not read the Term49 home. Start term49-web from Term49 on the device.', 'bad')
      } else if (status.PI_HELPER_VERSION !== PI_HELPER_VERSION) {
        showBanner('The Pi helper on the device is out of date. Reconnect to upload the current version.', 'warn')
      } else {
        hideBanner()
      }
      return status
    })
  }

  function updateButtons () {
    var idle = connected && !busy
    el.reconnect.disabled = busy
    el.refresh.disabled = !connected || busy
    el['pi-nodezip-btn'].disabled = !(idle && status.NODEZIP_JOB !== 'running')
    el['pi-node-btn'].disabled = !idle
    el['pi-selftest-btn'].disabled = !(idle && status.PRIVNODE === '1')
    el['pi-pkgpull-btn'].disabled = !(idle && artifactBase() && status.PKG_JOB !== 'running')
    el['pi-pkginstall-btn'].disabled = !(idle && status.PKGZIP === '1' && status.SCRIPTS === '1')
    el['pi-scripts-btn'].disabled = !(idle && status.SCRIPTS_JOB !== 'running')
    el['pi-launcher-btn'].disabled = !(idle && status.SCRIPTS === '1')
    el['pi-settings-btn'].disabled = !(idle && status.SCRIPTS === '1')
    el['pi-configure-btn'].disabled = !(idle && status.SCRIPTS === '1' && status.BERRYCLOUD === '1')
    var cfgReady = idle && status.SCRIPTS === '1' && rowsComplete()
    el['pi-cfg-btn'].disabled = !cfgReady
    el['pi-cfg-add'].disabled = !idle
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
        return refreshStatus().catch(function () { })
      })
      .then(function () {
        setBusy(false)
      })
  }

  function action (name, label, timeout, confirmText) {
    return function () {
      if (busy || !connected) return
      if (confirmText && typeof window.confirm === 'function' && !window.confirm(confirmText)) return
      withBusy(label, function () {
        return helperRun(name, timeout || 60000).then(function (result) {
          if (result.output) log(result.output)
        })
      })
    }
  }

  function providerRows () {
    return Array.prototype.slice.call(el['pi-cfg-providers'].querySelectorAll('.pi-cfg-row'))
  }

  function collectProviders () {
    var out = []
    providerRows().forEach(function (row) {
      out.push({
        name: row.querySelector('.pi-p-name').value.trim(),
        endpoint: row.querySelector('.pi-p-endpoint').value.trim(),
        api_key: row.querySelector('.pi-p-key').value.trim(),
        models: row.querySelector('.pi-p-models').value.trim()
      })
    })
    return out
  }

  function rowsComplete () {
    var rows = collectProviders()
    if (!rows.length) return false
    return rows.every(function (p) {
      return p.endpoint && p.api_key && p.models
    })
  }

  function addProviderRow (preset) {
    var tbody = el['pi-cfg-providers']
    var tr = document.createElement('tr')
    tr.className = 'pi-cfg-row'
    var cells = [
      { cls: 'pi-p-name', ph: 'optional (zhipu)', type: 'text' },
      { cls: 'pi-p-endpoint', ph: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', type: 'text' },
      { cls: 'pi-p-key', ph: 'API key', type: 'password' },
      { cls: 'pi-p-models', ph: 'glm-5.3-flash, glm-5.3-air', type: 'text' }
    ]
    cells.forEach(function (f) {
      var td = document.createElement('td')
      var input = document.createElement('input')
      input.type = f.type
      input.className = f.cls
      input.spellcheck = false
      if (f.cls === 'pi-p-key') input.autocomplete = 'off'
      input.placeholder = f.ph
      if (preset && preset[f.cls]) input.value = preset[f.cls]
      input.addEventListener('input', updateButtons)
      td.appendChild(input)
      tr.appendChild(td)
    })
    var tdDel = document.createElement('td')
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'pi-cfg-del'
    del.textContent = '\u00d7'
    del.title = 'Remove this provider row'
    del.addEventListener('click', function () {
      tr.parentNode.removeChild(tr)
      updateButtons()
    })
    tdDel.appendChild(del)
    tr.appendChild(tdDel)
    tbody.appendChild(tr)
    updateButtons()
    return tr
  }

  function uploadCfgAndConfigure () {
    var payload = JSON.stringify({ providers: collectProviders() })
    var encoded = toBase64(payload)
    var chunks = []
    for (var i = 0; i < encoded.length; i += 500) {
      chunks.push(encoded.slice(i, i + 500))
    }
    var initCmd = HELPER_PREFIX + 'mkdir -p "$PD"; chmod 700 "$PD"; rm -f "$PD/.cfg.b64"; : > "$PD/.cfg.b64"'
    var finishCmd = HELPER_PREFIX +
      'sh "$PD/pi-classic.sh" configure-manual' + (status.CREDS === '1' ? ' replace' : '')
    return runCommand(initCmd, 15000).then(function () {
      var chain = Promise.resolve()
      chunks.forEach(function (chunk) {
        chain = chain.then(function () {
          return runCommand('printf "%s" "' + chunk + '" >> "$PD/.cfg.b64"', 15000)
        })
      })
      return chain
    }).then(function () {
      return runCommand(finishCmd, 60000)
    })
  }

  function manualConfigure () {
    if (busy || !connected) return
    if (typeof window.confirm === 'function' &&
      !window.confirm(status.CREDS === '1'
        ? 'Replace the existing Pi provider configuration? The current models.json/settings.json are renamed with a timestamped .bak first. The API key stays on the device (mode 0600).'
        : 'Write the Pi provider configuration to the device? Existing Pi configs are never overwritten. The API key stays on the device (mode 0600).')) {
      return
    }
    withBusy('Writing Pi configuration…', function () {
      return uploadCfgAndConfigure().then(function (result) {
        if (result.output) log(result.output)
        providerRows().forEach(function (row) {
          row.querySelector('.pi-p-key').value = ''
        })
      })
    })
  }

  function init () {
    cacheElements()
    if (!HOST) {
      el['head-host'].textContent = 'No device selected'
      showBanner('Open a device from the list, then choose Pi agent.', 'bad')
      setConnection('bad', 'No device')
      updateButtons()
      return
    }
    el['head-host'].textContent = 'Device ' + HOST
    el['device-link'].href = 'device.html?host=' + encodeURIComponent(HOST)
    el['device-link'].textContent = 'App manager'

    var host = location.hostname
    var loopback = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1'
    el['pi-artifact-url'].value = loopback ? '' : 'http://' + host + ':8810/artifacts'

    el.reconnect.addEventListener('click', connect)
    el.refresh.addEventListener('click', function () {
      withBusy('Refreshing status\u2026', refreshStatus)
    })
    el['pi-nodezip-btn'].addEventListener('click', action('nodezip', 'Fetching pinned node zip (18 MB, device-side)\u2026', 60000))
    el['pi-node-btn'].addEventListener('click', action('node', 'Installing node-term49 via qpkg\u2026', 60000))
    el['pi-selftest-btn'].addEventListener('click', action('selftest', 'Running node self-test\u2026'))
    el['pi-pkgpull-btn'].addEventListener('click', function () {
      var base = artifactBase()
      if (!base) {
        log('Enter the artifact base URL first.')
        return
      }
      action('pkgpull ' + base, 'Pulling pi-package.zip from ' + base + '\u2026', 60000)()
    })
    el['pi-pkginstall-btn'].addEventListener('click', action('pkginstall', 'Installing pi package tree\u2026', 300000,
      'Install the pi package tree into pi-classic/package? This refuses to overwrite an existing install.'))
    el['pi-scripts-btn'].addEventListener('click', action('scripts', 'Fetching toolkit adapter scripts\u2026', 60000))
    el['pi-launcher-btn'].addEventListener('click', action('launcher', 'Installing the pi launcher\u2026', 60000,
      'Install the pi command into berrycore/bin/pi? An unrelated existing entry is refused by the toolkit.'))
    el['pi-settings-btn'].addEventListener('click', action('settings', 'Installing guard extension\u2026', 60000,
      'Install classic-guard.js as a Pi extension? Existing extensions are refused.'))
    el['pi-cfg-btn'].addEventListener('click', manualConfigure)
    el['pi-cfg-add'].addEventListener('click', function () {
      addProviderRow()
    })
    addProviderRow()
    el['pi-configure-btn'].addEventListener('click', action('configure', 'Copying BerryCloud GLM credentials into Pi settings\u2026', 60000,
      'Copy the BerryCloud GLM endpoint and API key into private Pi settings? This writes ~/.pi/agent/models.json and settings.json (refused if they exist). Review the toolkit configure.py if unsure.'))
    el['clear-log'].addEventListener('click', function () { el.log.textContent = '' })
    el['pi-artifact-url'].addEventListener('input', function () {
      updateArtifactNote()
      updateButtons()
    })

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
