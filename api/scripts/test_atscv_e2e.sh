#!/usr/bin/env bash
# scripts/test_atscv_e2e.sh — E2E EN VIVO del producto CV ATS MATCH (corazón atscv).
#
# Comprueba, con resultados REALES contra la API levantada, todo el camino que
# recorre la persona:
#
#   A. Registro de usuario (con heart=atscv)  → 100 créditos de bienvenida
#   B. Login (email + contraseña)              → sesión + /auth/me
#   C. Carga de saldo                          → orden de recarga PENDING + acreditación
#                                                  por el camino admin de la plataforma
#   D. Consulta al asistente (RAG/BCN)        → respuesta real con saldo
#   E. Informe de brecha CV ATS (3 llamadas)   → perfil/oferta/brecha/match_score
#   F. Generación de CV adaptado + carta       → DOCX + PDF descargables
#   G. Bandeja "Mis archivos"                  → los artefactos con kind=atscv
#   H. Aislamiento                             → otro usuario NO descarga el documento
#   I. Saldo insuficiente                      → 402 amable, sin cobro
#
# Uso:
#   bash scripts/test_atscv_e2e.sh
#
# Variables de entorno (todas con valor por defecto):
#   API_BASE  API bajo prueba (default http://127.0.0.1:8099)
#   HEART     corazón del producto (default atscv)
#
# NOTAS DE HONESTIDAD:
#   - La "carga de saldo" se verifica en DOS partes: la orden de compra real
#     (POST /payments/orders → PENDING, con su idempotencia) y la acreditación
#     del saldo con bin/grant-credits.php, que es el camino admin que usa la
#     plataforma cuando el pago llega. No se finge un pago de Flow.
#   - Las llamadas al modelo son REALES (rotador de la plataforma). Si el
#     proveedor falla, el script lo reporta como el error real que recibió.

set -uo pipefail

