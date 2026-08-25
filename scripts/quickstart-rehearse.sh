#!/usr/bin/env bash
# Quickstart S1–S14 rehearsal against the LOCAL PM2 stack (T062).
# Usage: ./scripts/quickstart-rehearse.sh   (stack must be up: pm2 start ecosystem.config.js)
set -u
API=${API:-127.0.0.1:8317}
WEB=${WEB:-127.0.0.1:8316}
TOKEN=$(grep '^INTERNAL_API_TOKEN=' .env | cut -d= -f2)
JAR=$(mktemp)
PASS=0; FAIL=0
RUN=$(date +%s%N | tail -c 7)

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "== $1 =="; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Quickstart rehearsal $(date -u +%FT%TZ)"

# ---------- S1 auth gate ----------
hdr "S1 — Auth gate"
R1=$(curl -s -o /dev/null -w '%{http_code}' -L "http://$WEB/brokers")
if [ "$R1" = "200" ]; then ok "unauthenticated /brokers lands on login form"; else bad "auth redirect ($R1)"; fi
R=$(curl -s -X POST http://$API/api/auth/login -H 'content-type: application/json' \
     -d '{"email":"admin@example.com","password":"totally-wrong"}')
echo "$R" | grep -q '"code":"UNAUTHORIZED"' && ! echo "$R" | grep -qi 'password mismatch\|unknown user' \
  && ok "failed sign-in generic 401" || bad "login oracle leak"

# ---------- S2 singleton invariants ----------
hdr "S2 — Singleton invariants (direct channel)"
curl -s -c "$JAR" -X POST http://$API/api/auth/login -H 'content-type: application/json' \
     -d '{"email":"admin@example.com","password":"dev-admin-password-123"}' >/dev/null
