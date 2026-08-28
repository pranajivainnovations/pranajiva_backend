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


# ── Deploy record ─────────────────────────────────────────────────────────────
# Appends one entry to DEPLOYED.md every time this script finishes.
#
# Why this exists: "is that change live?" was being answered from memory, by both a human and an
# assistant reading the repo, and memory was wrong often enough to waste real time — a fix sat in
# the working tree through two production builds while everyone believed it had shipped, and
# separately, work that HAD shipped was repeatedly described as pending.
#
# The file answers it from evidence instead. The decisive field is `tree`: `clean` means the commit
# named beside it is exactly what shipped, so `git log <sha>..HEAD` lists everything since. `dirty`
# means uncommitted files were part of the build, so the commit alone does not identify the deploy —
# then the timestamp is what to compare against, and anything modified after it is unshipped.
#
# Append-only, newest entry LAST. `tail -12 DEPLOYED.md` shows the most recent deploy.
record_deploy() {
  local outcome="$1"
  local log="DEPLOYED.md"

  local sha branch tree
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo 'no-git')"
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then tree="dirty"; else tree="clean"; fi

  if [ ! -f "$log" ]; then
    {
      echo "# Deploy log — ${IMAGE_NAME}"
      echo
      echo "Written automatically by \`deploy.sh\`. Newest entry is at the **bottom**."
      echo
      echo "\`tree: clean\` means the commit beside it is exactly what shipped, so"
      echo "\`git log <sha>..HEAD\` lists everything not yet deployed."
      echo "\`tree: dirty\` means uncommitted files were built in, so compare file"
      echo "modification times against the deploy timestamp instead."
      echo
      echo "Do not edit by hand, and do not delete — it is the only record of what is live."
      echo
    } > "$log"
  fi

  {
    echo "---"
    # IST computed as a UTC offset, not via TZ=Asia/Kolkata: Git Bash on Windows ships no tzdata,
    # so the named zone silently resolves to GMT and stamps the wrong local time.
    echo "- when:    $(date -u '+%Y-%m-%d %H:%M:%S') UTC  /  $(date -u -d '+5 hours 30 minutes' '+%Y-%m-%d %H:%M') IST"
    echo "- outcome: ${outcome}"
    echo "- commit:  ${sha} (${branch})"
    echo "- tree:    ${tree}"
    echo "- image:   ${IMAGE_NAME}:latest"
    echo "- target:  ${REMOTE_HOST}:${REMOTE_DIR}"
    echo "- by:      $(git config user.name 2>/dev/null || echo "${USER:-unknown}")"
  } >> "$log"

  echo
  echo "Recorded in $(pwd)/${log}  —  ${outcome}, commit ${sha}, tree ${tree}"
  if [ "$tree" = "dirty" ]; then
    echo "  NOTE: uncommitted files were built into this image. Commit them so the next"
    echo "        deploy record identifies exactly what is live."
  fi
}


# Record every outcome, not just success: this must distinguish "deployed and failed" from
# "never ran". An EXIT trap catches the set -e aborts above as well as a clean finish.
trap 'rc=$?; record_deploy "$([ $rc -eq 0 ] && echo SUCCESS || echo "FAILED (exit $rc)")"' EXIT


# ── Build provenance ──────────────────────────────────────────────────────────────────────────
# Stamped into the image and served by the build endpoint, so OPS can report what is ACTUALLY
# running rather than what a log claims was deployed. Captured here, once, so the values echoed
# below and the values baked into the image cannot disagree.
BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then BUILD_TREE="dirty"; else BUILD_TREE="clean"; fi

TARBALL="${IMAGE_NAME}.tgz"

