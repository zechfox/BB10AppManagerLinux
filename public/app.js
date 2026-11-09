;(function () {
  'use strict'

  var STORAGE_KEY = 'bb10:web:hosts'
  var LEGACY_KEY = 'hosts'

  var form = document.getElementById('device-form')
  var input = document.getElementById('hosts')
  var list = document.getElementById('device-list')
  var empty = document.getElementById('empty')
  var saved = document.getElementById('saved')
  var savedTimer

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

  function render (hosts) {
    list.textContent = ''
    empty.hidden = hosts.length > 0

    hosts.forEach(function (host) {
      var row = document.createElement('li')

      var text = document.createElement('div')
      text.className = 'device-host'
      text.textContent = host

      var open = document.createElement('button')
      open.type = 'button'
      open.className = 'primary small'
      open.textContent = 'Open'
      open.addEventListener('click', function () { openDevice(host) })

      var remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'ghost small'
      remove.textContent = 'Remove'
      remove.addEventListener('click', function () {
        var next = hosts.filter(function (item) { return item !== host })
        saveHosts(next)
        input.value = next.join(', ')
        render(next)
      })

      row.appendChild(text)
      row.appendChild(open)
      row.appendChild(remove)
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
