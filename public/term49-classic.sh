#!/bin/sh
# Term49 Classic companion manager. Managed by the BB10 App Manager web UI.
# Installed into Term49's real home and run as: sh term49-classic.sh <action>
# Builds/installs the bb10-classic-toolkit Term49 companion on-device.
CLASSIC_HELPER_VERSION=2

N="${NATIVE_TOOLS:-/accounts/1000/shared/misc/berrycore}"
# Real Term49 home: $SANDBOX/data when term49-web provides SANDBOX, else $HOME.
SD="${SANDBOX:+$SANDBOX/data}"
[ -n "$SD" ] || SD="$HOME"
WORK=/accounts/1000/shared/misc/term49-build
C=/accounts/1000/shared/misc/term49-cjk
I=/accounts/1000/shared/misc/term49-ime
UPSTREAM_TGZ=https://codeload.github.com/wesley138cn/bb10-classic-toolkit/tar.gz/refs/heads/main
GCC_SHA256=ffd33f3af6187673b40776e0870d317f97e450c491185e6bc5644513905e27e7
GCC_SIZE=108300360
TERM49_ZIP_URL=https://codeload.github.com/BerryFarm/Term49/zip/a02f06232c3af9781d4a7f70ed5939e7447825f7
TERM49_ZIP_SHA256=b306bf7f072fe61372fc881f66d9005fd563ab738c8dfef6c82c1885a751026b
PINYIN_URL=https://deb.debian.org/debian/pool/main/libg/libgooglepinyin/libgooglepinyin_0.1.2.orig.tar.bz2
PINYIN_SHA256=1a339ae45721a60b9fadd15e43c34b9bb27af3bb999c00ed0d88b4084cfd0637
FONT_URL=https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Mono/NotoSansMonoCJKsc-Regular.otf
FONT_SHA256=ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7

say () {
  printf '%s\n' "$*"
}

die () {
  say "ERROR: $*"
  exit 1
}

find_tool () {
  # $1 = binary name; prints full path or nothing
  for d in "$N/bin" /accounts/1000/shared/misc/clitools/bin /base/usr/bin /usr/bin /bin "$N/sbin"; do
    if [ -x "$d/$1" ]; then
      say "$d/$1"
      return 0
    fi
  done
  return 1
}

tool () {
  T=$(find_tool "$1")
  [ -n "$T" ] || die "$1 not found on the device"
  say "$T"
}

pps_field () {
  # $1 = field name; prints value from navigator state
  grep "^.*$1" /pps/services/navigator/state 2>/dev/null | head -1 | sed "s/^.*$1:://"
}

job_state () {
  # $1 = job name; prints none|running|ok|failed:<code>
  if [ -f "$WORK/$1.exit" ]; then
    code=$(cat "$WORK/$1.exit" 2>/dev/null)
    if [ -z "$code" ]; then
      say running
    elif [ "$code" = "0" ]; then
      say ok
    else
      say "failed:$code"
    fi
  elif [ -f "$WORK/$1.cmd" ]; then
    say running
  else
    say none
  fi
}

start_job () {
  # $1 = job name; $2 = command text
  [ -d "$WORK" ] || mkdir -p "$WORK" || die "cannot create $WORK"
  printf '%s\n' "$2" > "$WORK/$1.cmd" || die "cannot write $WORK/$1.cmd"
  rm -f "$WORK/$1.exit"
  nohup sh -c 'W=$1; : > "$W.exit"; sh "$W.cmd" > "$W.log" 2>&1; echo $? > "$W.exit"' sh "$WORK/$1" >/dev/null 2>&1 &
  say "JOB_STARTED=$1"
}