# ── Server disk hygiene ───────────────────────────────────────────────────────
# Repeated deploys fill the server, and the failure lands at the worst possible moment: the image
# tarball has already been uploaded and `docker load` is halfway through extracting it. On a script
# that stopped the container first, the service is then down with no image to start.
#
# Two causes, both invisible until they bite:
#
#   1. Every `docker load` of the same :latest tag untags the previous image rather than deleting
#      it. Twenty-one of these had accumulated on the storefront host over three weeks, one per
#      deploy, ~280MB each. Nothing ever collects them.
#   2. The uploaded .tgz is never removed. Five of them, back to May, were sitting in the deploy
#      directories on one host — 498MB doing nothing.
#
# Note the prune below is deliberately NOT `-a`. `docker image prune -a` removes every image not
# used by a *running* container, and these hosts run several services side by side: if any other
# service happened to be stopped at that moment, its image would be deleted too and it could not
# restart without a fresh upload. `-a` also throws away the previous image, which is the only
# rollback available when a new one turns out to be broken. Dangling-only removes exactly the
# garbage and nothing that anything could still want.
DEPLOY_KEY="${PEM_PATH:-${SSH_KEY:-}}"

# Refuse to start if the server cannot comfortably hold the incoming image. Checked BEFORE the
# upload and before anything is stopped, so a failure here costs nothing but a message.
preflight_disk() {
  local tarball_bytes free_kb need_kb
  tarball_bytes="$(wc -c < "$TARBALL" 2>/dev/null || echo 0)"
  # Three times the tarball: the compressed upload, the extracted layers, and headroom for the
  # previous image to stay in place until the new one is running.
  need_kb=$(( (tarball_bytes / 1024) * 3 ))

  free_kb="$(ssh -i "$DEPLOY_KEY" "$REMOTE_HOST" "df -Pk ${REMOTE_DIR} | tail -1 | awk '{print \$4}'" 2>/dev/null || echo 0)"

  if [ "$free_kb" -lt "$need_kb" ]; then
    echo "REFUSING TO DEPLOY: not enough disk on ${REMOTE_HOST}."
    echo "  free:   $(( free_kb / 1024 )) MB"
    echo "  needed: $(( need_kb / 1024 )) MB (3x the ${IMAGE_NAME} image)"
    echo
    echo "Reclaim space without touching any running service:"
    echo "  ssh -i ${DEPLOY_KEY} ${REMOTE_HOST} 'sudo docker image prune -f; sudo rm -f ${REMOTE_DIR}/*.tgz'"
    echo
    echo "Only if that is not enough, review what else is there before removing anything:"
    echo "  ssh -i ${DEPLOY_KEY} ${REMOTE_HOST} 'sudo docker images -a; sudo du -sh /home/ubuntu/*'"
    exit 1
  fi
  echo "    OK — $(( free_kb / 1024 )) MB free, need ~$(( need_kb / 1024 )) MB."
}

# Runs only after the new container is confirmed up, so the previous image survives until the
# replacement has actually started.
cleanup_server() {
  echo "==> Reclaiming server disk (dangling images + uploaded tarball)..."
  ssh -i "$DEPLOY_KEY" "$REMOTE_HOST" \
    "rm -f ${REMOTE_DIR}/${TARBALL}; sudo docker image prune -f 2>/dev/null || docker image prune -f" \
    | tail -3 || echo "    (cleanup skipped — non-fatal)"
}
SKIP_MIGRATIONS="${SKIP_MIGRATIONS:-0}"

if [ ! -f "$PEM_PATH" ]; then
  echo "PEM key not found at: $PEM_PATH"
  echo "Set DEPLOY_PEM_PATH=/full/path/to/key.pem before running, or edit PEM_PATH in deploy.sh."
  exit 1
fi

echo "==> [1/6] Building ${IMAGE_NAME}:latest (--no-cache)..."
docker build --no-cache \
  --build-arg "BUILD_COMMIT=${BUILD_COMMIT}" \
  --build-arg "BUILD_BRANCH=${BUILD_BRANCH}" \
  --build-arg "BUILD_TREE=${BUILD_TREE}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  -t "${IMAGE_NAME}:latest" .
echo "==> [2/6] Saving image to ${TARBALL}..."
docker save -o "$TARBALL" "${IMAGE_NAME}:latest"

echo "==> Checking the server has room for this image..."
preflight_disk

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

# Last, and only now: the container is confirmed running, so the image it replaced is safe to
# collect. Dangling-only - see the note on preflight_disk above for why -a is not used here.
cleanup_server
