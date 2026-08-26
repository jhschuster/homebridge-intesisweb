#!/usr/bin/env bash

# MIT License
#
# Copyright 2026 Armando DiCianno

# Build, upload, and install this plugin package on a Synology Homebridge host.
# Review this script before running it: it restarts Homebridge on the remote host.

set -Eeuo pipefail

readonly SCRIPT_NAME="${0##*/}"
FOLLOW_LOGS=false

# Print command usage and deployment environment requirements.
usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [--logs]

Builds this package, uploads it, installs it on Synology, and restarts Homebridge.

Deployment configuration:
  Sources \${ENV_FILE:-<repository>/env.sh} automatically.
  HOMEBRIDGE_SYNOLOGY_HOST=<host name or address>
  HOMEBRIDGE_SYNOLOGY_SSH_USER=<SSH user>
  HOMEBRIDGE_SYNOLOGY_TEMP_DIR=<safe remote temporary directory>
  HOMEBRIDGE_SYNOLOGY_STORAGE_DIR=<Homebridge storage directory>

Options:
  --logs  Follow Homebridge logs after a successful restart (Ctrl-C to stop).
  --help  Show this help.
EOF
}

# Print a user-facing error and terminate immediately.
fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Report the failing line for commands covered by the ERR trap.
on_error() {
  local exit_code=$?
  printf 'ERROR: %s failed at line %s (exit %s).\n' "$SCRIPT_NAME" "$1" "$exit_code" >&2
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# Accept only simple SSH host names or addresses.
is_safe_host() {
  [[ $1 =~ ^[A-Za-z0-9.-]+$ && $1 != -* && $1 != *..* ]]
}

# Accept only non-option SSH account names.
is_safe_user() {
  [[ $1 =~ ^[A-Za-z0-9._-]+$ && $1 != -* ]]
}

# Require an absolute remote path without traversal or repeated separators.
is_safe_remote_path() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]*$ && $1 != *".."* && $1 != *//* ]]
}

# Reject storage roots broad enough to endanger unrelated Synology data.
is_safe_homebridge_dir() {
  is_safe_remote_path "$1" || return 1
  [[ $1 != / && $1 != /etc && $1 != /volume1 && $1 != "$HOMEBRIDGE_SYNOLOGY_TEMP_DIR" ]] || return 1
  [[ $1 =~ ^/[^/]+/[^/]+ ]]
}

# Limit privileged execution to known Synology Homebridge wrapper locations.
is_known_hb_service_path() {
  case $1 in
    /var/packages/homebridge/target/app/hb-service|/volume1/@appstore/homebridge/app/hb-service|/usr/local/bin/hb-service)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

while (($#)); do
  case $1 in
    --logs) FOLLOW_LOGS=true ;;
    --help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
cd -- "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-$REPO_ROOT/env.sh}"
[[ -r $ENV_FILE ]] || fail "Environment file is missing or unreadable: $ENV_FILE. Create it from the env.sh format in README.md."
# Deployment settings stay outside the package and are validated immediately
# after sourcing before any value reaches SSH or a remote shell.
# shellcheck disable=SC1090
source "$ENV_FILE"

for required_variable in \
  HOMEBRIDGE_SYNOLOGY_HOST \
  HOMEBRIDGE_SYNOLOGY_SSH_USER \
  HOMEBRIDGE_SYNOLOGY_TEMP_DIR \
  HOMEBRIDGE_SYNOLOGY_STORAGE_DIR; do
  [[ -n ${!required_variable:-} ]] || fail "Required deployment variable is missing from $ENV_FILE: $required_variable"
done

is_safe_host "$HOMEBRIDGE_SYNOLOGY_HOST" || fail 'HOMEBRIDGE_SYNOLOGY_HOST contains unsafe characters.'
is_safe_user "$HOMEBRIDGE_SYNOLOGY_SSH_USER" || fail 'HOMEBRIDGE_SYNOLOGY_SSH_USER contains unsafe characters.'
is_safe_remote_path "$HOMEBRIDGE_SYNOLOGY_TEMP_DIR" || fail 'HOMEBRIDGE_SYNOLOGY_TEMP_DIR must be a safe absolute path.'
is_safe_homebridge_dir "$HOMEBRIDGE_SYNOLOGY_STORAGE_DIR" || fail 'HOMEBRIDGE_SYNOLOGY_STORAGE_DIR is unsafe or too broad.'

if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

for command_name in node npm scp ssh; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ $NODE_MAJOR == 22 ]] || fail "Node.js 22 is required; found $(node --version)."