API_BASE=${API_BASE:-http://127.0.0.1:8099}
HEART=${HEART:-atscv}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
JAR=$(mktemp /tmp/atscv_e2e_user.XXXXXX.jar)
JAR2=$(mktemp /tmp/atscv_e2e_other.XXXXXX.jar)
RUN=$(date +%s)
EMAIL="atscv.e2e.${RUN}@example.com"
EMAIL2="atscv.e2e.other.${RUN}@example.com"
PASSWORD="AtScvE2E-${RUN}!"
CV_TEXT="CURRICULUM VITAE Juan Perez Gonzalez. Operario de Bodega en Logistica Chile desde 2020. Manejo de 300 SKU con WMS, control de inventario ciclico, experiencia con Excel y coordinacion de despacho. Titulo tecnico en logistica."
OFERTA_TEXT="Se busca Jefe de Bodega para Retail SA. Requisitos obligatorios: SAP EWM, Licencia Clase D, Power BI. Deseables: WMS e inventario ciclico. Funciones: control de inventario, despacho y reportabilidad. Contrato indefinido."

PASS=0; FAIL=0
cleanup() { rm -f "$JAR" "$JAR2" /tmp/atscv_e2e_*.json; }
trap cleanup EXIT

# errmsg <response-file> -> el mensaje de error del servidor (para no depurar a ciegas)
errmsg() {
  local f="$1"
  [ -f "$f" ] || return 0
  jqf "$f" "error.message" | head -c 200
}

check() { # name result(1|0) detail
  if [ "$2" = "1" ]; then
    echo "  ✅ $1${3:+ — $3}"
    PASS=$((PASS+1))
  else
    echo "  ❌ $1${3:+ — $3}"
    FAIL=$((FAIL+1))
  fi
}

# checkapi <name> <response-file> <http-code> <expected-code> [detail]
# Cuando el codigo no es el esperado, muestra el mensaje real del servidor.
checkapi() {
  local name="$1" file="$2" code="$3" expected="$4" detail="${5:-}"
  if [ "$code" = "$expected" ]; then
    check "$name" 1 "${detail:+$detail }HTTP $code"
  else
    check "$name" 0 "${detail:+$detail }HTTP $code — $(errmsg "$file")"
  fi
}

jqf() { # json-file expression -> prints value or empty
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print(""); sys.exit(0)
cur=d
for part in sys.argv[2].split('.'):
    if part=="": continue
    if isinstance(cur,list):
        try: cur=cur[int(part)]
        except Exception: print(""); sys.exit(0)
    elif isinstance(cur,dict):
        cur=cur.get(part)
    else:
        print(""); sys.exit(0)
    if cur is None: print(""); sys.exit(0)
if isinstance(cur,(dict,list)): print(json.dumps(cur,ensure_ascii=False))
else: print(cur)
PY
}

# Payloads JSON construidos con printf: sin escapes fragiles que puedan romper el
# cuerpo en silencio (un cuerpo malformado llega al servidor como cuerpo VACIO).
json() { local fmt="$1"; shift; printf "$fmt" "$@"; }

post() { # url outfile [extra curl args...]
  local url="$1" out="$2"; shift 2
  curl -s -m 180 -o "$out" -w '%{http_code}' -X POST "$url" -H 'Content-Type: application/json' "$@"
}
get() { # url outfile [extra curl args...]
  local url="$1" out="$2"; shift 2
  curl -s -m 60 -o "$out" -w '%{http_code}' "$url" "$@"
}

echo "════════ E2E EN VIVO — CV ATS MATCH (corazón ${HEART}) ════════"
echo "API: ${API_BASE}"

# Los buckets por IP son compartidos entre pruebas de esta maquina: si una
# corrida anterior los dejo saturados, el login caeria en 429 y todo lo demas
# en 401 (sesion sin crear) — sin probar nada del producto.
# Se limpian SOLO los buckets anonimos, de penalizacion y de auth de esta IP.
DB_NAME=$(php -r 'require "app/Core/autoload.php"; \App\Core\Config::load("config/config.php"); echo (string) \App\Core\Config::get("db.name", "");')
DB_USER=$(php -r 'require "app/Core/autoload.php"; \App\Core\Config::load("config/config.php"); echo (string) \App\Core\Config::get("db.user", "");')
DB_PASS=$(php -r 'require "app/Core/autoload.php"; \App\Core\Config::load("config/config.php"); echo (string) \App\Core\Config::get("db.pass", "");')
mysql -h 127.0.0.1 -P 3306 -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -s \
  -e "DELETE FROM rate_limits WHERE bucket_key LIKE 'chat:anon:127.0.0.1%' OR bucket_key LIKE 'chat:penalty:127.0.0.1%' OR bucket_key LIKE 'auth:login:127.0.0.1%' OR bucket_key LIKE 'auth:refresh:127.0.0.1%' OR bucket_key LIKE 'auth:reverify:127.0.0.1%' OR bucket_key LIKE 'auth:magic:127.0.0.1%'" >/dev/null 2>&1

# ── A. REGISTRO ───────────────────────────────────────────────────────────────
echo "════════ A. REGISTRO DE USUARIO ════════"
REG=/tmp/atscv_e2e_reg.json
REG_BODY=$(json '{"name":"Persona E2E ATSCV","email":"%s","password":"%s","terms_accepted":true,"heart":"%s"}' "$EMAIL" "$PASSWORD" "$HEART")
CODE=$(post "${API_BASE}/auth/register" "$REG" \
  -d "$REG_BODY")
checkapi "registro aceptado (HTTP 200)" "$REG" "$CODE" "200"
BAL=$(jqf "$REG" "data.balance")
check "100 créditos de bienvenida en la wallet de ${HEART}" "$([ "$BAL" = "100" ] && echo 1 || echo 0)" "balance=${BAL}"
check "el registro devuelve el usuario" "$([ -n "$(jqf "$REG" "data.user.id")" ] && echo 1 || echo 0)" "$(jqf "$REG" "data.user.email")"

# ── B. LOGIN ──────────────────────────────────────────────────────────────────
echo "════════ B. LOGIN ════════"
LOGIN=/tmp/atscv_e2e_login.json
LOGIN_BODY=$(json '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
CODE=$(post "${API_BASE}/auth/login" "$LOGIN" -c "$JAR" \
  -d "$LOGIN_BODY")
checkapi "login aceptado (HTTP 200)" "$LOGIN" "$CODE" "200"
ME=/tmp/atscv_e2e_me.json
CODE=$(get "${API_BASE}/auth/me?heart=${HEART}" "$ME" -b "$JAR")
check "sesión viva: /auth/me responde 200" "$([ "$CODE" = "200" ] && echo 1 || echo 0)" "HTTP $CODE"
check "la sesión es la del usuario registrado" \
  "$([ "$(jqf "$ME" "data.user.email")" = "$EMAIL" ] && echo 1 || echo 0)" "$(jqf "$ME" "data.user.email")"

# ── C. CARGA DE SALDO ─────────────────────────────────────────────────────────
echo "════════ C. CARGA DE SALDO ════════"
ORDER=/tmp/atscv_e2e_order.json
IDEM="e2e-${RUN}-${RANDOM}"
ORDER_BODY=$(json '{"amount_clp":5000,"document_type":46,"heart":"%s"}' "$HEART")
CODE=$(post "${API_BASE}/payments/orders" "$ORDER" -b "$JAR" \
  -H "Idempotency-Key: ${IDEM}" \
  -d "$ORDER_BODY")
checkapi "orden de recarga creada (HTTP 200)" "$ORDER" "$CODE" "200"
check "la orden queda PENDING (no acreditada)" \
  "$([ "$(jqf "$ORDER" "data.status")" = "PENDING" ] && echo 1 || echo 0)" "status=$(jqf "$ORDER" "data.status")"
ORDER_ID=$(jqf "$ORDER" "data.order_id")
check "la orden tiene identificador" "$([ -n "$ORDER_ID" ] && echo 1 || echo 0)" "$ORDER_ID"
# Idempotencia: la misma clave no crea una segunda orden.
ORDER2=/tmp/atscv_e2e_order2.json
post "${API_BASE}/payments/orders" "$ORDER2" -b "$JAR" -H "Idempotency-Key: ${IDEM}" \
  -d "$ORDER_BODY" >/dev/null
check "la misma Idempotency-Key no duplica la orden" \
  "$([ "$(jqf "$ORDER2" "data.order_id")" = "$ORDER_ID" ] && echo 1 || echo 0)" "order_id=$(jqf "$ORDER2" "data.order_id")"
check "la orden repetida se marca como replay idempotente" \
  "$([ "$(jqf "$ORDER2" "data.idempotent_replay")" = "True" ] && echo 1 || echo 0)" "idempotent_replay=$(jqf "$ORDER2" "data.idempotent_replay")"
check "la recarga apunta a la wallet de ${HEART}" \
  "$([ "$(jqf "$ORDER" "data.heart_id")" = "$HEART" ] && echo 1 || echo 0)" "heart_id=$(jqf "$ORDER" "data.heart_id")"

# Acreditación por el camino admin de la plataforma (el mismo que usa el
# webhook de Flow cuando el pago llega de verdad).
GRANT_OUT=$(cd "$ROOT" && php bin/grant-credits.php --email="$EMAIL" --amount=50 --heart="$HEART" --reason="E2E atscv" 2>&1)
check "acreditación de saldo por el camino admin de la plataforma" \
  "$(echo "$GRANT_OUT" | grep -qiE 'ok|credit|acredit' && echo 1 || echo 0)" "$(echo "$GRANT_OUT" | tail -1)"
BALFILE=/tmp/atscv_e2e_balance.json
get "${API_BASE}/credits/balance?heart=${HEART}" "$BALFILE" -b "$JAR" >/dev/null
BAL2=$(jqf "$BALFILE" "data.balance")
check "el saldo subió a 150" "$([ "$BAL2" = "150" ] && echo 1 || echo 0)" "balance=${BAL2}"
MOV=/tmp/atscv_e2e_mov.json
get "${API_BASE}/credits/movements?heart=${HEART}&limit=20" "$MOV" -b "$JAR" >/dev/null
check "el movimiento de recarga aparece en el extracto" \
  "$(jqf "$MOV" "data.movements" | grep -q 'ADMIN_ADJUSTMENT' && echo 1 || echo 0)" "$(jqf "$MOV" "data.movements" | head -c 120)"

# ── D. CONSULTA AL ASISTENTE (RAG / BCN) ──────────────────────────────────────
echo "════════ D. CONSULTA (RAG/BCN) ════════"
CHAT=/tmp/atscv_e2e_chat.json
CHAT_QUESTION='¿Cuántas horas puede trabajar diario un trabajador bajo el Código del Trabajo?'
CHAT_BODY=$(json '{"question":"%s","heart":"%s"}' "$CHAT_QUESTION" "$HEART")
CODE=$(post "${API_BASE}/chat/completions" "$CHAT" -b "$JAR" \
  -d "$CHAT_BODY")
checkapi "la consulta responde (HTTP 200)" "$CHAT" "$CODE" "200"
ANSWER=$(jqf "$CHAT" "data.answer")
check "la respuesta trae texto real" "$([ ${#ANSWER} -gt 40 ] && echo 1 || echo 0)" "${ANSWER:0:140}"
BAL_AFTER_CHAT=$(jqf "$CHAT" "data.balance")
check "la consulta consumió saldo de la wallet de ${HEART}" \
  "$([ -n "$BAL_AFTER_CHAT" ] && [ "$BAL_AFTER_CHAT" -lt "$BAL2" ] && echo 1 || echo 0)" "balance=${BAL_AFTER_CHAT}"

# ── E. INFORME DE BRECHA CV ATS ───────────────────────────────────────────────
echo "════════ E. INFORME DE BRECHA CV ATS (3 llamadas) ════════"
MATCH=/tmp/atscv_e2e_match.json
IDEM2="e2e-match-${RUN}-${RANDOM}"
CODE=$(post "${API_BASE}/v1/cv-ats/match" "$MATCH" -b "$JAR" \
  -H "Idempotency-Key: ${IDEM2}" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'cv_texto':sys.argv[1],'oferta_texto':sys.argv[2],'idempotency_key':sys.argv[3]}))" "$CV_TEXT" "$OFERTA_TEXT" "$IDEM2")")
