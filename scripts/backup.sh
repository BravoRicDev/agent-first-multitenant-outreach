#!/bin/sh
set -e
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/backups
FILENAME="outreach_${TIMESTAMP}.sql.gz"

: "${DB_HOST:?DB_HOST non impostato}"
: "${DB_USER:?DB_USER non impostato}"
: "${DB_NAME:?DB_NAME non impostato}"
: "${DB_PASSWORD:?DB_PASSWORD non impostato}"

mkdir -p "$BACKUP_DIR"

export PGPASSWORD="${DB_PASSWORD}"
pg_dump -h "$DB_HOST" -U "$DB_USER" "$DB_NAME" | gzip > "${BACKUP_DIR}/${FILENAME}"
unset PGPASSWORD

# Retain only last 30 days
find "$BACKUP_DIR" -name "outreach_*.sql.gz" -mtime +"${RETENTION_DAYS:-30}" -delete