PACKAGE_INFO="$(node -e '
const packageJson = require("./package.json");
process.stdout.write(`${packageJson.name}\t${packageJson.version}`);
')"
IFS=$'\t' read -r PACKAGE_NAME PACKAGE_VERSION <<<"$PACKAGE_INFO"
[[ $PACKAGE_NAME =~ ^[A-Za-z0-9._-]+$ ]] || fail "Unsafe package name in package.json: $PACKAGE_NAME"
[[ $PACKAGE_VERSION =~ ^[A-Za-z0-9._-]+$ ]] || fail "Unsafe package version in package.json: $PACKAGE_VERSION"
PACKAGE_FILENAME="${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz"
LOCAL_PACKAGE="$REPO_ROOT/$PACKAGE_FILENAME"
REMOTE_PACKAGE="$HOMEBRIDGE_SYNOLOGY_TEMP_DIR/$PACKAGE_FILENAME"
REMOTE_DESTINATION="${HOMEBRIDGE_SYNOLOGY_SSH_USER}@${HOMEBRIDGE_SYNOLOGY_HOST}"

printf 'Locating hb-service on %s.\n' "$HOMEBRIDGE_SYNOLOGY_HOST"
# The remote probe and the local allowlist must agree before sudo executes a
# package-provided wrapper path.
HB_SERVICE_PATH="$(ssh -- "$REMOTE_DESTINATION" '
for candidate in /var/packages/homebridge/target/app/hb-service /volume1/@appstore/homebridge/app/hb-service /usr/local/bin/hb-service; do
  if [ -x "$candidate" ]; then
    printf "%s\n" "$candidate"
    exit 0
  fi
done
exit 1
')" || fail 'Could not locate an executable hb-service at a supported Synology path.'
is_known_hb_service_path "$HB_SERVICE_PATH" \
  || fail 'Remote preflight returned an unexpected hb-service path.'
HB_SERVICE_BIN_DIR="${HB_SERVICE_PATH%/*}"
HB_SERVICE_PATH_ENV="$HB_SERVICE_BIN_DIR:/usr/local/bin:/usr/syno/bin:/usr/syno/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
printf 'Using hb-service at %s.\n' "$HB_SERVICE_PATH"

# Retry the UI status probe while Synology finishes restarting the package.
check_homebridge_status() {
  local attempt
  local max_attempts=12

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if ssh -- "$REMOTE_DESTINATION" "sudo -- /usr/bin/env PATH=$HB_SERVICE_PATH_ENV $HB_SERVICE_PATH status"; then
      return 0
    fi
    if ((attempt < max_attempts)); then
      printf 'Homebridge is not ready yet; retrying in 5 seconds (%s/%s).\n' "$attempt" "$max_attempts"
      sleep 5
    fi
  done

  return 1
}

printf 'Using Node %s and package %s@%s.\n' "$(node --version)" "$PACKAGE_NAME" "$PACKAGE_VERSION"
printf 'Running tests...\n'
npm test

if [[ -e $LOCAL_PACKAGE ]]; then
  printf 'Removing existing package artifact: %s\n' "$LOCAL_PACKAGE"
  rm -- "$LOCAL_PACKAGE"
fi

printf 'Packing plugin...\n'
PACK_RESULT="$(npm pack --json)"
PACKED_FILENAME="$(node -e '
const result = JSON.parse(process.argv[1]);
if (!Array.isArray(result) || result.length !== 1 || typeof result[0].filename !== "string") process.exit(1);
process.stdout.write(result[0].filename);
' "$PACK_RESULT")" || fail 'Could not determine package filename from npm pack output.'
[[ $PACKED_FILENAME == "$PACKAGE_FILENAME" ]] || fail "npm pack produced unexpected artifact: $PACKED_FILENAME"
[[ -f $LOCAL_PACKAGE ]] || fail "Package artifact was not created: $LOCAL_PACKAGE"

EXPECTED_BUILD_INFO="$(node -e '
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const files = ["index.js", "package.json"];
// Recursively collect regular runtime JavaScript using POSIX relative paths.
function collectRuntimeJavaScript(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeJavaScript(absolutePath);
    }
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }
}
collectRuntimeJavaScript(path.join(root, "lib"));
files.sort();
const hash = crypto.createHash("sha256");
for (const file of files) {
  const content = fs.readFileSync(path.join(root, file));
  hash.update(Buffer.from(file + "\0" + content.length + "\0", "utf8"));
  hash.update(content);
}
process.stdout.write(String(files.length) + ":" + hash.digest("hex"));
')"
EXPECTED_RUNTIME_FILE_COUNT="${EXPECTED_BUILD_INFO%%:*}"
EXPECTED_BUILD_SHA256="${EXPECTED_BUILD_INFO#*:}"
# Both sides independently enumerate sorted index.js, package.json, and every
# regular lib/**/*.js file. Framed paths, lengths, and bytes make missing,
# extra, or stale same-version runtime modules fail verification.
[[ $EXPECTED_RUNTIME_FILE_COUNT =~ ^[1-9][0-9]*$ ]] || fail 'Could not calculate a safe runtime file count.'
[[ $EXPECTED_BUILD_SHA256 =~ ^[a-f0-9]{64}$ ]] || fail 'Could not calculate a safe build checksum.'