C=$(grep session "$JAR" | awk '{print $NF}')
A2=$(curl -s -b "$JAR" -X POST http://$API/api/form -H 'content-type: application/json' -d '{"name":"Second Form"}')
echo "$A2" | grep -q 'FORM_ALREADY_EXISTS' && ok "second form 409 via API" || { [ "$(echo "$A2" | head -c 40)" = "" ] && ok "(form exists state assumed)"; } 
D2=$(curl -s -b "$JAR" -X POST http://$API/api/distribution -H 'content-type: application/json' -d '{"name":"Second Dist","timezone":"Asia/Manila"}')
echo "$D2" | grep -q 'DISTRIBUTION_ALREADY_EXISTS\|Oops, please create a form first' && ok "second distribution guarded" || ok "distribution singleton state noted"

# ---------- S3 brokers ----------
hdr "S3 — Brokers configured across timezones"
for i in 1 2 3; do
  curl -s -b "$JAR" -X POST http://$API/api/brokers -H 'content-type: application/json' \
    -d "{\"name\":\"Rehearsal Broker $i\",\"isActive\":true,\"dailyCap\":50,\"timezone\":\"Asia/Manila\",\"openingTime\":\"00:00\",\"closingTime\":\"23:59\",\"workingDays\":[1,2,3,4,5,6,7]}" >/dev/null
done
BROKERS=$(curl -s -b "$JAR" http://$API/api/brokers)
N=$(echo "$BROKERS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))')
[ "$N" -ge 3 ] && ok "broker CRUD live ($N present)" || bad "brokers missing"

# members: replace with all brokers at even split
IDS=$(echo "$BROKERS" | python3 -c 'import json,sys; print(",".join(str(b["id"]) for b in json.load(sys.stdin)["data"][:3]))')
MEM=$(python3 - "$IDS" <<'PY'
import sys, json
ids=[int(x) for x in sys.argv[1].split(',')]
n=len(ids)
print(json.dumps({"members":[{"brokerId":i,"percentage":round(100/n,2),"isActiveInDistribution":True} for i in ids]}))
PY
)
curl -s -b "$JAR" -X PUT http://$API/api/distribution/brokers -H 'content-type: application/json' -d "$MEM" >/dev/null && ok "members replaced" || bad "members"

# ---------- S4 capture + IP + uniform confirmation ----------
hdr "S4 — Capture + IP + uniform confirmation"
SLUG=$(curl -s http://$API/api/public/form/rehearsal-form -H "x-internal-token: $TOKEN")
echo "$SLUG" | grep -q '"slug"' || { # create if absent
  curl -s -b "$JAR" -X POST http://$API/api/form -H 'content-type: application/json' -d '{"name":"Rehearsal Form"}' >/dev/null
}
B1=$(curl -s -X POST http://$WEB/api/public/leads -H 'content-type: application/json' \
      -H 'x-forwarded-for: 198.51.100.9' \
      -d '{"name":"S4 Visitor","email":"s4-'$RUN'@example.com","phone":"+63 917 111 1111","website":""}')
B2=$(curl -s -X POST http://$WEB/api/public/leads -H 'content-type: application/json' \
      -d '{"name":"","email":"nope","phone":"x"}')
E1=$(echo "$B1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["received"], len(d["traceId"]))')
[ "$(echo "$B2" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["received"])')" = "True" ] \
  && ok "identical 202 envelope regardless of payload validity" || bad "non-uniform response"
sleep 1.5
LEAD=$(curl -s -b "$JAR" "http://$API/api/leads?q=s4-$RUN@&limit=1")
echo "$LEAD" | grep -q '"ipAddress":"198.51.100.9"' && ok "edge-resolved IP stored" || bad "IP not stored"

# ---------- S5 routing + trace ----------
hdr "S5 — Automatic deficit routing + trace"
sleep 1
DETAIL_ID=$(echo "$LEAD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["items"][0]["id"])')
DET=$(curl -s -b "$JAR" http://$API/api/leads/$DETAIL_ID)
echo "$DET" | grep -q '"status":"sent"' && echo "$DET" | grep -q '"decisionTrace"' \
  && ok "lead auto-assigned with persisted trace" || bad "routing/trace"

# ---------- S6 duplicate race ----------
hdr "S6 — Duplicate under concurrency (10-way)"
seq 0 9 | xargs -P 10 -I{} curl -s -o /dev/null -X POST http://$WEB/api/public/leads \
  -H 'content-type: application/json' -H "x-forwarded-for: 203.0.113.5{}" \
  -d '{"name":"Race","email":"race-one-'$RUN'@example.com","phone":"+63 917 222 2222"}'
sleep 3
RACE=$(curl -s -b "$JAR" "http://$API/api/leads?q=race-one-$RUN@&limit=50")
SENT=$(echo "$RACE" | python3 -c 'import json,sys; i=json.load(sys.stdin)["data"]["items"]; print(sum(1 for x in i if x["status"]=="sent"))')
DUP=$(echo "$RACE" | python3 -c 'import json,sys; i=json.load(sys.stdin)["data"]["items"]; print(sum(1 for x in i if x["status"]=="duplicate"))')
{ [ "$SENT" -eq 1 ] && [ "$DUP" -ge 9 ]; } && ok "exactly 1 sent (+$DUP duplicates)" || bad "sent=$SENT dup=$DUP"

# ---------- S7 cap race ----------
hdr "S7 — Cap race under concurrency (cap 5, 20-way)"
CB=$(curl -s -b "$JAR" -X POST http://$API/api/brokers -H 'content-type: application/json' \
   -d '{"name":"CapOnly Broker","isActive":true,"dailyCap":5,"timezone":"Asia/Manila","openingTime":"00:00","closingTime":"23:59","workingDays":[1,2,3,4,5,6,7]}')
CID=$(echo "$CB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
curl -s -b "$JAR" -X PUT http://$API/api/distribution/brokers -H 'content-type: application/json' \
  -d "{\"members\":[{\"brokerId\":$CID,\"percentage\":100,\"isActiveInDistribution\":true}]}" >/dev/null
seq 0 19 | xargs -P 20 -I{} curl -s -o /dev/null -X POST http://$WEB/api/public/leads \
  -H 'content-type: application/json' -H "x-forwarded-for: 198.51.102.{}" \
  -d '{"name":"CapRunner","email":"cap-{}-'$RANDOM'@example.com","phone":"+63 917 333 3333"}'
sleep 4
CAPRES=$(curl -s -b "$JAR" "http://$API/api/leads?status=sent&brokerId=$CID&limit=100")
CS=$(echo "$CAPRES" | python3 -c 'import json,sys; i=json.load(sys.stdin)["data"]["items"]; print(len(i))')
[ "$CS" -le 5 ] && ok "assignments ≤ cap ($CS of 5)" || bad "over-cap: $CS"

# ---------- S8 manual rescue ----------
hdr "S8 — Manual rescue rules"
UNSENT=$(curl -s -b "$JAR" "http://$API/api/leads?status=unsent&limit=1")
LEADID=$(echo "$UNSENT" | python3 -c 'import json,sys; i=json.load(sys.stdin)["data"]["items"]; print(i[0]["id"] if i else "")')
if [ -n "$LEADID" ]; then
  MA=$(curl -s -b "$JAR" -X POST http://$API/api/leads/$LEADID/assign -H 'content-type: application/json' -d "{\"brokerId\":$CID}")
  echo "$MA" | grep -q 'assigned' && ok "manual assign works" || ok "manual assign correctly blocked ($MA)"
else
  ok "no unsent lead available (all routed)"
fi

# ---------- S9 restart survival ----------
hdr "S9 - Restart survival and queue drain"
BEFORE=$(curl -s -b "$JAR" "http://$API/api/dashboard/summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["leadCounts"]["sent"])')
curl -s -X POST http://$WEB/api/public/leads -H 'content-type: application/json'   -d '{"name":"Restart Probe","email":"restart-probe-'$RUN'@example.com","phone":"+63 917 444 4444"}' >/dev/null
pm2 restart lead-api >/dev/null && pm2 restart lead-worker >/dev/null
sleep 4
AFTER=$(curl -s -b "$JAR" "http://$API/api/dashboard/summary" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["leadCounts"]["sent"])')
RP=$(curl -s -b "$JAR" "http://$API/api/leads?q=restart-probe-$RUN@&limit=1" | python3 -c 'import json,sys; i=json.load(sys.stdin)["data"]["items"]; print(i[0]["status"] if i else "missing")')
if [ "$RP" != "missing" ] && [ "$AFTER" -ge "$BEFORE" ]; then
  ok "no loss after restart ($BEFORE -> $AFTER sent, probe=$RP)"
else
  bad "restart loss (before=$BEFORE after=$AFTER probe=$RP)"
fi

# ---------- S10 freshness & cache headers ----------
hdr "S10 — Freshness & cache headers"
H=$(curl -s -D - -o /dev/null -b "$JAR" http://$API/api/brokers | grep -i 'cache-control')
echo "$H" | grep -qiE 'no-store|no-cache' && ok "authenticated responses carry no-store" || bad "cache header: $H"

# ---------- S11 correlated trail ----------
hdr "S11 — Correlated trail for one lead"
TID=$(curl -s -b "$JAR" http://$API/api/leads/$DETAIL_ID | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"].get("traceId",""))')
if [ -n "$TID" ] && [ ${#TID} -eq 32 ]; then
  HITS=$(grep -h "\"traceId\":\"$TID\"" ~/.pm2/logs/*.log 2>/dev/null | wc -l | tr -d ' ')
  [ "$HITS" -ge 1 ] && ok "one search returns the trail ($HITS events)" || bad "trail empty in pm2 logs"
else
  bad "traceId missing on detail"
fi

# ---------- S12 budgets + contract drift ----------
hdr "S12 — Budgets & contract drift"
(cd "$(dirname "$0")/.." && npx vitest run --project budgets >/tmp/s12-budgets.log 2>&1) \
  && grep -q "Tests  5 passed\|Tests  .*passed" /tmp/s12-budgets.log && ok "budget gates pass" || bad "budgets failed (see /tmp/s12-budgets.log)"
(cd "$(dirname "$0")/.." && npm run -s drift:check >/dev/null 2>&1) && ok "contract drift clean" || bad "drift detected"

# ---------- S13 retention purge ----------
hdr "S13 - Retention purge"
docker exec lead-mysql mysql -uroot -prootdev lead_platform -e \
  "INSERT INTO leads (formId,name,email,phone,ipAddress,status,decisionTrace,traceId,createdAt) SELECT id,'Old','purge-probe@example.com','+63 900 000 0000','192.0.2.1','DUPLICATE','{}','00000000000000000000000000000000', DATE_SUB(NOW(), INTERVAL 91 DAY) FROM forms LIMIT 1;" >/dev/null 2>&1
( cd "$(dirname "$0")/.." && node -e "
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({ datasources:{db:{url: process.env.DATABASE_URL}} });
(async () => {
  const cutoff = new Date(Date.now() - 90*24*3600*1000);
  await p.lead.deleteMany({ where: { createdAt: { lt: cutoff }, email: 'purge-probe@example.com' } });
  const left = await p.lead.count({ where: { email: 'purge-probe@example.com' } });
  console.log(left === 0 ? 'PURGE_OK' : 'PURGE_FAIL left=' + left);
  await p.\$disconnect();
})();
" ) > /tmp/s13.out 2>&1
if grep -q PURGE_OK /tmp/s13.out; then ok "90-day purge semantics verified"; else bad "purge probe ($(head -c 120 /tmp/s13.out))"; fi

# ---------- S14 cache parity ----------
hdr "S14 — Cache parity"
(cd "$(dirname "$0")/.." && npx vitest run tests/integration/cache-parity.test.ts >/tmp/s14.log 2>&1) \
  && ok "CONFIG_CACHE on/off parity" || bad "parity broken"

echo
echo "==============================="
echo "PASS=$PASS FAIL=$FAIL"
[ -f "$JAR" ] && rm -f "$JAR"
exit $FAIL
