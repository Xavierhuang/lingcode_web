#!/usr/bin/env bash
# SP1 acceptance gates — run on the VPC worker droplet (Docker + reachable Postgres
# + the API process with COMPUTE_RUNNER_ENABLED=1). Builds the base + the two gate
# images, declares the jobs via the REST API, uploads each image, triggers a run,
# and polls for the terminal status. Exits non-zero if either gate fails.
#
#   API_BASE   e.g. http://127.0.0.1:3000      (the LingCode admin API)
#   TOKEN      a backend-owner api_access_token (Authorization: Bearer)
#   BACKEND_ID the target backend id (be_<id> must already be provisioned)
#
# Usage: API_BASE=... TOKEN=... BACKEND_ID=... ./gates.sh
set -euo pipefail

: "${API_BASE:?set API_BASE}"; : "${TOKEN:?set TOKEN}"; : "${BACKEND_ID:?set BACKEND_ID}"
HERE="$(cd "$(dirname "$0")" && pwd)"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
BASE_URL="${API_BASE}/api/account/cloud-compute/${BACKEND_ID}"

echo "== building images =="
docker build -t lingcode/compute-node:20 "${HERE}/node-base"
docker build -t "lingcode-compute/${BACKEND_ID}:hello-world"  "${HERE}/examples/hello-world"
docker build -t "lingcode-compute/${BACKEND_ID}:db-5000-rows" "${HERE}/examples/db-5000-rows"

run_gate () {
  local name="$1" image_tag="$2" expect="$3"
  echo "== gate: ${name} =="
  # 1) declare the job (upsert by name)
  curl -fsS "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"name\":\"${name}\",\"image\":\"lingcode/compute-node:20\",\"timeout_sec\":120,\"memory_mb\":512}" \
    "${BASE_URL}/jobs" >/dev/null
  local job_id
  job_id="$(curl -fsS "${AUTH[@]}" "${BASE_URL}/jobs" | node -e "const j=JSON.parse(require('fs').readFileSync(0));process.stdout.write((j.data.find(x=>x.name==='${name}')||{}).id||'')")
  [ -n "${job_id}" ] || { echo "no job id"; exit 1; }
  # 2) upload the image tarball (runner docker-loads it → lingcode-compute/<be>:<name>)
  docker save "${image_tag}" | gzip | \
    curl -fsS "${AUTH[@]}" -H 'content-type: application/octet-stream' \
      --data-binary @- "${BASE_URL}/jobs/${job_id}/image" >/dev/null
  # 3) trigger a run
  local run_id
  run_id="$(curl -fsS "${AUTH[@]}" -H 'content-type: application/json' -d '{"input":{"gate":"'"${name}"'"}}' \
    "${BASE_URL}/jobs/${job_id}/run" | node -e "const j=JSON.parse(require('fs').readFileSync(0));process.stdout.write(j.data.run_id)")
  echo "run ${run_id} queued; polling…"
  # 4) poll
  for _ in $(seq 1 120); do
    local body status
    body="$(curl -fsS "${AUTH[@]}" "${BASE_URL}/runs/${run_id}")"
    status="$(node -e "const j=JSON.parse(require('fs').readFileSync(0));process.stdout.write(j.data.status)" <<<"${body}")"
    if [ "${status}" = "succeeded" ] || [ "${status}" = "failed" ] || [ "${status}" = "timed_out" ]; then
      echo "${body}" | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log('status='+j.data.status+' exit='+j.data.exit_code);console.log((j.data.logs||'').trim())"
      if [ "${status}" = "succeeded" ] && curl -fsS "${AUTH[@]}" "${BASE_URL}/runs/${run_id}" | grep -q "${expect}"; then
        echo "GATE ${name}: PASS"; return 0
      fi
      echo "GATE ${name}: FAIL"; return 1
    fi
    sleep 2
  done
  echo "GATE ${name}: TIMEOUT"; return 1
}

run_gate hello-world  "lingcode-compute/${BACKEND_ID}:hello-world"  GATE1_PASS
run_gate db-5000-rows "lingcode-compute/${BACKEND_ID}:db-5000-rows" GATE2_PASS
echo "== all gates passed =="