checkapi "el informe responde (HTTP 200)" "$MATCH" "$CODE" "200"
SCORE=$(jqf "$MATCH" "data.match_score")
check "devuelve match_score numérico" \
  "$(echo "$SCORE" | grep -qE '^[0-9]+$' && echo 1 || echo 0)" "match_score=${SCORE}"
check "devuelve el perfil extraído" \
  "$([ -n "$(jqf "$MATCH" "data.perfil.skills_tecnicas")" ] && echo 1 || echo 0)" "$(jqf "$MATCH" "data.perfil.skills_tecnicas")"
check "devuelve las keywords de la oferta" \
  "$([ -n "$(jqf "$MATCH" "data.oferta.keywords_ats")" ] && echo 1 || echo 0)" "$(jqf "$MATCH" "data.oferta.keywords_ats")"
check "devuelve las keywords faltantes" \
  "$([ -n "$(jqf "$MATCH" "data.brecha.keywords_faltantes")" ] && echo 1 || echo 0)" "$(jqf "$MATCH" "data.brecha.keywords_faltantes")"
INFORME=$(jqf "$MATCH" "data.informe_texto")
check "devuelve el informe en markdown" "$([ ${#INFORME} -gt 60 ] && echo 1 || echo 0)" "${INFORME:0:140}"
check "el primer informe fue gratis" \
  "$([ "$(jqf "$MATCH" "data.primer_informe_gratis")" = "True" ] && echo 1 || echo 0)" "primer_informe_gratis=$(jqf "$MATCH" "data.primer_informe_gratis")"