printf 'Uploading %s to %s:%s...\n' "$PACKAGE_FILENAME" "$REMOTE_DESTINATION" "$HOMEBRIDGE_SYNOLOGY_TEMP_DIR"
scp -O -- "$LOCAL_PACKAGE" "${REMOTE_DESTINATION}:${REMOTE_PACKAGE}"

printf 'Installing on %s and verifying the installed build...\n' "$HOMEBRIDGE_SYNOLOGY_HOST"
# hb-service shell supplies Synology's bundled Node/npm environment. The
# validated paths are expanded locally into this non-interactive heredoc.
ssh -- "$REMOTE_DESTINATION" "sudo -- /usr/bin/env PATH=$HB_SERVICE_PATH_ENV $HB_SERVICE_PATH shell" <<EOF
set -e
test -d $HOMEBRIDGE_SYNOLOGY_STORAGE_DIR
test -f $HOMEBRIDGE_SYNOLOGY_STORAGE_DIR/config.json
test -d $HOMEBRIDGE_SYNOLOGY_STORAGE_DIR/node_modules
cd -- $HOMEBRIDGE_SYNOLOGY_STORAGE_DIR
test "\$(pwd -P)" = "$HOMEBRIDGE_SYNOLOGY_STORAGE_DIR"
npm install --force -- $REMOTE_PACKAGE
installed_version=\$(node -p "require('./node_modules/$PACKAGE_NAME/package.json').version")
test "\$installed_version" = "$PACKAGE_VERSION"
installed_build_info=\$(node -e '
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const root = "node_modules/$PACKAGE_NAME";
const files = ["index.js", "package.json"];
// Recursively collect regular runtime JavaScript using POSIX relative paths.
function collectRuntimeJavaScript(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeJavaScript(absolutePath);
    }
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }
}
collectRuntimeJavaScript(path.join(root, "lib"));
files.sort();
const hash = crypto.createHash("sha256");
for (const file of files) {
  const content = fs.readFileSync(path.join(root, file));
  hash.update(Buffer.from(file + "\0" + content.length + "\0", "utf8"));
  hash.update(content);
}
process.stdout.write(String(files.length) + ":" + hash.digest("hex"));
')
installed_runtime_file_count=\${installed_build_info%%:*}
installed_build_sha256=\${installed_build_info#*:}
test "\$installed_runtime_file_count" = "$EXPECTED_RUNTIME_FILE_COUNT"
test "\$installed_build_sha256" = "$EXPECTED_BUILD_SHA256"
printf 'Installed $PACKAGE_NAME@%s (build %s, %s runtime files)\\n' "\$installed_version" "\$installed_build_sha256" "\$installed_runtime_file_count"
exit
EOF

printf 'Restarting Homebridge...\n'
ssh -- "$REMOTE_DESTINATION" "sudo -- /usr/bin/env PATH=$HB_SERVICE_PATH_ENV $HB_SERVICE_PATH restart"
printf 'Waiting for Homebridge to become ready...\n'
check_homebridge_status

if "$FOLLOW_LOGS"; then
  printf 'Following Homebridge logs; press Ctrl-C to stop.\n'
  trap - ERR
  logs_interrupted=false
  trap 'logs_interrupted=true' INT
  set +e
  ssh -- "$REMOTE_DESTINATION" "sudo -- /usr/bin/env PATH=$HB_SERVICE_PATH_ENV $HB_SERVICE_PATH logs"
  logs_exit=$?
  check_homebridge_status
  status_exit=$?
  set -e
  trap - INT
  if ((logs_exit != 0)); then
    if "$logs_interrupted"; then
      printf 'Log following interrupted; deployment completed successfully.\n' >&2
    else
      printf 'Log following stopped (exit %s); deployment completed successfully.\n' "$logs_exit" >&2
    fi
  fi
  if ((status_exit != 0)); then
    printf 'Homebridge status check after logs returned exit %s.\n' "$status_exit" >&2
    exit "$status_exit"
  fi
  # Installation and restart were verified before log streaming began.
  # Stream exit ends --logs; the post-stream status check decides final success.
  exit 0
else
  printf 'Done. To follow logs, run:\n'
  printf '  ssh %q %q\n' "$REMOTE_DESTINATION" "sudo -- /usr/bin/env PATH=$HB_SERVICE_PATH_ENV $HB_SERVICE_PATH logs"
  printf 'Or rerun this script with --logs.\n'
fi
