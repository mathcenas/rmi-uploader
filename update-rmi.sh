#!/bin/bash
# Script de actualizacion del sistema RMI
# Uso: ./update-rmi.sh [app] [email]
#   app   : gestion_prod | gestion_test | contabilidad_prod
#   email : destinatario del email de confirmacion (opcional, sobreescribe .env)
# Env vars opcionales:
#   DEPLOY_SRC : ruta exacta al directorio de upload (lo usa el admin panel)

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
    APP_DIR="/srv/gestion-rmi/prod"
    CONTAINER="gestion-rmi"
    CONTAINER_WORKDIR="/app"
    ;;
  gestion_test)
    APP_LABEL="Gestion RMI"
    APP_ENV="Testing"
    APP_DIR="/srv/gestion-rmi/testing"
    CONTAINER="gestion-rmi-testing"
    CONTAINER_WORKDIR="/app"
    ;;
  contabilidad_prod)
    APP_LABEL="Contabilidad RMI"
    APP_ENV="Produccion"
    APP_DIR="/srv/contabilidad-rmi/rmi-contabilidad"
    CONTAINER="contabilidad-rmi"
    CONTAINER_WORKDIR="/app"
    ;;
  *)
    echo "ERROR: app desconocida '$APP'. Usar: gestion_prod | gestion_test | contabilidad_prod"
    exit 1
    ;;
esac

echo "=== Actualizacion RMI — $APP_LABEL ($APP_ENV) ==="

# ── Resolver directorio fuente ────────────────────────────────────────────────
# DEPLOY_SRC puede venir del admin panel (apunta al upload exacto)
if [ -n "$DEPLOY_SRC" ]; then
  LATEST="$DEPLOY_SRC"
  echo "Fuente (admin): $LATEST"
else
  echo "Buscando archivos en: $UPLOAD_DIR"
  LATEST=$(ls -1d "$UPLOAD_DIR/${APP}_"* 2>/dev/null | sort | tail -1)
  if [ -z "$LATEST" ]; then
    echo "ERROR: No hay archivos subidos para '$APP' en $UPLOAD_DIR"
    echo "El cliente debe subir los archivos primero desde el uploader (puerto 8080)."
    exit 1
  fi
  echo "Directorio de upload (ultimo): $LATEST"
fi

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
  if [ -d "$item" ]; then
    # mezclar contenido en vez de anidar: si $APP_DIR/$name ya existe,
    # "cp -r item dest" crea dest/item en vez de fusionar
    mkdir -p "$APP_DIR/$name"
    cp -r "$item"/. "$APP_DIR/$name"/
  else
    cp -f "$item" "$APP_DIR/$name"
  fi
  COPIED_FILES="$COPIED_FILES $name"
  echo "Copiado: $name → $APP_DIR/"
done

# ── Reiniciar contenedor ──────────────────────────────────────────────────────
echo "Reiniciando contenedor $CONTAINER..."
docker restart "$CONTAINER" 2>&1 && RESTART_OK=true || RESTART_OK=false

# ── Validar que el contenedor esta sirviendo el server.js recien copiado ──────
if [ "$RESTART_OK" = "true" ] && [ -f "$APP_DIR/server.js" ]; then
  sleep 2
  HOST_HASH=$(md5sum "$APP_DIR/server.js" | awk '{print $1}')
  CONTAINER_HASH=$(docker exec "$CONTAINER" md5sum "$CONTAINER_WORKDIR/server.js" 2>/dev/null | awk '{print $1}')
  if [ -z "$CONTAINER_HASH" ]; then
    echo "Validacion: no se pudo leer server.js dentro del contenedor (revisar ruta $CONTAINER_WORKDIR/server.js)."
  elif [ "$HOST_HASH" = "$CONTAINER_HASH" ]; then
    echo "Validacion: OK — el contenedor esta sirviendo el server.js recien copiado ($HOST_HASH)."
  else
    echo "Validacion: ALERTA — el server.js del contenedor NO coincide con el del host (host=$HOST_HASH, contenedor=$CONTAINER_HASH). Puede que la imagen necesite --build en vez de restart."
  fi
fi

DEPLOY_DATE=$(date '+%Y-%m-%d %H:%M:%S')
echo ""
echo "==================================================="
echo "Deploy completado: $APP_LABEL ($APP_ENV)"
echo "Archivos:$COPIED_FILES"
echo "Backup: $BACKUP_DIR"
echo "Fecha: $DEPLOY_DATE"
echo "==================================================="
