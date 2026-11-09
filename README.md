# BB10 / PlayBook App Manager (web / Linux port)

A browser-based port of [zhetengbiji/bb10-app-manager](https://github.com/zhetengbiji/bb10-app-manager).
Instead of an Electron desktop app, it runs as a normal web page served by a small
local Node.js process.

The Node process is a **local reverse proxy** to your device. It exists only to solve
the things a web page cannot do by itself:

- talk to the device's self-signed HTTPS endpoint,
- send the `QNXWebClient/1.0` User-Agent required by the device,
- keep per-device login cookies,
- avoid CORS problems by serving the page and proxy on the same origin.

There are **no npm dependencies**. Node.js is the only requirement.

## Requirements

- Node.js 14 or newer
- A BB10 / PlayBook device with **Development Mode** enabled
- Device reachable over Wi-Fi or USB (USB usually `169.254.x.x`)

## Run

```sh
npm start
# or
node server.js
```

Then open <http://127.0.0.1:8080> in your browser.

Add one or more device hostnames/IPs, click **Open**, and log in with the device
password. The rest of the UI is the original app manager UI: list apps, install
`.bar` files (drag and drop), launch, terminate and uninstall. The app list also has
an **Export list** button that saves the installed apps as a CSV inventory.

You can also jump straight to a device:

```text
http://127.0.0.1:8080/?host=192.168.1.42
```

Change the port with `PORT=9000 npm start`. To listen on all interfaces use
`LISTEN_HOST=0.0.0.0 npm start` (only do this on a trusted network).

## How it works

```
Browser  ──HTTP──▶  local Node proxy  ──HTTPS (TLS verification off)──▶  BB10 / PlayBook
   │                  (127.0.0.1:8080)
   └── static HTML/JS (public/)
```

- `server.js` serves `public/` and proxies `/proxy/<host>/cgi-bin/...` to
  `https://<host>/cgi-bin/...`.
- `public/pb-apps.js` is the original device logic (login challenge, SHA-512
  key derivation, app list parsing, install queue), adapted only to:
  - use the `/proxy/<host>` prefix,
  - show the real device hostname instead of `localhost`,
  - namespace saved credentials in `localStorage` per device,
  - add a back-link to the device list.

Only the network layer changed; app management behaviour is unchanged.

## Security notes

- The proxy accepts invalid/self-signed TLS certificates because that is what the
  device serves. It only talks to the host you specify in the URL.
- It listens on `127.0.0.1` by default.
- "Auto Login" stores the device password in your browser's `localStorage`. Use it
  only on a trusted machine.
- Cookies are kept in memory in the Node process and are not written to disk.

## Known limitations

- HTTPS only (the device's normal management service).
- The proxy enables legacy TLS (TLS 1.0/1.1, old ciphers, security level 0) so older
  BB10 / PlayBook firmware can connect. Firmware that only speaks SSLv3 cannot be
  used with modern Node/OpenSSL.
- Device status (battery / free space) is only shown for USB addresses
  (`169.254.x.x`), same as the original.
- Closing the Node process clears login sessions and requires logging in again.

## Credits

Original application: [zhetengbiji/bb10-app-manager](https://github.com/zhetengbiji/bb10-app-manager),
which itself is based on the BB10 / PlayBook App Manager by George J.
Distributed under the same terms as the upstream project.