do_status () {
  say "CLASSIC_HELPER_VERSION=$CLASSIC_HELPER_VERSION"
  say "WORK=$WORK"
  say "HOME=$SD"
  if [ -x "$N/bin/gcc" ] && [ -d "$N/target_10_3_1_995/qnx6/usr/include" ]; then
    say "TOOLCHAIN=1"
  else
    say "TOOLCHAIN=0"
  fi
  if [ -d "$WORK/toolkit/term49" ]; then say "PATCHED=1"; else say "PATCHED=0"; fi
  T=$(find_tool curl); say "CURL=${T:+1}"
  T=$(find_tool sha256sum); say "SHA=${T:+1}"
  T=$(find_tool patch); say "PATCH=${T:+1}"
  say "TC_JOB=$(job_state tc)"
  say "FETCH_JOB=$(job_state fetch)"
  say "BUILD_JOB=$(job_state build)"
  if [ -f "$WORK/.toolkit-version" ]; then
    say "TKVER=$(cat "$WORK/.toolkit-version")"
  else
    say "TKVER="
  fi
  [ -f "$WORK/build-device.py" ] && say "TREE=1" || say "TREE=0"
  if [ -d "$WORK/external/lib" ] && [ -d "$WORK/external/include" ] && [ -d "$WORK/libgooglepinyin-0.1.2/src" ]; then
    say "DEPS=1"
  else
    say "DEPS=0"
  fi
  [ -f "$WORK/build/Term49-Classic" ] && say "BUILT=1" || say "BUILT=0"
  [ -f "$I/Term49-IME" ] && say "BIN=1" || say "BIN=0"
  [ -f "$I/dict_pinyin.dat" ] && say "DICT=1" || say "DICT=0"
  [ -f "$I/enabled" ] && say "IME_ON=1" || say "IME_ON=0"
  if [ -f "$C/NotoSansMonoCJKsc-Regular.otf" ] && [ -f "$C/lib/libSDL12.so" ] && \
     [ -f "$C/launch-attached.py" ] && [ -f "$C/start-cjk.sh" ]; then
    say "RUNTIME=1"
  else
    say "RUNTIME=0"
  fi
  [ -f "$C/enabled" ] && say "AUTO=1" || say "AUTO=0"
  grep -q "term49-cjk/enabled" "$SD/.profile" 2>/dev/null && say "HOOK=1" || say "HOOK=0"
  if [ -f "$C/terminal.pid" ]; then
    PID=$(cat "$C/terminal.pid" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      say "RUNNING=$PID"
    else
      say "RUNNING=0"
    fi
  else
    say "RUNNING=0"
  fi
  CURR=$(pps_field curr_window)
  FS=$(pps_field fullscreen)
  case "$CURR" in
    *Term49*) say "FORE=${FS:-0}" ;;
    *) say "FORE=0" ;;
  esac
}

do_toolchain () {
  CURL=$(find_tool curl) || die "curl not found; install the BerryCore curl port first"
  SHA=$(find_tool sha256sum) || die "sha256sum not found"
  [ -d "$WORK" ] || mkdir -p "$WORK" || die "cannot create $WORK"
  if [ -x "$N/bin/gcc" ] && [ -d "$N/target_10_3_1_995/qnx6/usr/include" ]; then
    say "Toolchain already installed; nothing to do."
    return 0
  fi
  cat > "$WORK/lfs-url.py" <<'PYEOF'
import json, sys
d = json.load(sys.stdin)
print(d["objects"][0]["actions"]["download"]["href"])
PYEOF
  cat > "$WORK/lfs.json" <<'JSONEOF'
{"operation":"download","transfer":["basic"],"objects":[{"oid":"ffd33f3af6187673b40776e0870d317f97e450c491185e6bc5644513905e27e7","size":108300360}]}
JSONEOF
  start_job tc '
set -e
W='"$WORK"'
N='"$N"'
CURL='"$CURL"'
SHA='"$SHA"'
PY='"$(find_tool python3.2 || say /base/usr/bin/python3.2)"'
curl_post () {
  "$CURL" -s -X POST "https://github.com/sw7ft/BerryCore.git/info/lfs/objects/batch" \
    -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" \
    --data-binary @"$W/lfs.json"
}
echo "Requesting download URL from Git LFS..."
curl_post > "$W/lfs.out"
HREF=$(LD_LIBRARY_PATH=/base/lib:/base/usr/lib "$PY" "$W/lfs-url.py" < "$W/lfs.out")
[ -n "$HREF" ] || { echo "no LFS href in response"; exit 1; }
echo "Downloading gcc.zip (108 MB)..."
"$CURL" -sL -o "$W/gcc.zip" "$HREF"
echo "Verifying sha256..."
GOT=$("$SHA" "$W/gcc.zip" | cut -d" " -f1)
[ "$GOT" = "'"$GCC_SHA256"'" ] || { echo "hash mismatch: $GOT"; exit 1; }
mkdir -p "$N/packages"
if [ -f "$N/packages/gcc.zip" ] && ! grep -q "PK" "$N/packages/gcc.zip" 2>/dev/null; then
  mv "$N/packages/gcc.zip" "$N/packages/gcc.zip.lfs-stub"
fi
mv "$W/gcc.zip" "$N/packages/gcc.zip"
echo "Extracting into $N ..."
(cd "$N" && unzip -o -q "$N/packages/gcc.zip" -d "$N")
chmod +x "$N/bin/"* "$N/arm-unknown-nto-qnx8.0.0eabi/bin/"* 2>/dev/null || true
[ -x "$N/bin/gcc" ] || { echo "gcc missing after extraction"; exit 1; }
[ -d "$N/target_10_3_1_995/qnx6/usr/include" ] || { echo "qnx6 SDK missing"; exit 1; }
mkdir -p "$N/.qpkg/files"
unzip -l "$N/packages/gcc.zip" | awk "NR>3 && \$4 !~ /^-+\$/ && \$4 != \"\" {print \$4}" > "$N/.qpkg/files/gcc.list"
grep -q "^gcc|" "$N/.qpkg/installed" 2>/dev/null || echo "gcc|4.6.3|$(date +%Y-%m-%d)|gcc.zip" >> "$N/.qpkg/installed"
echo "Toolchain installed: $("'"$N"'/bin/gcc" --version 2>&1 | head -1)"
'
}

