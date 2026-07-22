#!/bin/bash
# Script de actualizacion del sistema RMI
# Se ejecuta manualmente en el host (fuera del contenedor del uploader).
# Uso: ./update-rmi.sh [app] [email]
#   app   : gestion_prod | gestion_test | contabilidad_prod
#   email : destinatario del email de confirmacion (opcional, sobreescribe .env)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Cargar .env ───────────────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

APP="${1:-gestion_prod}"
NOTIFY_EMAIL="${2:-$DEPLOY_NOTIFY_EMAIL}"
RESEND_API_KEY="${RESEND_API_KEY:-}"
RESEND_FROM="${RESEND_FROM:-RMI Deploy <noreply@cenas.com.uy>}"
UPLOAD_DIR="${UPLOAD_DIR:-/tmp/rmi}"

# ── Configuracion por app ─────────────────────────────────────────────────────
case "$APP" in
  gestion_prod)
    APP_LABEL="Gestion RMI"
    APP_ENV="Produccion"
    APP_DIR="/home/rmi/rmi/rmi-sistema/rmi-prod"
    CONTAINER="rmi-sistema"
    ;;
  gestion_test)
    APP_LABEL="Gestion RMI"
    APP_ENV="Testing"
    APP_DIR="/home/rmi/rmi/testing-rmi/rmi-test"
    CONTAINER="rmi-testing"
    ;;
  contabilidad_prod)
    APP_LABEL="Contabilidad RMI"
    APP_ENV="Produccion"
    APP_DIR="/srv/contabilidad-rmi/rmi-contabilidad"
    CONTAINER="rmi-contabilidad"
    ;;
  *)
    echo "ERROR: app desconocida '$APP'. Usar: gestion_prod | gestion_test | contabilidad_prod"
    exit 1
    ;;
esac

echo "=== Actualizacion RMI — $APP_LABEL ($APP_ENV) ==="

# ── Resolver directorio fuente ────────────────────────────────────────────────
echo "Buscando archivos en: $UPLOAD_DIR"
LATEST=$(ls -1d "$UPLOAD_DIR/${APP}_"* 2>/dev/null | sort | tail -1)
if [ -z "$LATEST" ]; then
  echo "ERROR: No hay archivos subidos para '$APP' en $UPLOAD_DIR"
  echo "El cliente debe subir los archivos primero desde el uploader (puerto 8080)."
  exit 1
fi
echo "Directorio de upload (ultimo): $LATEST"

if [ ! -d "$LATEST" ]; then
  echo "ERROR: Directorio no existe: $LATEST"
  exit 1
fi

echo "Fecha upload: $(date -r "$LATEST" '+%Y-%m-%d %H:%M:%S')"

# ── Backup del destino actual ─────────────────────────────────────────────────
BACKUP_TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$SCRIPT_DIR/backups/${APP}_$BACKUP_TS"
mkdir -p "$BACKUP_DIR"

if [ -d "$APP_DIR" ]; then
  cp -r "$APP_DIR/." "$BACKUP_DIR/" 2>/dev/null || true
  echo "Backup creado: $BACKUP_DIR"
fi

# ── Copiar archivos al destino ────────────────────────────────────────────────
mkdir -p "$APP_DIR"
COPIED_FILES=""

for item in "$LATEST"/*; do
  [ -e "$item" ] || continue
  name=$(basename "$item")
  cp -r "$item" "$APP_DIR/$name"
  COPIED_FILES="$COPIED_FILES $name"
  echo "Copiado: $name → $APP_DIR/"
done

# ── Reiniciar contenedor ──────────────────────────────────────────────────────
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
if [ -f "$COMPOSE_FILE" ]; then
  echo "Reiniciando contenedor $CONTAINER..."
  docker compose -f "$COMPOSE_FILE" restart "$CONTAINER" 2>&1 && RESTART_OK=true || RESTART_OK=false
else
  echo "AVISO: docker-compose.yml no encontrado en $SCRIPT_DIR, saltando restart."
  RESTART_OK=false
fi

DEPLOY_DATE=$(date '+%Y-%m-%d %H:%M:%S')
echo ""
echo "==================================================="
echo "Deploy completado: $APP_LABEL ($APP_ENV)"
echo "Archivos:$COPIED_FILES"
echo "Backup: $BACKUP_DIR"
echo "Fecha: $DEPLOY_DATE"
echo "==================================================="

# ── Notificacion Resend ───────────────────────────────────────────────────────
if [ -z "$RESEND_API_KEY" ]; then
  echo "Resend: sin API key, email omitido."
  exit 0
fi

if [ -z "$NOTIFY_EMAIL" ]; then
  echo "Resend: sin email de destino (DEPLOY_NOTIFY_EMAIL en .env o segundo argumento)."
  exit 0
fi

FILE_LIST=""
for f in $COPIED_FILES; do
  FILE_LIST="${FILE_LIST}<li style='margin:2px 0;'>$f</li>"
done

RESTART_TEXT="No aplicado (docker-compose.yml no encontrado)"
if [ "$RESTART_OK" = "true" ]; then
  RESTART_TEXT="OK — contenedor $CONTAINER reiniciado"
fi

JSON_BODY=$(cat <<EOF
{
  "from": "$RESEND_FROM",
  "to": ["$NOTIFY_EMAIL"],
  "subject": "[RMI] Deploy aplicado — $APP_LABEL ($APP_ENV)",
  "html": "<div style='font-family:sans-serif;max-width:480px;color:#1e293b'><h2 style='color:#16a34a;margin-bottom:8px'>RMI Deploy — OK</h2><p style='margin-bottom:16px'>El deploy fue aplicado correctamente en el servidor.</p><table style='width:100%;border-collapse:collapse;font-size:13px'><tr><td style='padding:6px 0;color:#64748b;width:120px'>Aplicacion</td><td><strong>$APP_LABEL</strong></td></tr><tr><td style='padding:6px 0;color:#64748b'>Ambiente</td><td><strong>$APP_ENV</strong></td></tr><tr><td style='padding:6px 0;color:#64748b'>Directorio</td><td><code style='font-size:12px'>$APP_DIR</code></td></tr><tr><td style='padding:6px 0;color:#64748b'>Fecha</td><td>$DEPLOY_DATE</td></tr><tr><td style='padding:6px 0;color:#64748b'>Archivos</td><td><ul style='margin:0;padding-left:16px'>$FILE_LIST</ul></td></tr><tr><td style='padding:6px 0;color:#64748b'>Backup</td><td><code style='font-size:12px'>$BACKUP_DIR</code></td></tr><tr><td style='padding:6px 0;color:#64748b'>Restart</td><td>$RESTART_TEXT</td></tr></table><p style='margin-top:20px;font-size:12px;color:#94a3b8'>Este mensaje fue generado automaticamente por RMI Deploy.</p></div>"
}
EOF
)

HTTP_STATUS=$(curl -s -o /tmp/resend_response.txt -w "%{http_code}" \
  -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$JSON_BODY")

RESPONSE=$(cat /tmp/resend_response.txt)

if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  echo "Resend: email enviado a $NOTIFY_EMAIL (HTTP $HTTP_STATUS)"
else
  echo "Resend: ERROR HTTP $HTTP_STATUS — $RESPONSE"
fi
