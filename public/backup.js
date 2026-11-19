;(function () {
  'use strict'

  var HOST = normalizeHost(new URLSearchParams(location.search).get('host'))
  var el = {}
  var pollTimer = null
  var lastJobState = null
  var categories = []
  var apps = []
  var files = []
  var loggedIn = false
  var busyStarting = false

  var REMEMBER_KEY = 'bb10am-backup-pass-' + HOST

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
    ;[
      'head-host', 'device-link', 'banner-card', 'banner', 'conn-state',
      'dev-model', 'dev-pin', 'dev-os', 'dev-name', 'dev-battery', 'dev-free',
      'login-form', 'password', 'remember', 'login-btn', 'logout', 'reconnect',
      'cat-list', 'list-hint', 'backup-progress', 'backup-fill', 'backup-status',
      'backup-start', 'backup-cancel', 'backup-download',
      'restore-file', 'files-refresh', 'restore-cats', 'restore-warning',
      'restore-progress', 'restore-fill', 'restore-status', 'restore-start', 'restore-cancel',
      'files-refresh2', 'file-list', 'log', 'clear-log',
      'wire-log', 'wire-refresh', 'wire-copy', 'wire-clear'
    ].forEach(function (id) {
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

  function fmtBytes (n) {
    n = Number(n)
    if (!isFinite(n) || n < 0) return '\u2014'
    if (n < 1024) return n + ' B'
    var units = ['KB', 'MB', 'GB', 'TB']
    var v = n
    for (var i = 0; i < units.length; i++) {
      v = v / 1024
      if (v < 1024 || i === units.length - 1) {
        return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i]
      }
    }
  }

  function api (path, options) {
    options = options || {}
    var init = {
      method: options.method || 'GET',
      headers: {}
    }
    if (options.body !== undefined) {
      init.method = options.method || 'POST'
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    return fetch('/backup/' + encodeURIComponent(HOST) + '/api/' + path, init)
      .then(function (res) {
        return res.json().catch(function () {
          throw new Error('Bad response from local server')
        }).then(function (data) {
          if (!res.ok) {
            data.httpStatus = res.status
            if (res.status === 401 && data.authRequired) {
              loggedIn = false
              showLoginForm()
            }
            var err = new Error(data.error || ('Request failed (' + res.status + ')'))
            err.authFailed = !!data.authFailed
            err.httpStatus = res.status
            throw err
          }
          return data
        })
      })
  }

  function deviceLink () {
    el['device-link'].href = 'device.html?host=' + encodeURIComponent(HOST)
    el['head-host'].textContent = HOST || 'No device selected'
  }

  function showLoginForm () {
    el['login-form'].hidden = false
    el.logout.hidden = true
    el['backup-start'].disabled = true
    el['restore-start'].disabled = true
    try {
      var saved = localStorage.getItem(REMEMBER_KEY)
      if (saved) el.password.value = saved
    } catch (err) { }
  }

  function hideLoginForm () {
    el['login-form'].hidden = true
    el.password.value = ''
    el.logout.hidden = false
  }

  function renderDevice (device) {
    if (!device) {
      ;['dev-model', 'dev-pin', 'dev-os', 'dev-name', 'dev-battery', 'dev-free'].forEach(function (id) {
        el[id].textContent = '\u2014'
      })
      return
    }
    el['dev-model'].textContent = device.model || device.name || '\u2014'
    el['dev-pin'].textContent = device.pin || '\u2014'
    el['dev-os'].textContent = device.osVersion || '\u2014'
    el['dev-name'].textContent = device.friendlyName || device.name || '\u2014'
    el['dev-battery'].textContent = device.battery !== null && device.battery !== undefined ? device.battery + '%' : '\u2014'
    el['dev-free'].textContent = device.freeSpace ? fmtBytes(device.freeSpace) : '\u2014'
  }

  function selectedModes () {
    var out = []
    var boxes = el['cat-list'].querySelectorAll('input[data-cat]:checked')
    for (var i = 0; i < boxes.length; i++) out.push(boxes[i].getAttribute('data-cat'))
    return out
  }

  function selectedAppTypes () {
    var out = []
    var boxes = el['cat-list'].querySelectorAll('input[data-pkgtype]:checked')
    for (var i = 0; i < boxes.length; i++) out.push(boxes[i].getAttribute('data-pkgtype'))
    return out
  }

  function updateBackupUi () {
    var modes = selectedModes()
    var total = 0
    var known = true
    modes.forEach(function (id) {
      var c = categories.filter(function (x) { return x.id === id })[0]
      if (c && c.bytesize >= 0) total += c.bytesize
      else known = false
    })
    var label = 'Start backup'
    if (modes.length && known && total > 0) label += ' (' + fmtBytes(total) + ')'
    el['backup-start'].textContent = label
    el['backup-start'].disabled = !loggedIn || !modes.length || busyStarting
    if (!modes.length) el['backup-download'].hidden = true
  }

  function renderCategories () {
    var wrap = el['cat-list']
    wrap.innerHTML = ''
    if (!loggedIn) return
    if (!categories.length) {
      el['list-hint'].textContent = 'The device reports no backup data yet.'
      return
    }
    el['list-hint'].textContent = ''
    var hasApps = apps.length > 0
    categories.forEach(function (cat) {
      var item = document.createElement('div')
      item.className = 'cat-item'
      var box = document.createElement('input')
      box.type = 'checkbox'
      box.setAttribute('data-cat', cat.id)
      box.id = 'cat-' + cat.id
      box.checked = true
      box.addEventListener('change', updateBackupUi)
      var main = document.createElement('div')
      main.className = 'cat-main'
      var title = document.createElement('div')
      title.className = 'cat-title'
      title.textContent = cat.name || cat.id
      var meta = document.createElement('div')
      meta.className = 'cat-meta'
      meta.textContent = (cat.count ? cat.count + ' item' + (cat.count === 1 ? '' : 's') + ' \u00b7 ' : '') +
        (cat.bytesize >= 0 ? fmtBytes(cat.bytesize) : 'size unknown')
      main.appendChild(title)
      main.appendChild(meta)
      item.appendChild(box)
      item.appendChild(main)
      wrap.appendChild(item)
      if (cat.id === 'app' && hasApps) {
        var pkgRow = document.createElement('div')
        pkgRow.className = 'pkg-row'
        ;[
          ['system', 'App settings'],
          ['data', 'App data'],
          ['bin', 'App binaries']
        ].forEach(function (pair) {
          var label = document.createElement('label')
          var pkgBox = document.createElement('input')
          pkgBox.type = 'checkbox'
          pkgBox.setAttribute('data-pkgtype', pair[0])
          pkgBox.checked = true
          pkgBox.addEventListener('change', updateBackupUi)
          label.appendChild(pkgBox)
          label.appendChild(document.createTextNode(' ' + pair[1]))
          pkgRow.appendChild(label)
        })
        var hint = document.createElement('div')
        hint.className = 'cat-meta'
        hint.style.flexBasis = '100%'
        hint.textContent = apps.length + ' apps reported \u00b7 choose which parts to include'
        pkgRow.appendChild(hint)
        wrap.appendChild(pkgRow)
      }
    })
    updateBackupUi()
  }

  function renderRestoreCats () {
    var wrap = el['restore-cats']
    wrap.innerHTML = ''
    var name = el['restore-file'].value
    var f = files.filter(function (x) { return x.file === name })[0]
    if (!f || !f.entries || !f.entries.length) {
      el['restore-start'].disabled = true
      el['restore-warning'].hidden = true
      return
    }
    f.entries.forEach(function (entry) {
      var item = document.createElement('div')
      item.className = 'cat-item'
      var box = document.createElement('input')
      box.type = 'checkbox'
      box.setAttribute('data-rcat', entry.category)
      box.checked = true
      box.addEventListener('change', updateRestoreUi)
      var main = document.createElement('div')
      main.className = 'cat-main'
      var title = document.createElement('div')
      title.className = 'cat-title'
      title.textContent = entry.category.charAt(0).toUpperCase() + entry.category.slice(1)
      var meta = document.createElement('div')
      meta.className = 'cat-meta'
      meta.textContent = fmtBytes(entry.size)
      main.appendChild(title)
      main.appendChild(meta)
      item.appendChild(box)
      item.appendChild(main)
      wrap.appendChild(item)
    })
    el['restore-warning'].hidden = false
    updateRestoreUi()
  }

  function selectedRestoreModes () {
    var out = []
    var boxes = el['restore-cats'].querySelectorAll('input[data-rcat]:checked')
    for (var i = 0; i < boxes.length; i++) out.push(boxes[i].getAttribute('data-rcat'))
    return out
  }

  function updateRestoreUi () {
    var name = el['restore-file'].value
    var modes = selectedRestoreModes()
    el['restore-start'].disabled = !loggedIn || !name || !modes.length || busyStarting
  }

  function renderFiles () {
    var wrap = el['file-list']
    wrap.innerHTML = ''
    var select = el['restore-file']
    var previous = select.value
    select.innerHTML = ''
    if (!files.length) {
      var opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No backup files yet'
      select.appendChild(opt)
      renderRestoreCats()
      return
    }
    files.forEach(function (f) {
      var opt = document.createElement('option')
      opt.value = f.file
      opt.textContent = f.file + ' (' + fmtBytes(f.size) + ')'
      select.appendChild(opt)
      var item = document.createElement('div')
      item.className = 'file-item'
      var meta = document.createElement('div')
      meta.className = 'file-meta'
      var name = document.createElement('div')
      name.className = 'file-name'
      name.textContent = f.file
      var sub = document.createElement('div')
      sub.className = 'file-sub'
      var when = new Date(f.mtime).toLocaleString()
      var parts = f.entries
        ? f.entries.map(function (e) { return e.category + ' ' + fmtBytes(e.size) }).join(' \u00b7 ')
        : 'unreadable archive'
      sub.textContent = when + ' \u00b7 ' + fmtBytes(f.size) + (parts ? ' \u00b7 ' + parts : '')
      meta.appendChild(name)
      meta.appendChild(sub)
      var actions = document.createElement('div')
      actions.className = 'file-actions'
      var dl = document.createElement('a')
      dl.className = 'link-btn'
      dl.textContent = 'Download'
      dl.href = '/backup/' + encodeURIComponent(HOST) + '/api/download?file=' + encodeURIComponent(f.file)
      dl.setAttribute('download', f.file)
      var del = document.createElement('button')
      del.type = 'button'
      del.className = 'ghost small'
      del.textContent = 'Delete'
      del.addEventListener('click', function () {
        if (!confirm('Delete ' + f.file + ' from this computer?')) return
        api('delete', { body: { file: f.file } })
          .then(function () {
            log('Deleted ' + f.file)
            loadFiles()
          })
          .catch(function (err) { showBanner(err.message, 'bad') })
      })
      actions.appendChild(dl)
      actions.appendChild(del)
      item.appendChild(meta)
      item.appendChild(actions)
      wrap.appendChild(item)
    })
    if (previous && files.some(function (f) { return f.file === previous })) select.value = previous
    renderRestoreCats()
  }

  function setProgress (prefix, job) {
    var wrap = el[prefix + '-progress']
    var fill = el[prefix + '-fill']
    var status = el[prefix + '-status']
    if (!job || (job.state !== 'running' && job.state !== 'done' && job.state !== 'error' && job.state !== 'cancelled')) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false
    var pct = 0
    if (job.total > 0) pct = Math.min(100, Math.round(100 * job.bytes / job.total))
    if (job.state === 'done') pct = 100
    if (job.state === 'error' || job.state === 'cancelled') {
      fill.style.width = '100%'
      fill.style.background = job.state === 'cancelled'
        ? 'linear-gradient(90deg, #94a3b8, #64748b)'
        : 'linear-gradient(90deg, #ef4444, #b91c1c)'
    } else {
      fill.style.background = ''
      fill.style.width = pct + '%'
    }
    var catText = job.category ? ' \u00b7 ' + job.category + ' (' + job.categoryIndex + '/' + job.categoryCount + ')' : ''
    if (job.state === 'running') {
      status.textContent = (job.step || (job.kind === 'backup' ? 'Backing up' : 'Restoring')) + catText +
        ' \u00b7 ' + fmtBytes(job.bytes) + (job.total > 0 ? ' of ' + fmtBytes(job.total) : '') +
        ' \u00b7 ' + pct + '%' +
        (job.total > 0 && pct === 0 ? ' \u00b7 the device can take a while to prepare \u2014 keep it connected' : '')
    } else if (job.state === 'done') {
      status.textContent = (job.kind === 'backup' ? 'Backup complete: ' : 'Restore complete: ') +
        fmtBytes(job.bytes) + (job.file ? ' \u00b7 ' + job.file : '')
    } else if (job.state === 'cancelled') {
      status.textContent = 'Cancelled at ' + fmtBytes(job.bytes)
    } else {
      status.textContent = 'Failed: ' + (job.error || 'unknown error')
    }
  }

  function stopPolling () {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function refreshButtonsForJob (job) {
    var running = job && job.state === 'running'
    el['backup-cancel'].hidden = !(running && job.kind === 'backup')
    el['restore-cancel'].hidden = !(running && job.kind === 'restore')
    busyStarting = running
    if (running) {
      el['backup-start'].disabled = true
      el['restore-start'].disabled = true
    } else {
      updateBackupUi()
      updateRestoreUi()
    }
  }

  function handleJobUpdate (job) {
    if (!job) return
    setProgress(job.kind === 'backup' ? 'backup' : 'restore', job)
    refreshButtonsForJob(job)
    var key = job.kind + ':' + job.state
    if (key !== lastJobState) {
      if (job.state === 'done') {
        log((job.kind === 'backup' ? 'Backup finished' : 'Restore finished') +
          (job.file ? ' (' + job.file + ')' : '') + ' \u2014 ' + fmtBytes(job.bytes))
        if (job.kind === 'backup') {
          el['backup-download'].hidden = false
          el['backup-download'].href = '/backup/' + encodeURIComponent(HOST) +
            '/api/download?file=' + encodeURIComponent(job.file)
          loadFiles()
        }
        if (job.kind === 'restore') loadList()
      } else if (job.state === 'error') {
        log('Job failed: ' + (job.error || 'unknown error'))
      } else if (job.state === 'cancelled') {
        log('Job cancelled')
        if (job.kind === 'backup') loadFiles()
      }
      lastJobState = key
    }
    if (job.state !== 'running') stopPolling()
  }

  function startPolling () {
    stopPolling()
    pollTimer = setInterval(function () {
      api('status').then(function (data) {
        if (!data.job) {
          stopPolling()
          busyStarting = false
          el['backup-cancel'].hidden = true
          el['restore-cancel'].hidden = true
          updateBackupUi()
          updateRestoreUi()
          showBanner('The running job is gone. The local server may have been restarted.', 'warn')
          return
        }
        handleJobUpdate(data.job)
      }).catch(function () { })
    }, 1200)
  }

  function loadStatus () {
    return api('info').then(function (data) {
      loggedIn = !!data.loggedIn
      renderDevice(data.device)
      if (loggedIn) {
        setConnection('ok', 'Logged in')
        hideLoginForm()
        loadList()
      } else {
        setConnection('warn', 'Not logged in')
        showLoginForm()
      }
      if (data.job) handleJobUpdate(data.job)
      if (data.job && data.job.state === 'running') startPolling()
    })
  }

  function loadList () {
    return api('list').then(function (data) {
      categories = data.categories || []
      apps = data.apps || []
      if (data.device) renderDevice(data.device)
      setConnection('ok', 'Logged in')
      renderCategories()
    }).catch(function (err) {
      categories = []
      apps = []
      renderCategories()
      el['list-hint'].textContent = err.message
      throw err
    })
  }

  function loadFiles () {
    return api('files').then(function (data) {
      files = data.files || []
      renderFiles()
    }).catch(function (err) {
      log('Could not list backup files: ' + err.message)
    })
  }

  function doLogin (password, remember) {
    el['login-btn'].disabled = true
    api('login', { body: { password: password } })
      .then(function (data) {
        loggedIn = true
        el['login-btn'].disabled = false
        hideLoginForm()
        setConnection('ok', 'Logged in')
        renderDevice(data.device)
        log('Logged in to ' + HOST)
        if (remember) {
          try { localStorage.setItem(REMEMBER_KEY, password) } catch (err) { }
        }
        hideBanner()
        loadList().catch(function () { })
      })
      .catch(function (err) {
        el['login-btn'].disabled = false
        if (err.authFailed) {
          showBanner('The device rejected that password. ' +
            'Note: after several wrong attempts the device blocks further attempts for a while.', 'bad')
          try { localStorage.removeItem(REMEMBER_KEY) } catch (e) { }
        } else if (err.httpStatus === 502) {
          showBanner('Could not reach the device: ' + err.message, 'bad')
        } else {
          showBanner(err.message, 'bad')
        }
        log('Login failed: ' + err.message)
      })
  }

  function loadWireLog () {
    fetch('/backup/' + encodeURIComponent(HOST) + '/api/wirelog')
      .then(function (res) { return res.text() })
      .then(function (text) {
        el['wire-log'].textContent = text || '(empty)'
        el['wire-log'].scrollTop = el['wire-log'].scrollHeight
      })
      .catch(function (err) {
        el['wire-log'].textContent = 'Could not load: ' + err.message
      })
  }

  function init () {
    cacheElements()
    deviceLink()
    if (!HOST) {
      setConnection('bad', 'No device')
      el['head-host'].textContent = 'No device selected'
      showBanner('Open this page with ?host=<device address>, or open a device from the device list.', 'warn')
      return
    }
    var saved = null
    try { saved = localStorage.getItem(REMEMBER_KEY) } catch (err) { }
    el['login-form'].addEventListener('submit', function (ev) {
      ev.preventDefault()
      var pass = el.password.value
      if (!pass) return
      doLogin(pass, el.remember.checked)
    })
    el.reconnect.addEventListener('click', function () {
      hideBanner()
      loadStatus().catch(function (err) {
        setConnection('bad', 'Unreachable')
        showBanner('Could not reach the local server: ' + err.message, 'bad')
      })
      loadFiles()
    })
    el.logout.addEventListener('click', function () {
      api('logout', { body: {} }).then(function () {
        loggedIn = false
        categories = []
        apps = []
        renderCategories()
        setConnection('warn', 'Logged out')
        showLoginForm()
        log('Logged out')
      }).catch(function () { })
    })
    el['backup-start'].addEventListener('click', function () {
      var modes = selectedModes()
      if (!modes.length) return
      busyStarting = true
      el['backup-start'].disabled = true
      el['backup-download'].hidden = true
      lastJobState = null
      api('backup', { body: { modes: modes, rev2: true, appTypes: selectedAppTypes() } })
        .then(function (data) {
          log('Backup started: ' + data.job.modes.join(', '))
          setProgress('backup', data.job)
          refreshButtonsForJob(data.job)
          startPolling()
        })
        .catch(function (err) {
          busyStarting = false
          el['backup-start'].disabled = false
          showBanner(err.message, 'bad')
        })
    })
    el['backup-cancel'].addEventListener('click', function () {
      api('cancel', { body: {} }).then(function () { log('Cancelling backup\u2026') }).catch(function () { })
    })
    el['restore-start'].addEventListener('click', function () {
      var file = el['restore-file'].value
      var modes = selectedRestoreModes()
      if (!file || !modes.length) return
      if (!confirm('Restore ' + modes.join(', ') + ' from ' + file + ' onto ' + HOST + '?\n\n' +
        'Existing data in these categories on the device will be replaced.')) return
      busyStarting = true
      el['restore-start'].disabled = true
      lastJobState = null
      api('restore', { body: { file: file, modes: modes } })
        .then(function (data) {
          log('Restore started from ' + file + ': ' + data.job.modes.join(', '))
          setProgress('restore', data.job)
          refreshButtonsForJob(data.job)
          startPolling()
        })
        .catch(function (err) {
          busyStarting = false
          el['restore-start'].disabled = false
          showBanner(err.message, 'bad')
        })
    })
    el['restore-cancel'].addEventListener('click', function () {
      api('cancel', { body: {} }).then(function () { log('Cancelling restore\u2026') }).catch(function () { })
    })
    el['restore-file'].addEventListener('change', renderRestoreCats)
    el['files-refresh'].addEventListener('click', loadFiles)
    el['files-refresh2'].addEventListener('click', loadFiles)
    el['clear-log'].addEventListener('click', function () {
      el.log.textContent = ''
    })
    el['wire-refresh'].addEventListener('click', loadWireLog)
    el['wire-copy'].addEventListener('click', function () {
      var text = el['wire-log'].textContent
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          el['wire-copy'].textContent = 'Copied'
          setTimeout(function () { el['wire-copy'].textContent = 'Copy' }, 1500)
        }).catch(function () { })
      }
    })
    el['wire-clear'].addEventListener('click', function () {
      api('wirelog', { method: 'DELETE' }).then(function () {
        el['wire-log'].textContent = '(cleared)'
      }).catch(function () { })
    })

    loadWireLog()

    loadStatus().catch(function (err) {
      setConnection('bad', 'Unreachable')
      showBanner('Could not reach the local server: ' + err.message, 'bad')
    })
    loadFiles()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