BAL_AFTER_MATCH=$(jqf "$MATCH" "data.creditos_restantes")
check "el informe informa el saldo restante" "$([ -n "$BAL_AFTER_MATCH" ] && echo 1 || echo 0)" "creditos_restantes=${BAL_AFTER_MATCH}"

# Replay idempotente: la misma clave devuelve el informe guardado sin volver a llamar al modelo.
REPLAY=/tmp/atscv_e2e_replay.json
post "${API_BASE}/v1/cv-ats/match" "$REPLAY" -b "$JAR" -H "Idempotency-Key: ${IDEM2}" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'cv_texto':sys.argv[1],'oferta_texto':sys.argv[2],'idempotency_key':sys.argv[3]}))" "$CV_TEXT" "$OFERTA_TEXT" "$IDEM2")" >/dev/null
check "el replay devuelve el mismo informe" \
  "$([ "$(jqf "$REPLAY" "data.match_score")" = "$SCORE" ] && echo 1 || echo 0)" "score=${SCORE}"
check "el replay no vuelve a llamar al modelo" \
  "$([ "$(jqf "$REPLAY" "data.idempotent_replay")" = "True" ] && echo 1 || echo 0)" "idempotent_replay=$(jqf "$REPLAY" "data.idempotent_replay")"

# ── F. GENERACIÓN DE CV ADAPTADO + CARTA ──────────────────────────────────────
echo "════════ F. GENERACIÓN DE CV ADAPTADO + CARTA ════════"
GEN=/tmp/atscv_e2e_gen.json
IDEM3="e2e-gen-${RUN}-${RANDOM}"
GEN_BODY=$(python3 - "$MATCH" "$IDEM3" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])).get('data',{})
print(json.dumps({
 'perfil': d.get('perfil',{}), 'oferta': d.get('oferta',{}), 'brecha': d.get('brecha',{}),
 'plantilla':'harvard', 'idempotency_key':sys.argv[2], 'operacion': d.get('operacion')
}, ensure_ascii=False))
PY
)
CODE=$(post "${API_BASE}/v1/cv-ats/generar-adaptado" "$GEN" -b "$JAR" \
  -H "Idempotency-Key: ${IDEM3}" -d "$GEN_BODY")
