#!/bin/sh
# Managed by the BB10 App Manager web UI.
# Installed into Term49's real home and run as: sh ssh-helper.sh <action>
HELPER_VERSION=3
PORT=2022

SANDBOX="${SANDBOX:-}"
if [ -n "$SANDBOX" ]; then
  D="$SANDBOX/data"
else
  D="$HOME"
fi

N="${NATIVE_TOOLS:-/accounts/1000/shared/misc/berrycore}"
H="$D/.ssh"
LOG="$H/sshd.log"
PID="$H/sshd.pid"
AUTH="$H/authorized_keys"
HOSTKEY="$H/id_rsa"
HELPER="$H/ssh-helper.sh"

say () {
  printf '%s\n' "$*"
}

ensure_dir () {
  mkdir -p "$H" 2>/dev/null
  chmod 700 "$H" 2>/dev/null
}

listening () {
  netstat -an 2>/dev/null | grep -q "[.:]$PORT[[:space:]].*LISTEN"
}

ensure_keys () {
  ensure_dir
  touch "$AUTH" 2>/dev/null
  chmod 600 "$AUTH" 2>/dev/null
  if [ ! -f "$HOSTKEY" ]; then
    HOME="$D" "$N/bin/ssh-keygen" -t rsa -b 2048 -f "$HOSTKEY" -N "" >/dev/null 2>&1
    chmod 600 "$HOSTKEY" 2>/dev/null
  fi
}

decode_uploaded_key () {
  if [ ! -f "$H/.key.b64" ]; then
    say "missing key upload"
    return 1
  fi
  if ! base64 -d "$H/.key.b64" > "$H/.key.new" 2>/dev/null; then
    say "base64 decode failed"
    rm -f "$H/.key.b64" "$H/.key.new"
    return 1
  fi
  count=$(grep -vc '^[[:space:]]*$' "$H/.key.new" 2>/dev/null)
  if [ "$count" != 1 ]; then
    say "expected one key, got $count"
    rm -f "$H/.key.b64" "$H/.key.new"
    return 1
  fi
  if ! grep -Eq '(ssh-rsa|ssh-ed25519|ecdsa-sha2-|sk-)' "$H/.key.new"; then
    say "invalid key"
    rm -f "$H/.key.b64" "$H/.key.new"
    return 1
  fi
  return 0
}

auth_count () {
  grep -vc '^[[:space:]]*$' "$AUTH" 2>/dev/null || printf '0'
}

do_status () {
  say "HELPER_VERSION=$HELPER_VERSION"
  say "SANDBOX=$SANDBOX"
  say "HOME_REAL=$D"
  say "SSH_DIR=$H"
  if [ -d "$D" ]; then say HOME_EXISTS=1; else say HOME_EXISTS=0; fi
  if [ -w "$D" ]; then say HOME_WRITABLE=1; else say HOME_WRITABLE=0; fi
  if [ -f "$HOSTKEY" ]; then say HOST_KEY=1; else say HOST_KEY=0; fi
  if [ -f "$AUTH" ]; then say "AUTH_KEYS=$(auth_count)"; else say AUTH_KEYS=0; fi
  if listening; then say SSHD_LISTEN=1; else say SSHD_LISTEN=0; fi
  if grep -q "# BerryCore: sshd auto-start" "$D/.profile" 2>/dev/null; then
    say AUTOSTART=1
  else
    say AUTOSTART=0
  fi
  if [ -x "$N/sbin/sshd" ]; then say SSHD_BIN=1; else say SSHD_BIN=0; fi
  if [ -x "$N/bin/ssh-keygen" ]; then say KEYGEN_BIN=1; else say KEYGEN_BIN=0; fi
  if [ -x "$N/bin/settings" ]; then say SETTINGS_BIN=1; else say SETTINGS_BIN=0; fi
  if command -v base64 >/dev/null 2>&1; then say BASE64=1; else say BASE64=0; fi
  id 2>/dev/null | sed 's/^/ID=/'
}

do_list_keys () {
  ensure_dir
  idx=0
  if [ -f "$AUTH" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|'#'*) continue ;;
      esac
      idx=$((idx + 1))
      printf '%s\n' "$line" > "$H/.fp.tmp"
      info=$("$N/bin/ssh-keygen" -lf "$H/.fp.tmp" 2>/dev/null)
      bits=$(printf '%s\n' "$info" | awk '{print $1}')
      fp=$(printf '%s\n' "$info" | awk '{print $2}')
      comment=$(printf '%s\n' "$info" | sed 's/^[^ ]* [^ ]* //; s/ (RSA)$//; s/ (ED25519)$//; s/ (ECDSA)$//; s/ (DSA)$//')
      type=$(printf '%s\n' "$line" | grep -oE '(ssh-rsa|ssh-ed25519|ecdsa-sha2-[^ ]+|sk-[^ ]+)' | head -1)
      [ -n "$bits" ] || bits="?"
      [ -n "$fp" ] || fp="unknown"
      say "KEY_INDEX=$idx"
      say "KEY_TYPE=${type:-unknown}"
      say "KEY_BITS=$bits"
      say "KEY_FP=$fp"
      say "KEY_COMMENT=$comment"
    done < "$AUTH"
  fi
  rm -f "$H/.fp.tmp"
  say "KEY_COUNT=$idx"
}