do_fetch () {
  state=$(job_state build)
  if [ "$state" = "running" ]; then die "build is running; wait or check Build log first"; fi
  CURL=$(find_tool curl) || die "curl not found"
  SHA=$(find_tool sha256sum) || die "sha256sum not found"
  PATCH=$(find_tool patch) || die "patch not found (BerryCore dev tools)"
  TAR=$(find_tool tar) || die "tar not found"
  UNZIP=$(find_tool unzip) || die "unzip not found"
  [ -d "$WORK" ] || mkdir -p "$WORK" || die "cannot create $WORK"
  start_job fetch '
set -e
W='"$WORK"'
CURL='"$CURL"'
SHA='"$SHA"'
PATCH='"$PATCH"'
TAR='"$TAR"'
UNZIP='"$UNZIP"'
fetch_hash () {
  # url expected_sha dest
  echo "Fetching $1 ..."
  "$CURL" -sL -o "$3" "$1"
  GOT=$("$SHA" "$3" | cut -d" " -f1)
  [ "$GOT" = "$2" ] || { echo "hash mismatch for $3: $GOT"; exit 1; }
}
echo "Fetching bb10-classic-toolkit (latest main)..."
rm -rf "$W/toolkit" "$W/toolkit.tgz"
"$CURL" -sL -o "$W/toolkit.tgz" '"$UPSTREAM_TGZ"'
[ -s "$W/toolkit.tgz" ] || { echo "toolkit download failed"; exit 1; }
mkdir -p "$W/toolkit"
"$TAR" xzf "$W/toolkit.tgz" -C "$W/toolkit" --strip-components 1
SRC="$W/toolkit/term49"
[ -f "$SRC/build-device.py" ] || { echo "toolkit tree incomplete (term49/build-device.py missing)"; exit 1; }
echo "main@$("$SHA" "$W/toolkit.tgz" | cut -c1-12)" > "$W/.toolkit-version"
rm -rf "$W/src"
cp -r "$SRC/src" "$W/src"
for f in ime_engine.cpp ime_engine.h test-engine.cpp test-pty.c build-device.py; do
  cp "$SRC/$f" "$W/$f"
done
echo "Fetching Term49 upstream snapshot..."
fetch_hash '"$TERM49_ZIP_URL"' '"$TERM49_ZIP_SHA256"' "$W/term49.zip"
rm -rf "$W/Term49-up" "$W/external"
mkdir -p "$W/Term49-up"
"$UNZIP" -o -q "$W/term49.zip" -d "$W/Term49-up"
mv "$W/Term49-up"/Term49-*/external "$W/external"
echo "Fetching libgooglepinyin..."
fetch_hash '"$PINYIN_URL"' '"$PINYIN_SHA256"' "$W/pinyin.tar.bz2"
rm -rf "$W/libgooglepinyin-0.1.2" "$W/pinyin-stage"
mkdir -p "$W/pinyin-stage"
"$TAR" xjf "$W/pinyin.tar.bz2" -C "$W/pinyin-stage"
"$PATCH" --batch -p1 -d "$W/pinyin-stage/libgooglepinyin-0.1.2" -i "$W/toolkit/term49/googlepinyin-qnx.patch"
mv "$W/pinyin-stage/libgooglepinyin-0.1.2" "$W/libgooglepinyin-0.1.2"
echo "Fetching Noto CJK font..."
fetch_hash '"$FONT_URL"' '"$FONT_SHA256"' "$W/NotoSansMonoCJKsc-Regular.otf"
ls "$W/toolkit/term49/src" >/dev/null
echo "Toolchain-independent source and deps ready."
'
}

