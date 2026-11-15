#!/usr/bin/env bash
# Builds the lens mod and installs it into the agent-lens game directory, replacing any older lens*.jar.
#   mod/install.sh            build + install
# Environment: JAVA_HOME (a JDK 25; else java from PATH), AGENT_LENS_CACHE (default
# ${XDG_CACHE_HOME:-~/.cache}/agent-lens).
# The build compiles against the client jar and libraries in the cache, so run "agent-lens mc install" once before.
set -euo pipefail
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
cache="${AGENT_LENS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-lens}"
mods="$cache/game/mods"

if [[ -z "${JAVA_HOME:-}" ]] && ! command -v java > /dev/null; then
  echo "install.sh: set JAVA_HOME to a JDK 25 (no java on PATH)" >&2
  exit 1
fi

cd "$here"
./gradlew --quiet --console=plain build
jar="$(ls -t build/libs/lens-*.jar | head -n 1)"
mkdir -p "$mods"
rm -f "$mods"/lens*.jar
cp "$jar" "$mods/"
echo "$mods/$(basename "$jar")"
