#!/bin/sh
# Blockbase Claude Code plugin: SessionStart hook.
# Ensures the blockbase CLI is available and tells Claude when setup is pending.
# Plain stdout is added to Claude's context. This script must never fail the session.

VERSION="__PLUGIN_VERSION__"
SPEC="${BLOCKBASE_CLI_SPEC:-@blockbase/cli@$VERSION}"
ROOT="${CLAUDE_PLUGIN_ROOT:-}"
DATA="${CLAUDE_PLUGIN_DATA:-}"
HOME_DIR="${BLOCKBASE_HOME:-${HOME:-}/.blocks}"
PORT=47821

# Find a blockbase on PATH that does not live inside this plugin.
find_external() {
  _old_ifs=$IFS
  IFS=:
  for _dir in $PATH; do
    [ -n "$_dir" ] || continue
    [ -x "$_dir/blockbase" ] || continue
    if [ -n "$ROOT" ]; then
      case "$_dir/" in "$ROOT"/*) continue ;; esac
    fi
    IFS=$_old_ifs
    printf '%s\n' "$_dir/blockbase"
    return 0
  done
  IFS=$_old_ifs
  return 1
}

install_failed() {
  printf '%s\n' "Blockbase plugin: could not install the blockbase CLI ($1). Tell the user to run \`npm install -g @blockbase/cli@$VERSION\` in a terminal, then restart Claude Code."
  exit 0
}

# `blockbase --help` exits 2 (the usage code) by design; 0 is fine too. Anything else means it did not run.
cli_runs() {
  "$1" --help >/dev/null 2>&1
  _rc=$?
  [ "$_rc" -eq 0 ] || [ "$_rc" -eq 2 ]
}

CLI_OK=0
if _ext=$(find_external) && cli_runs "$_ext"; then
  CLI_OK=1
elif [ -z "$DATA" ]; then
  install_failed "no plugin data directory"
else
  ENTRY="$DATA/cli/node_modules/@blockbase/cli/dist/index.js"
  STAMP="$DATA/cli/.installed-spec"
  if [ -f "$ENTRY" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SPEC" ]; then
    CLI_OK=1
  else
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || install_failed "node 24+ and npm are required"
    NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
    case "$NODE_MAJOR" in ''|*[!0-9]*) install_failed "cannot determine the node version" ;; esac
    [ "$NODE_MAJOR" -ge 24 ] || install_failed "node 24 or newer is required, found $NODE_MAJOR"
    mkdir -p "$DATA/cli" 2>/dev/null || install_failed "cannot create $DATA/cli"
    # One installer at a time: two sessions starting together must not run npm into the same prefix.
    # The lock holds the owner's pid so a lock left by a killed hook (timeout) is reclaimed.
    LOCK="$DATA/cli/.install-lock"
    _waited=0
    until mkdir "$LOCK" 2>/dev/null; do
      _owner=$(cat "$LOCK/pid" 2>/dev/null)
      _stale=0
      if [ -n "$_owner" ]; then
        kill -0 "$_owner" 2>/dev/null || _stale=1
      elif [ "$_waited" -ge 5 ]; then
        _stale=1
      fi
      if [ "$_stale" = 1 ]; then
        rm -rf "$LOCK" 2>/dev/null
        _waited=0
        continue
      fi
      [ "$_waited" -ge 240 ] && install_failed "another Claude Code session is still installing it"
      sleep 1
      _waited=$((_waited + 1))
    done
    printf '%s\n' "$$" >"$LOCK/pid" 2>/dev/null
    trap 'rm -rf "$LOCK" 2>/dev/null' EXIT
    trap 'rm -rf "$LOCK" 2>/dev/null; exit 0' HUP INT TERM
    if [ -f "$ENTRY" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SPEC" ]; then
      CLI_OK=1 # another session finished the install while this one waited
    else
      rm -f "$STAMP" 2>/dev/null
      # $SPEC is deliberately unquoted: BLOCKBASE_CLI_SPEC may hold several space-separated specs.
      # shellcheck disable=SC2086
      if npm install --prefix "$DATA/cli" --no-audit --no-fund --loglevel=error $SPEC >&2 && [ -f "$ENTRY" ]; then
        printf '%s\n' "$SPEC" >"$STAMP" 2>/dev/null
        CLI_OK=1
      else
        install_failed "npm install failed"
      fi
    fi
    rm -rf "$LOCK" 2>/dev/null
    trap - EXIT HUP INT TERM
  fi
  if [ "$CLI_OK" = 1 ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    # Single-quoted so a data path containing spaces, quotes or $ survives `source`.
    _quoted=$(printf '%s' "$ENTRY" | sed "s/'/'\\\\''/g")
    printf "export BLOCKBASE_CLI_ENTRY='%s'\n" "$_quoted" >>"$CLAUDE_ENV_FILE" 2>/dev/null
  fi
fi

[ "$CLI_OK" = 1 ] || exit 0

CATALOG=0
[ -f "$HOME_DIR/index.sqlite" ] && CATALOG=1
PAGE=0
HEALTH_URL="http://127.0.0.1:$PORT/api/health"
if command -v curl >/dev/null 2>&1; then
  HEALTH=$(curl -fsS --max-time 1 "$HEALTH_URL" 2>/dev/null)
elif command -v node >/dev/null 2>&1; then
  # Minimal Linux images often lack curl; node 24 has fetch.
  HEALTH=$(node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(1000)}).then(r=>r.ok?r.text():"").then(t=>process.stdout.write(t),()=>{})' "$HEALTH_URL" 2>/dev/null)
else
  HEALTH=
fi
case "$HEALTH" in *catalogRoot*) PAGE=1 ;; esac

if [ "$CATALOG" = 0 ]; then
  printf '%s\n' "Blockbase plugin: the catalog is not set up yet. On the user's first Blockbase request, offer to run \`blockbase setup --json\` (creates ~/.blocks and a login service for the catalog page at http://127.0.0.1:$PORT/#home) and run it only after they agree."
elif [ "$PAGE" = 0 ]; then
  printf '%s\n' "Blockbase plugin: the catalog page is not running on http://127.0.0.1:$PORT/. On the user's first Blockbase request, offer to run \`blockbase setup --json\` (installs the login service for the page) and run it only after they agree."
fi
exit 0
