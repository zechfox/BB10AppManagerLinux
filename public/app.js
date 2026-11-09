;(function () {
  'use strict'

  var STORAGE_KEY = 'bb10:web:hosts'
  var LEGACY_KEY = 'hosts'

  var ICONS = {
    device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"></rect><path d="M10.5 18h3"></path></svg>',
    arrow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>'
  }

  var form = document.getElementById('device-form')
  var input = document.getElementById('hosts')
  var list = document.getElementById('device-list')
  var empty = document.getElementById('empty')
  var saved = document.getElementById('saved')
  var deviceCount = document.getElementById('device-count')
  var savedTimer

  function icon (name) {
    var wrap = document.createElement('span')
    wrap.innerHTML = ICONS[name]
    return wrap.firstElementChild
  }

  function normalizeHost (value) {
    var host = String(value || '').trim()
    if (!host) return ''
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    host = host.replace(/[/?#].*$/, '')
    host = host.replace(/\/+$/, '')
    return host.toLowerCase()
  }

  function parseHosts (raw) {
    var seen = Object.create(null)
    var out = []
    String(raw || '').split(/[,\n\r]+/).forEach(function (part) {
      var host = normalizeHost(part)
      if (host && !seen[host]) {
        seen[host] = true
        out.push(host)
      }
    })
    return out
  }

  function loadHosts () {
    try {
      var raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        var parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parseHosts(parsed.join(','))
      }
    } catch (err) { }

    try {
      var legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) return parseHosts(legacy.replace(/\|/g, ','))
    } catch (err) { }

    return []
  }

  function saveHosts (hosts) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
    } catch (err) { }
  }

  function openDevice (host) {
    location.href = 'device.html?host=' + encodeURIComponent(host)
  }

  function updateCount (total) {
    deviceCount.textContent = String(total)
    deviceCount.setAttribute('aria-label', total + (total === 1 ? ' device' : ' devices'))
  }

  function render (hosts) {
    list.textContent = ''
    empty.hidden = hosts.length > 0
    updateCount(hosts.length)

    hosts.forEach(function (host) {
      var row = document.createElement('li')
      row.className = 'device'

      var badge = document.createElement('div')
      badge.className = 'device-badge'
      badge.appendChild(icon('device'))

      var info = document.createElement('div')
      info.className = 'device-info'

      var text = document.createElement('div')
      text.className = 'device-host'
      text.textContent = host
      text.title = host

      var meta = document.createElement('div')
      meta.className = 'device-meta'
      var dot = document.createElement('span')
      dot.className = 'dot'
      meta.appendChild(dot)
      meta.appendChild(document.createTextNode('BB10 / PlayBook'))

      info.appendChild(text)
      info.appendChild(meta)

      var actions = document.createElement('div')
      actions.className = 'device-actions'

      var open = document.createElement('button')
      open.type = 'button'
      open.className = 'primary small'
      open.appendChild(document.createTextNode('Open'))
      open.appendChild(icon('arrow'))
      open.addEventListener('click', function () { openDevice(host) })

      var remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'icon-btn'
      remove.title = 'Remove device'
      remove.setAttribute('aria-label', 'Remove ' + host)
      remove.appendChild(icon('close'))
      remove.addEventListener('click', function () {
        var next = hosts.filter(function (item) { return item !== host })
        saveHosts(next)
        input.value = next.join(', ')
        render(next)
      })

      actions.appendChild(open)
      actions.appendChild(remove)

      row.appendChild(badge)
      row.appendChild(info)
      row.appendChild(actions)
      list.appendChild(row)
    })
  }

  function flashSaved () {
    saved.textContent = 'Saved'
    clearTimeout(savedTimer)
    savedTimer = setTimeout(function () { saved.textContent = '' }, 1500)
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    var hosts = parseHosts(input.value)
    saveHosts(hosts)
    input.value = hosts.join(', ')
    render(hosts)
    flashSaved()
  })

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      form.dispatchEvent(new Event('submit', { cancelable: true }))
    }
  })

  var hosts = loadHosts()

  var queryHost = normalizeHost(new URLSearchParams(location.search).get('host'))
  if (queryHost) {
    var merged = hosts.slice()
    if (merged.indexOf(queryHost) < 0) merged.push(queryHost)
    saveHosts(merged)
    openDevice(queryHost)
    return
  }

  input.value = hosts.join(', ')
  render(hosts)
})()