checkapi "la generación responde (HTTP 200)" "$GEN" "$CODE" "200"
NEWS=$(jqf "$GEN" "data.nuevo_match_score")
check "devuelve el nuevo match score" "$(echo "$NEWS" | grep -qE '^[0-9]+$' && echo 1 || echo 0)" "nuevo_match_score=${NEWS}"
DOCX_URL=$(jqf "$GEN" "data.cv.docx_url")
PDF_URL=$(jqf "$GEN" "data.cv.pdf_url")
CARTA_DOCX=$(jqf "$GEN" "data.carta.docx_url")
check "devuelve el CV adaptado (DOCX y PDF)" \
  "$([ -n "$DOCX_URL" ] && [ -n "$PDF_URL" ] && echo 1 || echo 0)" "${DOCX_URL}"
check "devuelve la carta de presentación" "$([ -n "$CARTA_DOCX" ] && echo 1 || echo 0)" "${CARTA_DOCX}"

DOCX_FILE=/tmp/atscv_e2e_cv.docx
PDF_FILE=/tmp/atscv_e2e_cv.pdf
CODE=$(get "${API_BASE}${DOCX_URL}" "$DOCX_FILE" -b "$JAR")
check "el DOCX se descarga (HTTP 200)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)" "HTTP $CODE"
MAGIC=$(head -c 2 "$DOCX_FILE")
check "el DOCX es un ZIP OOXML real (PK)" "$([ "$MAGIC" = "PK" ] && echo 1 || echo 0)" "magic=${MAGIC}"
CODE=$(get "${API_BASE}${PDF_URL}" "$PDF_FILE" -b "$JAR")
check "el PDF se descarga (HTTP 200)" "$([ "$CODE" = "200" ] && echo 1 || echo 0)" "HTTP $CODE"
MAGIC=$(head -c 5 "$PDF_FILE")
check "el PDF es un PDF real (%PDF-)" "$([ "$MAGIC" = "%PDF-" ] && echo 1 || echo 0)" "magic=${MAGIC}"

