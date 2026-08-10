#!/usr/bin/env bash
# One-click deploy for the Medusa backend -> the pranajiva-backend production container.
# Same build -> save -> scp -> ssh -> load -> restart cycle as crossfriend-ops/deploy.sh, with two
# differences that matter and are the reason this is not a copy of that script:
#
#   1. This compose file defines TWO services — pranajiva-backend and pranajiva-storefront (the
#      Pranajiva customer site). A bare `docker compose down` would take the Pranajiva storefront
#      offline as a side effect of deploying the backend. Every compose command below therefore
#      names the backend service explicitly and passes --no-deps.
#
#   2. The container starts with `node dist/index.js` and does NOT run migrations. A deploy that
#      ships code expecting a table that does not exist yet fails at runtime, not at deploy time,
#      so migrations run here — before the new container starts.
#
# Run from anywhere; paths below resolve relative to this file, not the caller's cwd.
#
# Usage: ./deploy.sh                    (Git Bash, or double-click deploy.bat on Windows)
#        SKIP_MIGRATIONS=1 ./deploy.sh  (when migrations were already applied by hand)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# ── Configuration — edit these to match your setup ─────────────────────────────
IMAGE_NAME="pranajiva-backend"
SERVICE_NAME="pranajiva-backend"
PEM_PATH="${DEPLOY_PEM_PATH:-pranajivainnovationpem.pem}"   # override with: DEPLOY_PEM_PATH=/path/to/key.pem ./deploy.sh
REMOTE_HOST="ubuntu@13.62.195.167"
# The compose project lives in /home/ubuntu/pranajiva — NOT /home/ubuntu/pranajiva-backend.
# Confirmed from the running container's own label:
#   docker inspect pranajiva-backend --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
REMOTE_DIR="/home/ubuntu/pranajiva"
# ─────────────────────────────────────────────────────────────────────────────

TARBALL="${IMAGE_NAME}.tgz"
SKIP_MIGRATIONS="${SKIP_MIGRATIONS:-0}"

if [ ! -f "$PEM_PATH" ]; then
  echo "PEM key not found at: $PEM_PATH"
  echo "Set DEPLOY_PEM_PATH=/full/path/to/key.pem before running, or edit PEM_PATH in deploy.sh."
  exit 1
fi

echo "==> [1/6] Building ${IMAGE_NAME}:latest (--no-cache)..."
docker build --no-cache -t "${IMAGE_NAME}:latest" .

echo "==> [2/6] Saving image to ${TARBALL}..."
docker save -o "$TARBALL" "${IMAGE_NAME}:latest"

echo "==> [3/6] Uploading image to ${REMOTE_HOST}:${REMOTE_DIR}..."
# Verify the target BEFORE uploading, and never create it. An earlier version of this script ran
# `mkdir -p` and pointed at the wrong directory: it silently made an empty one, compose found no
# .env there, every ${VAR} resolved to "", and the migration step failed against a blank
# DATABASE_URL. Failing loudly here is the whole point — a missing directory means the config is
# wrong, not that a directory needs creating.
ssh -i "$PEM_PATH" "$REMOTE_HOST" "test -f ${REMOTE_DIR}/docker-compose.yml && test -f ${REMOTE_DIR}/.env" || {
  echo "ERROR: ${REMOTE_DIR} on ${REMOTE_HOST} is missing docker-compose.yml or .env."
  echo "That is where the live compose project runs. Find the real one with:"
  echo "  ssh -i ${PEM_PATH} ${REMOTE_HOST} \"docker inspect ${SERVICE_NAME} --format '{{index .Config.Labels \\\"com.docker.compose.project.working_dir\\\"}}'\""
  exit 1
}
# Only the image ships. The server's docker-compose.yml and .env are the source of truth for how
# this deployment is wired and are deliberately NOT overwritten from a developer machine — the local
# copy can legitimately differ, and clobbering the server's version breaks a running production
# service in a way that is invisible until it restarts. When compose genuinely needs a new variable,
# edit the server copy once, by hand, and add the variable to its .env in the same sitting.
scp -i "$PEM_PATH" "$TARBALL" "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> [4/6] Loading image on the server..."
ssh -i "$PEM_PATH" "$REMOTE_HOST" "cd ${REMOTE_DIR} && docker load -i ${TARBALL}"

if [ "$SKIP_MIGRATIONS" = "1" ]; then
  echo "==> [5/6] Skipping migrations (SKIP_MIGRATIONS=1)."
else
  echo "==> [5/6] Running migrations with the NEW image, before it starts serving..."
  # `run --rm --no-deps` uses the freshly loaded image in a throwaway container: migrations are
  # applied by the version of the code that needs them, and nothing is left running afterwards.
  # Medusa records applied migrations, so re-running is a no-op — safe when they were already
  # applied by hand from a developer machine, which is the normal case here.
  ssh -i "$PEM_PATH" "$REMOTE_HOST" \
    "cd ${REMOTE_DIR} && docker compose run --rm --no-deps ${SERVICE_NAME} npx medusa migrations run"
fi

echo "==> [6/6] Restarting ${SERVICE_NAME} only (Pranajiva storefront is left alone)..."
ssh -i "$PEM_PATH" "$REMOTE_HOST" \
  "cd ${REMOTE_DIR} && docker compose up -d --no-deps --force-recreate ${SERVICE_NAME}"

echo "==> Container status:"
ssh -i "$PEM_PATH" "$REMOTE_HOST" "cd ${REMOTE_DIR} && docker compose ps"

# A deploy that ends in "Done" while the container is crash-looping is worse than one that fails
# loudly — you go and do something else. Poll the store API until it answers.
echo "==> Verifying the backend is actually answering..."
HEALTH_OK=0
for attempt in $(seq 1 20); do
  if ssh -i "$PEM_PATH" "$REMOTE_HOST" \
      "curl -fsS -o /dev/null --max-time 5 http://localhost:\${PORT:-9001}/store/crossfriend/taxonomy" 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  sleep 3
done

echo
if [ "$HEALTH_OK" = "1" ]; then
  echo "Deployed ${IMAGE_NAME}:latest to ${REMOTE_HOST} — backend is responding."
else
  echo "WARNING: image deployed, but the backend did not answer within 60s."
  echo "Check the logs:"
  echo "  ssh -i ${PEM_PATH} ${REMOTE_HOST} 'cd ${REMOTE_DIR} && docker compose logs --tail=80 ${SERVICE_NAME}'"
  exit 1
fi
