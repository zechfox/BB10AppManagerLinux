#!/bin/sh
# Pi Classic (pi coding agent) deployment manager for bb10-classic-toolkit.
# Managed by the BB10 App Manager web UI. Installed into Term49's real home
# and run as: sh pi-classic.sh <action>
PI_HELPER_VERSION=2

N="${NATIVE_TOOLS:-/accounts/1000/shared/misc/berrycore}"
ROOT=/accounts/1000/shared/misc/pi-classic
DOCS=/accounts/1000/shared/documents
WORK=/accounts/1000/shared/misc/pi-build
# Real Term49 home: $SANDBOX/data when term49-web provides SANDBOX, else $HOME.
SD="${SANDBOX:+$SANDBOX/data}"
[ -n "$SD" ] || SD="$HOME"
PDIR=${0%/*}
TK=bb10-classic-toolkit
TK_URL=https://codeload.github.com/wesley138cn/bb10-classic-toolkit/tar.gz/refs/heads/main
NODE_ZIP_NAME=lang-node-term49-22.0.0.zip
NODE_ZIP_URL=https://github.com/sw7ft/BerryCore/raw/main/ports/$NODE_ZIP_NAME
NODE_ZIP_SHA256=6b6ca11c70eaf110ec1d305fda762979d48702a581328455404c7444279d4744

say () {
  printf '%s\n' "$*"
}

die () {
  say "ERROR: $*"
  exit 1
}

find_tool () {
  for d in "$N/bin" /accounts/1000/shared/misc/clitools/bin /base/usr/bin /usr/bin /bin "$N/sbin"; do
    if [ -x "$d/$1" ]; then
      say "$d/$1"
      return 0
    fi
  done
  return 1
}

py () {
  # system python with library isolation (per toolkit README)
  LD_LIBRARY_PATH=/base/lib:/base/usr/lib /base/usr/bin/python3.2 "$@"
}

dget () {
  # resumable download; device-side GitHub links stall without retry
  # $1 = url, $2 = dest
  CURL=$(find_tool curl) || return 1
  i=0
  while [ $i -lt 6 ]; do
    "$CURL" -sL -C - --max-time 1800 -o "$2" "$1" && return 0
    i=$((i + 1))
    sleep 3
  done
  return 1
}

pps_field () {
  grep "^.*$1" /pps/services/navigator/state 2>/dev/null | head -1 | sed "s/^.*$1:://"
}

job_state () {
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
  [ -d "$WORK" ] || mkdir -p "$WORK" || die "cannot create $WORK"
  # Job scripts run in a fresh shell: give them the shared helpers.
  cat > "$WORK/common.sh" <<'COMMON'
find_tool () {
  N="${NATIVE_TOOLS:-/accounts/1000/shared/misc/berrycore}"
  for d in "$N/bin" /accounts/1000/shared/misc/clitools/bin /base/usr/bin /usr/bin /bin "$N/sbin"; do
    if [ -x "$d/$1" ]; then
      echo "$d/$1"
      return 0
    fi
  done
  return 1
}
dget () {
  CURL=$(find_tool curl) || return 1
  i=0
  while [ $i -lt 6 ]; do
    "$CURL" -sL -C - --max-time 1800 -o "$2" "$1" && return 0
    i=$((i + 1))
    sleep 3
  done
  return 1
}
COMMON
  printf '%s\n' "$2" > "$WORK/$1.cmd" || die "cannot write $WORK/$1.cmd"
  rm -f "$WORK/$1.exit"
  nohup sh -c 'W=$1; : > "$W.exit"; sh "$W.cmd" > "$W.log" 2>&1; echo $? > "$W.exit"' sh "$WORK/$1" >/dev/null 2>&1 &
  say "JOB_STARTED=$1"
}

do_status () {
  say "PI_HELPER_VERSION=$PI_HELPER_VERSION"
  say "ROOT=$ROOT"
  say "HOME=$SD"
  if [ -x "$N/bin/node" ]; then say "QPKG_NODE=1"; else say "QPKG_NODE=0"; fi
  say "NODE_JOB=$(job_state node)"
  say "NODEZIP_JOB=$(job_state nodezip)"
  say "PKG_JOB=$(job_state pkgpull)"
  say "SCRIPTS_JOB=$(job_state scripts)"
  [ -f "$DOCS/pi-node-term49.zip" ] && say "NODEZIP=1" || say "NODEZIP=0"
  [ -f "$DOCS/pi-package.zip" ] && say "PKGZIP=1" || say "PKGZIP=0"
  if [ -f "$ROOT/install-node.py" ] && [ -f "$ROOT/pi-launch.sh" ] && [ -f "$ROOT/compat.mjs" ]; then
    say "SCRIPTS=1"
  else
    say "SCRIPTS=0"
  fi
  [ -d "$ROOT/node" ] && say "PRIVNODE=1" || say "PRIVNODE=0"
  [ -d "$ROOT/package" ] && say "PACKAGE=1" || say "PACKAGE=0"
  [ -f "$N/bin/pi" ] && say "LAUNCHER=1" || say "LAUNCHER=0"
  [ -f "$SD/.pi/agent/extensions/classic-guard.js" ] && say "GUARD=1" || say "GUARD=0"
  [ -f "$SD/.pi/agent/models.json" ] && say "CREDS=1" || say "CREDS=0"
  [ -f "$SD/.berrycloud/config.json" ] && say "BERRYCLOUD=1" || say "BERRYCLOUD=0"
  if [ -f "$ROOT/node/bin/node.bin" ]; then
    V=$(LD_LIBRARY_PATH="$ROOT/node/bin:/base/lib:/base/usr/lib" "$ROOT/node/bin/node.bin" --version 2>/dev/null)
    say "NODE_VERSION=${V:-unknown}"
  else
    say "NODE_VERSION="
  fi
}

do_node () {
  state=$(job_state node)
  [ "$state" = "running" ] && die "node install already running"
  [ -x "$N/bin/qpkg" ] || die "qpkg not found under $N/bin"
  start_job node '
N='"$N"'
export NATIVE_TOOLS="$N"
PATH="$N/bin:/base/bin:/base/usr/bin:$PATH"
export PATH
QPKG_YES=1 "$N/bin/qpkg" install node-term49
'
}

do_nodezip () {
  state=$(job_state nodezip)
  [ "$state" = "running" ] && die "node zip fetch already running"
  SHA=$(find_tool sha256sum) || die "sha256sum not found"
  mkdir -p "$DOCS" || die "cannot create $DOCS"
  start_job nodezip '
. '"$WORK"'/common.sh
SHA='"$SHA"'
dget '"$NODE_ZIP_URL"' '"$DOCS"'/pi-node-term49.zip.part || { echo "download failed"; exit 1; }
GOT=$("$SHA" '"$DOCS"'/pi-node-term49.zip.part | cut -d" " -f1)
[ "$GOT" = "'"$NODE_ZIP_SHA256"'" ] || { echo "hash mismatch: $GOT"; exit 1; }
mv '"$DOCS"'/pi-node-term49.zip.part '"$DOCS"'/pi-node-term49.zip
echo "node zip ready (sha256 verified)."
'
}

do_pkgpull () {
  # $1 = artifact base URL, e.g. http://192.168.x.x:8810/artifacts
  [ -n "$1" ] || die "usage: pkgpull <base-url>"
  state=$(job_state pkgpull)
  [ "$state" = "running" ] && die "package pull already running"
  CURL=$(find_tool curl) || die "curl not found"
  SHA=$(find_tool sha256sum) || die "sha256sum not found"
  mkdir -p "$DOCS" || die "cannot create $DOCS"
  start_job pkgpull '
set -e
CURL='"$CURL"'
SHA='"$SHA"'
BASE='"$1"'
. '"$WORK"'/common.sh
echo "Pulling pi package from $BASE ..."
dget "$BASE/pi-package.zip" '"$DOCS"'/pi-package.zip.part || { echo "download failed; is the app server reachable from the device (LISTEN_HOST=0.0.0.0)?"; exit 1; }
"$CURL" -fsSL -o '"$DOCS"'/pi-package.zip.sha256 "$BASE/pi-package.zip.sha256" || echo "(no sha256 sidecar; skipping verification)"
if [ -s '"$DOCS"'/pi-package.zip.sha256 ]; then
  WANT=$(cut -d" " -f1 '"$DOCS"'/pi-package.zip.sha256)
  GOT=$("$SHA" '"$DOCS"'/pi-package.zip.part | cut -d" " -f1)
  [ "$GOT" = "$WANT" ] || { echo "hash mismatch: $GOT != $WANT"; exit 1; }
  echo "sha256 verified."
fi
mv '"$DOCS"'/pi-package.zip.part '"$DOCS"'/pi-package.zip
echo "pi-package.zip ready."
'
}

do_pkginstall () {
  [ -f "$DOCS/pi-package.zip" ] || die "pi-package.zip missing (run Pull package first)"
  [ -f "$ROOT/install-package.py" ] || die "toolkit scripts missing (run Install scripts first)"
  say "Installing package tree (refuses to overwrite an existing one)..."
  py "$ROOT/install-package.py" || die "install-package.py failed"
}

do_scripts () {
  CURL=$(find_tool curl) || die "curl not found"
  TAR=$(find_tool tar) || die "tar not found"
  [ -d "$ROOT" ] || mkdir -p "$ROOT" || die "cannot create $ROOT"
  [ -d "$WORK" ] || mkdir -p "$WORK" || die "cannot create $WORK"
  start_job scripts '
. '"$WORK"'/common.sh
W='"$WORK"'
TAR='"$TAR"'
echo "Fetching bb10-classic-toolkit (latest main)..."
rm -rf "$W/tk" "$W/tk.tgz"
dget '"$TK_URL"' "$W/tk.tgz" || { echo "toolkit download failed"; exit 1; }
[ -s "$W/tk.tgz" ] || { echo "toolkit download failed"; exit 1; }
mkdir -p "$W/tk"
"$TAR" xzf "$W/tk.tgz" -C "$W/tk" --strip-components 1
SRC="$W/tk/pi-classic"
[ -f "$SRC/install-node.py" ] || { echo "toolkit tree incomplete"; exit 1; }
for f in compat.mjs curl-fetch.mjs entry.mjs pi-launch.sh classic-guard.js AGENTS-phone.md \
         install-node.py install-package.py install-entry.py install-settings.py configure.py; do
  cp "$SRC/$f" '"$ROOT"'/"$f"
done
echo "Toolkit adapter scripts installed into '"$ROOT"'."
'
}

do_nodeinst () {
  [ -f "$ROOT/install-node.py" ] || die "toolkit scripts missing (run Install scripts first)"
  [ -f "$DOCS/pi-node-term49.zip" ] || die "node zip missing (run Fetch pinned node zip first)"
  say "Installing the pinned private Node (refuses an existing install)..."
  py "$ROOT/install-node.py" || die "install-node.py failed"
}

do_selftest () {
  [ -x "$ROOT/node/bin/node.bin" ] || die "private node not installed (run Install node first)"
  say "Running node self-test (--jitless)..."
  LD_LIBRARY_PATH="$ROOT/node/bin:/base/lib:/base/usr/lib" \
    "$ROOT/node/bin/node.bin" --jitless -e 'console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,wasm:typeof WebAssembly,icu:process.versions.icu}))' \
    || die "node self-test failed"
}

do_settings () {
  [ -f "$ROOT/install-settings.py" ] || die "toolkit scripts missing (run Install scripts first)"
  [ -d "$SD" ] && [ -w "$SD" ] || die "Term49 home is not writable: $SD (start term49-web from Term49)"
  RC=0
  OUT=$( ( export HOME="$SD"; py "$ROOT/install-settings.py" ) 2>&1 ) || RC=$?
  if [ "$RC" != "0" ] && printf '%s\n' "$OUT" | grep -q "Existing extension"; then
    say "Guard extension already installed; keeping the existing one (upstream refuses blind replacement)."
    exit 0
  fi
  printf '%s\n' "$OUT"
  [ "$RC" = "0" ] || die "install-settings.py failed"
}

do_launcher () {
  [ -f "$ROOT/install-entry.py" ] || die "toolkit scripts missing (run Install scripts first)"
  py "$ROOT/install-entry.py" || die "install-entry.py failed"
}

do_configure () {
  [ -f "$ROOT/configure.py" ] || die "toolkit scripts missing (run Install scripts first)"
  [ -f "$SD/.berrycloud/config.json" ] || die "BerryCloud is not configured (~/.berrycloud/config.json missing)"
  [ -d "$SD" ] && [ -w "$SD" ] || die "Term49 home is not writable: $SD (start term49-web from Term49)"
  say "Copying BerryCloud GLM credentials into private Pi settings (on-device only)..."
  RC=0
  OUT=$( ( export HOME="$SD"; py "$ROOT/configure.py" ) 2>&1 ) || RC=$?
  if [ "$RC" != "0" ] && printf '%s\n' "$OUT" | grep -q "Existing Pi config"; then
    say "Pi is already configured; keeping the existing settings (upstream refuses blind replacement)."
    exit 0
  fi
  printf '%s\n' "$OUT"
  [ "$RC" = "0" ] || die "configure.py failed"
}

do_configure_manual () {
  [ -f "$PDIR/.cfg.b64" ] || die "no configuration upload found"
  [ -d "$SD" ] && [ -w "$SD" ] || die "Term49 home is not writable: $SD (start term49-web from Term49)"
  cat > "$WORK/gencfg.py" <<'PYEOF'
from __future__ import print_function
import os,json,sys,base64,re
home=os.environ.get('HOME') or os.path.expanduser('~')
root=home+'/.pi/agent'
cfg=json.loads(base64.b64decode(open(sys.argv[1],'rb').read()).decode('utf8'))
replace=len(sys.argv)>2 and sys.argv[2]=='replace'
from urllib.parse import urlparse
def compat():
 return {'supportsStore':False,'supportsDeveloperRole':False,'supportsUsageInStreaming':False,'maxTokensField':'max_tokens','thinkingFormat':'deepseek','supportsReasoningEffort':True,'supportsStrictMode':False,'requiresReasoningContentOnAssistantMessages':True}
def entries_for(models):
 out=[]
 for m in models:
  out.append({'id':m,'name':m+' (BB10)','reasoning':True,'input':['text'],'contextWindow':32000,'maxTokens':8192,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'compat':compat()})
 return out
providers_in=cfg.get('providers') or []
providers_out={}
order=[]
def pid_for(name,url):
 base=re.sub(r'[^a-z0-9-]+','-',(name or urlparse(url).netloc).lower()).strip('-') or 'provider'
 pid=base;i=2
 while pid in providers_out:
  pid=base+'-'+str(i);i+=1
 return pid
for p in providers_in:
 endpoint=str(p.get('endpoint','')).strip();key=str(p.get('api_key','')).strip();name=str(p.get('name','')).strip()
 models=[m.strip() for m in str(p.get('models','')).split(',') if m.strip()]
 assert endpoint.startswith('https://') and endpoint.endswith('/chat/completions'),'each provider needs an https://.../chat/completions endpoint ('+str(name or endpoint)+')'
 assert key and models,'each provider needs an api key and at least one model ('+str(name or endpoint)+')'
 pid=pid_for(name,endpoint)
 providers_out[pid]={'baseUrl':endpoint[:-len('/chat/completions')],'api':'openai-completions','apiKey':key,'models':entries_for(models)}
 order.append((pid,models[0]))
assert order,'at least one provider is required'
if not os.path.isdir(root):os.makedirs(root,0o700)
os.chmod(home+'/.pi',0o700);os.chmod(root,0o700)
def save(name,data):
 import time
 p=root+'/'+name
 if os.path.exists(p):
  if not replace:raise RuntimeError('Existing Pi config: '+name)
  os.rename(p,p+'.'+time.strftime('%Y%m%d-%H%M%S')+'.bak')
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(data,f,ensure_ascii=True,indent=2)
save('models.json',{'providers':providers_out})
save('settings.json',{'defaultProvider':order[0][0],'defaultModel':order[0][1],'defaultThinkingLevel':'low','hideThinkingBlock':True,'shellPath':'/accounts/1000/shared/misc/berrycore/bin/bash','retry':{'enabled':False,'provider':{'maxRetries':0,'timeoutMs':180000}},'images':{'blockImages':True},'quietStartup':True})
print(json.dumps({'configured':True,'providers':[{'provider':pid,'default':idx==0,'models':providers_out[pid]['models'] and [m['id'] for m in providers_out[pid]['models']]} for idx,(pid,first) in enumerate(order)],'private_config':root,'key_stored_on_device_only':True}))
PYEOF
  MODE=${1:-}
  RC=0
  OUT=$( ( export HOME="$SD"; py "$WORK/gencfg.py" "$PDIR/.cfg.b64" "$MODE" ) 2>&1 ) || RC=$?
  rm -f "$PDIR/.cfg.b64"
  if [ "$RC" != "0" ] && printf '%s
' "$OUT" | grep -q "Existing Pi config"; then
    say "Pi is already configured; keeping the existing settings (upstream refuses blind replacement)."
    exit 0
  fi
  printf '%s
' "$OUT"
  [ "$RC" = "0" ] || die "manual configuration failed"
}

do_cfgread () {
  F="$SD/.pi/agent/models.json"
  if [ ! -f "$F" ]; then
    say "CFG=none"
    exit 0
  fi
  B64=$(LD_LIBRARY_PATH=/base/lib:/base/usr/lib /base/usr/bin/python3.2 - "$F" <<'PYEOF'
import base64,sys,json
models=json.load(open(sys.argv[1]))
settings={}
try:settings=json.load(open(sys.argv[1].rsplit('/',1)[0]+'/settings.json'))
except Exception:pass
sys.stdout.write(base64.b64encode(json.dumps({'models':models,'settings':settings}).encode('utf8')).decode())
PYEOF
)
  say "CFG_B64=$B64"
}

do_log () {
  name=${1:-node}
  lines=${2:-40}
  case "$name" in
    node) F="$WORK/node.log" ;;
    nodezip) F="$WORK/nodezip.log" ;;
    pkgpull) F="$WORK/pkgpull.log" ;;
    scripts) F="$WORK/scripts.log" ;;
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
  node) do_node ;;
  nodezip) do_nodezip ;;
  pkgpull) do_pkgpull "${2:-}" ;;
  pkginstall) do_pkginstall ;;
  scripts) do_scripts ;;
  nodeinst) do_nodeinst ;;
  selftest) do_selftest ;;
  settings) do_settings ;;
  launcher) do_launcher ;;
  configure) do_configure ;;
  configure-manual) do_configure_manual "${2:-}" ;;
  cfg-read) do_cfgread ;;
  log) do_log "${2:-node}" "${3:-40}" ;;
  *)
    say "unknown action: ${1:-}"
    say "actions: status node nodezip nodeinst pkgpull pkginstall scripts selftest settings launcher configure configure-manual cfg-read log"
    exit 2
    ;;
esac