do_build () {
  [ -f "$WORK/build-device.py" ] || die "source not fetched yet (run Fetch source first)"
  [ -d "$WORK/external/lib" ] || die "dependencies missing (run Fetch source first)"
  [ -x "$N/bin/gcc" ] || die "toolchain missing (run Install toolchain first)"
  state=$(job_state fetch)
  [ "$state" = "ok" ] || [ "$state" = "none" ] || die "fetch job still $state"
  start_job build '
set -e
W='"$WORK"'
N='"$N"'
export QNX_HOST="$N"
export QNX_TARGET="$N/target_10_3_1_995/qnx6"
export PATH="$N/bin:/base/bin:/base/usr/bin"
cd "$W"
rm -rf build
LD_LIBRARY_PATH=/base/lib:/base/usr/lib /base/usr/bin/python3.2 build-device.py --external external --pinyin libgooglepinyin-0.1.2
'
}

do_buildstatus () {
  say "BUILD_JOB=$(job_state build)"
  if [ -f "$WORK/build.log" ]; then
    say "--- build.log tail ---"
    tail -n "${1:-15}" "$WORK/build.log"
  fi
}

do_install () {
  [ -f "$WORK/build/Term49-Classic" ] || die "not built yet (run Build first)"
  [ -f "$WORK/build/dict_pinyin.dat" ] || die "dictionary missing from build"
  [ -f "$WORK/NotoSansMonoCJKsc-Regular.otf" ] || die "font missing (run Fetch source first)"
  [ -f "$WORK/external/lib/libSDL12.so" ] || die "SDL library missing (run Fetch source first)"
  mkdir -p "$I" "$C/lib"
  cp "$WORK/build/Term49-Classic" "$I/Term49-IME"
  cp "$WORK/build/dict_pinyin.dat" "$I/dict_pinyin.dat"
  chmod +x "$I/Term49-IME"
  cp "$WORK/NotoSansMonoCJKsc-Regular.otf" "$C/NotoSansMonoCJKsc-Regular.otf"
  cp "$WORK/external/lib/libSDL12.so" "$C/lib/libSDL12.so"
  cp "$WORK/external/lib/libTouchControlOverlay.so" "$C/lib/libTouchControlOverlay.so"
  cp "$WORK/external/lib/libconfig.so" "$C/lib/libconfig.so.11"
  cp "$WORK/toolkit/term49/launch-attached.py" "$C/launch-attached.py"
  cp "$WORK/toolkit/term49/start-cjk.sh" "$C/start-cjk.sh"
  chmod +x "$C/start-cjk.sh"
  # Accept both package names: BerryFarm ships com.example.Term49, BerryCore's
  # Term48-based Term49 runs as com.update.Term49. $HOME/$SD are unreliable here
  # (term49-web may override HOME with a foreign sandbox), so patch unconditionally.
  if ! grep -q "com.update.Term49." "$C/launch-attached.py"; then
    sed -i "s/startswith('com\.example\.Term49\.')/startswith(('com.example.Term49.', 'com.update.Term49.'))/g" "$C/launch-attached.py"
    grep -q "com.update.Term49." "$C/launch-attached.py" \
      || say "WARNING: launcher patch did not apply; BerryCore Term49 would be refused."
    say "Patched launcher to accept com.example.Term49 and com.update.Term49."
  fi
  # After a reboot the navigator PPS state can take well over the upstream 3 s
  # to become ready; widen the foreground poll to 30 s.
  if grep -q "range(12)" "$C/launch-attached.py"; then
    sed -i "s/range(12)/range(60)/; s/time\.sleep(0\.25)/time.sleep(0.5)/" "$C/launch-attached.py"
    say "Widened launcher foreground poll to 30 s (slow boots)."
  fi
  # term49-web may override HOME with a dead/foreign sandbox path; resolve the
  # companion cwd from SANDBOX first and fall back instead of crashing.
  if ! grep -q "SANDBOX,'')+'/data'" "$C/launch-attached.py"; then
    cat > "$WORK/cwdpatch.py" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = "cwd=os.path.expanduser('~')"
new = "cwd=os.path.isdir(os.environ.get('SANDBOX','')+'/data') and os.environ.get('SANDBOX','')+'/data' or (os.path.isdir(os.path.expanduser('~')) and os.path.expanduser('~')) or '/accounts/1000/shared/misc/term49-cjk'"
if old in s and new not in s:
    s = s.replace(old, new)
    open(p, 'w').write(s)
    print('Patched launcher cwd to resolve from SANDBOX with fallbacks.')
else:
    print('Launcher cwd already robust or pattern changed.')
PYEOF
    LD_LIBRARY_PATH=/base/lib:/base/usr/lib /base/usr/bin/python3.2 "$WORK/cwdpatch.py" "$C/launch-attached.py"
  fi
  if ! grep -q "guard.log" "$C/launch-attached.py"; then
    cat > "$WORK/guardpatch.py" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = " print('Keep the original Term49 in the foreground, then run term-cjk again.')"
new = (" try:\n"
       "  open('/accounts/1000/shared/misc/term49-cjk/guard.log','a').write('guard fail: curr=%r pid=%r\n' % (app.group(1) if app else None, pid.group(1) if pid else None))\n"
       " except Exception:\n"
       "  pass\n"
       " print('Keep the original Term49 in the foreground, then run term-cjk again.')")
if old in s and 'guard.log' not in s:
    s = s.replace(old, new)
    open(p, 'w').write(s)
    print('guard logging installed')
else:
    print('guard logging already present or pattern changed')
cond_old = "if app and app.group(1).startswith(('com.example.Term49.', 'com.update.Term49.')) and pid and pid.group(1)!='0':break"
cond_new = "if app and pid and pid.group(1)!='0' and (app.group(1).startswith(('com.example.Term49.', 'com.update.Term49.')) or app.group(1)=='none'):break"
if cond_old in s:
    s = s.replace(cond_old, cond_new)
    open(p, 'w').write(s)
    print('none-state accepted during boot transitions')
elif cond_new in s:
    print('none-state already accepted')
else:
    print('WARNING: guard condition pattern not found')
PYEOF
    LD_LIBRARY_PATH=/base/lib:/base/usr/lib /base/usr/bin/python3.2 "$WORK/guardpatch.py" "$C/launch-attached.py"
  fi
  : > "$I/enabled"
  # Companion config: copy the active terminal config once, swap the font.
  if [ ! -f "$SD/.term49cjkrc" ]; then
    if [ -f "$SD/.term49rc" ]; then SRCRC="$SD/.term49rc"
    elif [ -f "$SD/.term48rc" ]; then SRCRC="$SD/.term48rc"
    else SRCRC=""
    fi
    if [ -n "$SRCRC" ]; then
      sed "s|^font_path = .*|font_path = \"$C/NotoSansMonoCJKsc-Regular.otf\";|" "$SRCRC" > "$SD/.term49cjkrc"
    else
      {
        say "font_path = \"$C/NotoSansMonoCJKsc-Regular.otf\";"
        say "font_size = 14;"
        say "tty_encoding = \"UTF-8\";"
      } > "$SD/.term49cjkrc"
    fi
    say "Created .term49cjkrc with the Noto CJK font."
  fi
  say "Runtime installed into term49-ime/ and term49-cjk/."
  say "Use Enable auto-start (or Launch now) to activate."
}

