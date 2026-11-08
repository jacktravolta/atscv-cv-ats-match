#!/usr/bin/env bash
# scripts/publish-atscv-front.sh — publish the CV ATS MATCH front inside the API.
#
# The product ships in two places:
#   1. its own host (atscv.djlabs.cl) — the front server;
#   2. inside the API (public/atscv/) — the single-server deploy, the same
#      pattern as public/ley-datos/.
#
# The front is fully self-contained: its HTML references its assets with
# RELATIVE paths (js/..., css/..., img/...), so the copy works from any
# subdirectory without touching the API's shared public/js/ (which belongs
# to the ley-datos product — two products must not share that directory).
#
# Usage:
#   bash scripts/publish-atscv-front.sh            # publish + verify
#   bash scripts/publish-atscv-front.sh --dry-run  # show what would change
#
# Exit codes:
#   0 = published and verified
#   1 = verification failed
#   2 = usage error

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
SRC="${REPO}/atscv.djlabs.cl"
DEST="${ROOT}/public/atscv"
PORT="${VERIFY_PORT:-8098}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ ! -d "$SRC" ]; then
  echo "[error] no existe el front origen: $SRC" >&2
  exit 2
fi

if [ ! -f "$SRC/index.html" ] || [ ! -f "$SRC/app.html" ]; then
  echo "[error] el front origen no tiene index.html/app.html: $SRC" >&2
  exit 2
fi

# What does NOT travel to the published copy:
#   .htaccess            -> the API's public/.htaccess already rules the
#                           directory (DirectoryIndex + rewrite); a second
#                           one could fight it (and `Options` needs an
#                           AllowOverride the server may not grant).
#   *.zip                -> the requirements archive is not a web asset.
#   README/ADAPTATION_*  -> development notes, not part of the deploy.
EXCLUDES=(
  --exclude='.htaccess'
  --exclude='*.zip'
  --exclude='README.md'
  --exclude='ADAPTATION_SUMMARY.md'
  --exclude='.DS_Store'
  --exclude='node_modules'
)

echo "origen: $SRC"
echo "destino: $DEST"

if [ "$DRY_RUN" = "1" ]; then
  rsync -an "${EXCLUDES[@]}" "$SRC/" "$DEST/" | head -40
  echo "[dry-run] nada fue copiado."
  exit 0
fi

mkdir -p "$DEST"
rsync -a --delete "${EXCLUDES[@]}" "$SRC/" "$DEST/"

echo
echo "=== contenido publicado ==="
find "$DEST" -type f | wc -l | sed 's/^/  archivos: /'
du -sh "$DEST" | sed 's/^/  peso: /'

# ── verificación real: la copia se sirve como estáticos y responde 200 ──────
# La API en producción sirve public/ con Apache; en local el router sólo
# habla JSON, así que la copia se verifica con un servidor estático sobre el
# MIS public/ (que es lo que Apache hará en el deploy).
echo
echo "=== verificación (servidor estático sobre public/) ==="
php -S "127.0.0.1:${PORT}" -t "${ROOT}/public" >/tmp/opencode/atscv_publish_server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
sleep 1

FAIL=0
for path in /atscv/ /atscv/index.html /atscv/app.html /atscv/js/cv-ats.js /atscv/js/auth-refresh.js /atscv/cv-ats/ /atscv/css/tokens.css; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}${path}")
  if [ "$CODE" = "200" ]; then
    echo "  ✅ ${path} -> ${CODE}"
  else
    echo "  ❌ ${path} -> ${CODE}"
    FAIL=1
  fi
done

# El front publicado no puede quedar apuntando a un dominio inexistente.
if grep -rq "https://api\.djlabs\.cl" "${DEST}/api-config.js" 2>/dev/null; then
  echo "  ❌ api-config.js apunta a un dominio que no resuelve"
  FAIL=1
else
  echo "  ✅ api-config.js apunta al origen real (127.0.0.1)"
fi

if [ "$FAIL" != "0" ]; then
  echo
  echo "  ⚠ HAY FALLOS — revisar arriba"
  exit 1
fi

echo
echo "  ✅ front publicado y verificado en ${DEST}"
exit 0