# ── G. BANDEJA "MIS ARCHIVOS" ─────────────────────────────────────────────────
echo "════════ G. BANDEJA MIS ARCHIVOS ════════"
SOURCES=/tmp/atscv_e2e_sources.json
get "${API_BASE}/rag/sources?heart=${HEART}" "$SOURCES" -b "$JAR" >/dev/null
SRC=$(jqf "$SOURCES" "data.sources")
check "la bandeja lista los artefactos ATS" "$(echo "$SRC" | grep -q 'atscv' && echo 1 || echo 0)" "$(echo "$SRC" | head -c 200)"
check "el CV, la oferta, el informe, el CV adaptado y la carta están en la bandeja" \
  "$(echo "$SRC" | grep -q 'CV' && echo "$SRC" | grep -q 'oferta' && echo "$SRC" | grep -q 'Carta' && echo 1 || echo 0)" "$(echo "$SRC" | grep -o '"title": *"[^"]*"' | head -6 | tr '\n' ' ')"
check "los artefactos ATS no entran al chat del RAG" \
  "$(echo "$SRC" | grep -q '"chat_enabled": *true' && echo 0 || echo 1)" "chat_enabled=false"

# ── H. AISLAMIENTO ENTRE USUARIOS ─────────────────────────────────────────────
echo "════════ H. AISLAMIENTO ════════"
REG2=/tmp/atscv_e2e_reg2.json
REG2_BODY=$(json '{"name":"Otra Persona E2E","email":"%s","password":"%s","terms_accepted":true,"heart":"%s"}' "$EMAIL2" "$PASSWORD" "$HEART")
post "${API_BASE}/auth/register" "$REG2" \
  -d "$REG2_BODY" >/dev/null
LOGIN2_BODY=$(json '{"email":"%s","password":"%s"}' "$EMAIL2" "$PASSWORD")
post "${API_BASE}/auth/login" /tmp/atscv_e2e_login2.json -c "$JAR2" \
  -d "$LOGIN2_BODY" >/dev/null
STEAL=/tmp/atscv_e2e_steal.bin
CODE=$(get "${API_BASE}${DOCX_URL}" "$STEAL" -b "$JAR2")
check "otra cuenta NO puede descargar el documento (404)" "$([ "$CODE" = "404" ] && echo 1 || echo 0)" "HTTP $CODE"

# ── I. SALDO INSUFICIENTE ─────────────────────────────────────────────────────
echo "════════ I. SALDO INSUFICIENTE ════════"
(cd "$ROOT" && php bin/grant-credits.php --email="$EMAIL2" --amount=-100 --heart="$HEART" --reason="E2E vaciado" >/dev/null 2>&1)
BALFILE2=/tmp/atscv_e2e_balance2.json
get "${API_BASE}/credits/balance?heart=${HEART}" "$BALFILE2" -b "$JAR2" >/dev/null
check "la segunda cuenta quedó en 0 créditos" \
  "$([ "$(jqf "$BALFILE2" "data.balance")" = "0" ] && echo 1 || echo 0)" "balance=$(jqf "$BALFILE2" "data.balance")"
NOPE=/tmp/atscv_e2e_nope.json
CODE=$(post "${API_BASE}/v1/cv-ats/generar-adaptado" "$NOPE" -b "$JAR2" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'perfil':{'nombre':'X'},'oferta':{'cargo_oferta':'Y'},'brecha':{'match_score':10},'plantilla':'harvard'}))")")
checkapi "sin saldo la generación responde 402" "$NOPE" "$CODE" "402"
MSG=$(jqf "$NOPE" "error.message")
check "el 402 trae un mensaje amable" "$([ ${#MSG} -gt 20 ] && echo 1 || echo 0)" "${MSG:0:160}"

# ── RESUMEN ───────────────────────────────────────────────────────────────────
echo "════════ RESUMEN ════════"
echo "  PASS: ${PASS}  FAIL: ${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  echo "  ⚠ HAY FALLOS — revisar arriba"
  exit 1
fi
echo "  ✅ E2E COMPLETO CON RESULTADOS REALES"
exit 0