HOOK_MARKER="# Term49 Classic companion"
do_enable () {
  [ -f "$I/Term49-IME" ] || die "not installed yet (run Install first)"
  [ -d "$SD" ] && [ -w "$SD" ] || die "Term49 home is not writable: $SD (start term49-web from Term49)"
  : > "$C/enabled"
  if ! grep -q "$HOOK_MARKER" "$SD/.profile" 2>/dev/null; then
    [ -f "$SD/.profile.before-term49-classic" ] || cp -p "$SD/.profile" "$SD/.profile.before-term49-classic"
    cat >> "$SD/.profile" <<'PROFEOF'

# Term49 Classic companion (scrollback + IME); remove term49-cjk/enabled to disable
if [ -t 0 ] && [ -z "${TERM49_CJK-}" ] && [ -f /accounts/1000/shared/misc/term49-cjk/enabled ]; then
  sh /accounts/1000/shared/misc/term49-cjk/start-cjk.sh
fi
PROFEOF
    say "Added .profile hook (backup: .profile.before-term49-classic)."
  fi
  say "Auto-start enabled. Close and reopen Term49 to boot into the companion."
}

do_disable () {
  rm -f "$C/enabled"
  say "Auto-start disabled. Reopen Term49 for the original terminal."
  say "(The .profile hook stays but is inert; remove term49-cjk/enabled marker file to re-enable.)"
}

