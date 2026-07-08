#!/usr/bin/env bash
# Deploy NotFair CMO from GitHub Actions or manual run.
# Usage: ./deploy.sh [production|development] [branch]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

ENV="${1:-production}"
BRANCH="${2:-}"

case "$ENV" in
  production|prod)
    BRANCH="${BRANCH:-main}"
    SERVICE="web-prod"
    CONTAINER="notfair-cmo-prod"
    ENV_FILE=".env.production"
    ;;
  development|dev)
    echo "Dev env not configured yet"
    exit 1
    ;;
  *)
    echo "Usage: deploy.sh [production] [branch]"
    exit 1
    ;;
esac

echo "==> Deploy $ENV (branch: $BRANCH)"

git fetch origin
if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
  git pull origin "$BRANCH"
else
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"
  echo "NOTE: origin/$BRANCH not found — deploying local branch"
fi

echo "==> Building $SERVICE"
docker compose build "$SERVICE"

echo "==> Starting $SERVICE"
docker compose up -d "$SERVICE"

echo "==> Waiting for health"
sleep 10
docker compose ps "$SERVICE"
docker logs "$CONTAINER" --tail 30

echo "==> Deploy complete: $ENV"