do_add_key () {
  ensure_dir
  decode_uploaded_key || return 1
  if [ -f "$AUTH" ]; then
    cp -p "$AUTH" "$AUTH.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null
  fi
  touch "$AUTH"
  chmod 600 "$AUTH" 2>/dev/null
  if grep -qF -f "$H/.key.new" "$AUTH" 2>/dev/null; then
    say "key already present"
  else
    if [ -s "$AUTH" ] && [ -n "$(tail -c 1 "$AUTH")" ]; then
      printf '\n' >> "$AUTH"
    fi
    cat "$H/.key.new" >> "$AUTH"
    printf '\n' >> "$AUTH"
    say "key added"
  fi
  rm -f "$H/.key.b64" "$H/.key.new"
  say "AUTH_KEYS=$(auth_count)"
}

do_replace_key () {
  idx="${1:-}"
  case "$idx" in
    ''|*[!0-9]*) say "bad key index"; return 1 ;;
  esac
  ensure_dir
  total=$(auth_count)
  if [ "$idx" -lt 1 ] || [ "$idx" -gt "$total" ]; then
    say "key index out of range"
    return 1
  fi
  decode_uploaded_key || return 1
  cp -p "$AUTH" "$AUTH.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null
  awk -v n="$idx" -v kf="$H/.key.new" '
    BEGIN { while ((getline line < kf) > 0) key = line }
    NF { c++; if (c == n) { if (!done) { print key; done = 1 } ; next } }
    { print }
    END { if (!done) print key }
  ' "$AUTH" > "$AUTH.tmp"
  mv "$AUTH.tmp" "$AUTH"
  chmod 600 "$AUTH" 2>/dev/null
  rm -f "$H/.key.b64" "$H/.key.new"
  say "key replaced at index $idx"
  say "AUTH_KEYS=$(auth_count)"
}

do_revoke_key () {
  idx="${1:-}"
  case "$idx" in
    ''|*[!0-9]*) say "bad key index"; return 1 ;;
  esac
  ensure_dir
  total=$(auth_count)
  if [ "$idx" -lt 1 ] || [ "$idx" -gt "$total" ]; then
    say "key index out of range"
    return 1
  fi
  cp -p "$AUTH" "$AUTH.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null
  awk -v n="$idx" '
    NF { c++; if (c == n) { next } }
    { print }
  ' "$AUTH" > "$AUTH.tmp"
  mv "$AUTH.tmp" "$AUTH"
  chmod 600 "$AUTH" 2>/dev/null
  say "key revoked at index $idx"
  say "AUTH_KEYS=$(auth_count)"
}

do_start () {
  ensure_keys
  if listening; then
    say "ALREADY_LISTENING=1"
    say "SSHD_LISTEN=1"
    return 0
  fi
  UPO=""
  if "$N/sbin/sshd" -t -f /dev/null -o HostKey="$HOSTKEY" -o UsePrivilegeSeparation=no >/dev/null 2>&1; then
    UPO="-oUsePrivilegeSeparation=no"
  fi
  HOME="$D" nohup "$N/sbin/sshd" -D -f /dev/null -o Port="$PORT" -o HostKey="$HOSTKEY" \
    -o AuthorizedKeysFile="$AUTH" -o PasswordAuthentication=no -o StrictModes=no \
    $UPO -o Subsystem="sftp $N/libexec/sftp-server" >> "$LOG" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$PID" 2>/dev/null
  sleep 2
  if listening; then
    say "SSHD_LISTEN=1"
  else
    say "SSHD_LISTEN=0"
    say "--- sshd log ---"
    tail -20 "$LOG" 2>/dev/null
  fi
}

do_stop () {
  if [ -f "$PID" ]; then
    pid=$(cat "$PID" 2>/dev/null)
    if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
      say "stopped pid $pid"
    else
      say "pid $pid not running"
    fi
    rm -f "$PID"
  else
    say "no pidfile"
  fi
  sleep 1
  if listening; then
    myuid=$(id -u 2>/dev/null)
    if [ -n "$myuid" ]; then
      pids=$(pidin -F "%U %a %A" 2>/dev/null | \
        awk -v u="$myuid" -v n="$N/sbin/sshd" '$1 == u && index($0, n) > 0 { print $2 }')
      for p in $pids; do
        if kill "$p" 2>/dev/null; then
          say "stopped pid $p (pidin)"
        fi
      done
      [ -n "$pids" ] && sleep 1
    fi
  fi
  if listening; then
    say "SSHD_LISTEN=1"
    say "sshd is still listening; it was not started by this panel (or the dev-mode service owns it)."
  else
    say "SSHD_LISTEN=0"
  fi
}

do_autostart_on () {
  ensure_keys
  HOME="$D" "$N/bin/settings" sshd-on
}

do_autostart_off () {
  HOME="$D" "$N/bin/settings" sshd-off
}

case "${1:-status}" in
  status) do_status ;;
  list-keys) do_list_keys ;;
  add-key) do_add_key ;;
  replace-key) do_replace_key "$2" ;;
  revoke-key) do_revoke_key "$2" ;;
  start) do_start ;;
  stop) do_stop ;;
  autostart-on) do_autostart_on ;;
  autostart-off) do_autostart_off ;;
  *)
    say "unknown action: ${1:-}"
    exit 2
    ;;
esac