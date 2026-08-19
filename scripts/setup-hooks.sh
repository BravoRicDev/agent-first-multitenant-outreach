#!/bin/bash
# Installa git-secrets e configura pre-commit hook
# Richiede: brew install git-secrets  oppure  sudo apt install git-secrets

set -e

if ! command -v git-secrets &> /dev/null; then
  echo "git-secrets non trovato. Installa con:"
  echo "  brew install git-secrets"
  echo "  oppure: sudo apt install git-secrets"
  echo "  oppure: git secrets --install (versione embedded)"
  exit 1
fi

git secrets --install 2>/dev/null || true
git secrets --register-aws 2>/dev/null || true
git secrets --add-pattern 'CHANGEME|IMPOSTA_QUI|sk-or-v1-|changeme_'

echo "✅ git-secrets configurato. I commit con placeholder o credenziali saranno bloccati."
