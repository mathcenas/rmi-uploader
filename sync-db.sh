#!/bin/bash
# Sincroniza la base de datos SQLite de prod a testing para una app.
# Accion manual, a demanda — no se ejecuta nunca como parte de un deploy normal
# (update-rmi.sh no la toca). Pensado para correr en el host, con sudo.
#
# Uso: sudo ./sync-db.sh gestion
#      sudo ./sync-db.sh contabilidad

set -e

APP="$1"

case "$APP" in
  gestion)
    PROD_DATA="/srv/gestion-rmi/prod/data"
    TEST_DATA="/srv/gestion-rmi/testing/data"
    PROD_CONTAINER="gestion-rmi"
    TEST_CONTAINER="gestion-rmi-testing"
    ;;
  contabilidad)
    PROD_DATA="/srv/contabilidad-rmi/prod/data"
    TEST_DATA="/srv/contabilidad-rmi/testing/data"
    PROD_CONTAINER="contabilidad-rmi"
    TEST_CONTAINER="contabilidad-rmi-testing"
    ;;
  *)
    echo "Uso: $0 gestion|contabilidad"
    exit 1
    ;;
esac

if [ ! -d "$PROD_DATA" ]; then
  echo "ERROR: no existe $PROD_DATA"
  exit 1
fi
mkdir -p "$TEST_DATA"

DB_FILE=$(find "$PROD_DATA" -maxdepth 1 -name '*.db' ! -name '*-shm' ! -name '*-wal' | head -1)
if [ -z "$DB_FILE" ]; then
  echo "ERROR: no encontre ningun .db en $PROD_DATA"
  exit 1
fi
DB_NAME=$(basename "$DB_FILE")

echo "=== Sincronizar DB de prod a testing — $APP ($DB_NAME) ==="

# ── Intentar checkpoint en caliente (sin downtime) ────────────────────────────
CHECKPOINT_OK=false
if docker exec "$PROD_CONTAINER" sh -c "command -v sqlite3" >/dev/null 2>&1; then
  CONTAINER_DB_PATH=$(docker exec "$PROD_CONTAINER" sh -c "find / -maxdepth 4 -name '$DB_NAME' 2>/dev/null | head -1")
  if [ -n "$CONTAINER_DB_PATH" ]; then
    echo "Haciendo checkpoint del WAL en caliente (sin detener $PROD_CONTAINER)..."
    docker exec "$PROD_CONTAINER" sqlite3 "$CONTAINER_DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"
    CHECKPOINT_OK=true
  else
    echo "AVISO: sqlite3 esta pero no encontre $DB_NAME dentro de $PROD_CONTAINER."
  fi
else
  echo "AVISO: sqlite3 no esta disponible dentro de $PROD_CONTAINER."
fi

if [ "$CHECKPOINT_OK" = "false" ]; then
  echo "Sin checkpoint en caliente — detengo $PROD_CONTAINER brevemente para copiar sin riesgo de corrupcion."
  docker stop "$PROD_CONTAINER"
fi

# ── Backup de lo que habia en testing, por si acaso ───────────────────────────
BACKUP_DIR="$TEST_DATA/backup_$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
for f in "$PROD_DATA"/*.db "$PROD_DATA"/*.db-shm "$PROD_DATA"/*.db-wal; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  [ -f "$TEST_DATA/$name" ] && cp "$TEST_DATA/$name" "$BACKUP_DIR/"
done
echo "Backup de testing (previo a sobreescribir): $BACKUP_DIR"

# ── Copiar ─────────────────────────────────────────────────────────────────────
for f in "$PROD_DATA"/*.db "$PROD_DATA"/*.db-shm "$PROD_DATA"/*.db-wal; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  cp "$f" "$TEST_DATA/$name"
  echo "Copiado: $name"
done

if [ "$CHECKPOINT_OK" = "false" ]; then
  echo "Reiniciando $PROD_CONTAINER..."
  docker start "$PROD_CONTAINER"
fi

echo "Reiniciando $TEST_CONTAINER..."
docker restart "$TEST_CONTAINER"

echo ""
echo "=== Listo. $TEST_CONTAINER ahora tiene el DB de $PROD_CONTAINER. ==="
