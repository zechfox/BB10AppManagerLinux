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

Then open <http://127.0.0.1:8810> in your browser.

Add one or more device hostnames/IPs, click **Open**, and log in with the device
password. The rest of the UI is the original app manager UI: list apps, install
`.bar` files (drag and drop), launch, terminate and uninstall. The app list also has
an **Export list** button that saves the installed apps as a CSV inventory.

Inside a device, the left navigation has **SSH**, **Term49** and **Tmux** panes (next
to Installed apps, Detail Device Info, Install logs and About). The SSH panel is also
available standalone at `ssh.html`. All three use
[term49-web](https://github.com/sw7ft/BerryCore) as the on-device shell:

1. On the device, install and start it (it does not auto-start):
   ```sh
   qpkg install term49-web
   term49-web
   ```
2. Open the SSH pane, add an OpenSSH public key, then **Start sshd**.
3. Connect from your PC (the panel generates the client config):
   ```sh
   ssh -p 2022 -i ~/.ssh/id_rsa_bb10 blackberry@<host>
   ```

The panel discovers Term49's real sandbox through `$SANDBOX` (term49-web overrides
`HOME`), and keeps SSH files in Term49's own home (`$SANDBOX/data/.ssh`), which is not
exposed through Wi-Fi Storage. It installs a small helper script there on first use.
Authorized keys are listed with fingerprints and can be added, replaced or revoked
(keys are backed up before changes). The client config is shown on the page with the
legacy `ssh-rsa` options. **Enable auto-start** calls BerryCore's `settings sshd-on`,
so sshd starts on the next Term49 login.

The same navigation also has a **Term49** pane for editing Term49's config through
term49-web. It auto-detects `.term49rc` (BerryFarm Term49) and `.term48rc`
(BerryCore's Term48-based Term49 package), and the file can be selected manually. It
offers foreground/background theme presets, font path and size (with a device font
scan), virtual-keyboard/screen/column/encoding options, and a raw libconfig editor.
Saving preserves unrelated settings such as custom metamode keys and writes a `.bak`
backup first. Term49 only exposes default text and background colors, so the ANSI
palette used by `ls`, `git` and editors stays fixed. Close and reopen Term49 to apply
changes. Like the SSH pane, this requires term49-web to be running. The page is also
available standalone as `term49.html?host=<host>`.

The **Tmux** pane edits `~/.tmux.conf` in the same Term49 home. It sets the prefix key,
mouse events, history limit, base indexes, window renumbering, status bar and copy-mode
keys inside a managed block, leaving the rest of the file untouched. Saving backs up
the previous file as `.tmux.conf.bak`; **Apply to running tmux** reloads it with
`tmux source-file` when the server is running in that home. Install tmux on the device
with `qpkg install tmux`; the pane is also available standalone as
`tmux.html?host=<host>`. Term49 forwards taps and drags but not wheel events, so touch
swipes and the Passport trackpad do not scroll tmux; the pane documents using copy
mode with `j`/`k` or the arrow keys instead.

> **Security:** term49-web is an unauthenticated terminal. The SSH panel proxies it
> through this local app and validates the WebSocket origin, but the app still only
> listens on `127.0.0.1` by default. Do not use `LISTEN_HOST=0.0.0.0` with this feature
> unless you understand that anyone who can reach this app can run commands on the
> device. term49-web itself should stay on a trusted LAN.

You can also jump straight to a device:

```text
http://127.0.0.1:8810/?host=192.168.1.42
```

Change the port with `PORT=9000 npm start`. To listen on all interfaces use
`LISTEN_HOST=0.0.0.0 npm start` (only do this on a trusted network).

## How it works

```
Browser  ──HTTP──▶  local Node proxy  ──HTTPS (TLS verification off)──▶  BB10 / PlayBook
   │                  (127.0.0.1:8810)
   └── static HTML/JS (public/)
```

- `server.js` serves `public/` and proxies `/proxy/<host>/cgi-bin/...` to
  `https://<host>/cgi-bin/...`.
- For the SSH panel it also proxies `/term/<host>/...` and the `/term/<host>/ws`
  WebSocket to term49-web at `http://<host>:7681` (same-origin, with Host/Origin
  checks on the WebSocket upgrade).
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
- The SSH, Term49 and Tmux panels require `term49-web` to be running on the device,
  and term49-web has no boot autostart; start it in Term49 after each reboot.
  Auto-start (`settings sshd-on`) starts sshd on the next Term49 login, not at device
  boot. The Tmux pane also needs `qpkg install tmux`.
- The Term49 pane edits the active config (`.term49rc`, or `.term48rc` on BerryCore's
  Term49 package) inside Term49's sandbox. It cannot change the compiled 256-color ANSI
  palette; use a themeable browser terminal if you need that.
- SSH keys live in Term49's real home (`$SANDBOX/data/.ssh`) and are managed through
  term49-web; they are not reachable over Wi-Fi Storage.

## Credits

Original application: [zhetengbiji/bb10-app-manager](https://github.com/zhetengbiji/bb10-app-manager),
which itself is based on the BB10 / PlayBook App Manager by George J.
Distributed under the same terms as the upstream project.