do_launch () {
  if [ -f "$C/terminal.pid" ]; then
    PID=$(cat "$C/terminal.pid" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      say "Already running (pid $PID)."
      return 0
    fi
  fi
  [ -f "$I/Term49-IME" ] || die "not installed yet (run Install first)"
  CURR=$(pps_field curr_window)
  FS=$(pps_field fullscreen)
  case "$CURR" in
    *Term49*) ;;
    *) die "Term49 is not in the foreground. Open Term49 on the device, then retry." ;;
  esac
  [ -n "$FS" ] && [ "$FS" != "0" ] || die "The device looks locked. Unlock the screen with Term49 in the foreground, then retry."
  rm -f "$C/terminal.log" "$C/terminal.pid"
  LD_LIBRARY_PATH=/base/lib:/base/usr/lib /base/usr/bin/python3.2 "$C/launch-attached.py" --background || true
  sleep 2
  PID=$(cat "$C/terminal.pid" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    say "LAUNCHED=$PID"
    head -n 5 "$C/terminal.log" 2>/dev/null
  else
    say "LAUNCH_FAILED"
    head -n 10 "$C/terminal.log" 2>/dev/null
    exit 1
  fi
}

do_stop () {
  if [ -f "$C/terminal.pid" ]; then
    PID=$(cat "$C/terminal.pid" 2>/dev/null)
    if [ -n "$PID" ] && kill "$PID" 2>/dev/null; then
      say "stopped pid $PID"
    else
      say "pid $PID not running"
    fi
    rm -f "$C/terminal.pid"
  else
    say "no pidfile"
  fi
}

do_log () {
  # $1 = build|terminal|tc|fetch ; $2 = lines
  name=${1:-build}
  lines=${2:-40}
  case "$name" in
    build) F="$WORK/build.log" ;;
    terminal) F="$C/terminal.log" ;;
    tc) F="$WORK/tc.log" ;;
    fetch) F="$WORK/fetch.log" ;;
    *) die "unknown log: $name" ;;
  esac
  if [ -f "$F" ]; then
    tail -n "$lines" "$F"
  else
    say "(no log yet: $F)"
  fi
}

case "${1:-status}" in
  status) do_status ;;
  toolchain) do_toolchain ;;
  fetch) do_fetch ;;
  build) do_build ;;
  buildstatus) do_buildstatus "${2:-15}" ;;
  install) do_install ;;
  enable) do_enable ;;
  disable) do_disable ;;
  launch) do_launch ;;
  stop) do_stop ;;
  log) do_log "${2:-build}" "${3:-40}" ;;
  *)
    say "unknown action: ${1:-}"
    say "actions: status toolchain fetch build buildstatus install enable disable launch stop log"
    exit 2
    ;;
esac
