#!/usr/bin/env bash
# One-shot check: can this shell reach the WorkBuddy bridge, authenticate, and
# get a real chat turn back? Prints PASS/FAIL per step and a verdict.
#
#   bash wsl-check.sh
#
# Reads the live endpoint from the bridge descriptor, so it survives restarts
# (the port and token are per process). Works from WSL and from Git Bash.

set -u

MODEL="${MODEL:-deepseek-v4.1-flash}"

# --- find the descriptor -----------------------------------------------------
# WSL's $HOME is the Linux home, but the bridge writes under the Windows
# profile, so both locations are searched.
DESC=""
for cand in "${HOME:-}/.workbuddy-bridge/.workbuddy-bridge-endpoint.json" \
            /mnt/c/Users/*/.workbuddy-bridge/.workbuddy-bridge-endpoint.json; do
  if [ -f "$cand" ]; then DESC="$cand"; break; fi
done

if [ -z "$DESC" ]; then
  echo "FAIL  no descriptor found — is the bridge running?"
  echo "      looked in: \$HOME/.workbuddy-bridge and /mnt/c/Users/*/.workbuddy-bridge"
  exit 1
fi

# --- read the signed-in endpoint ---------------------------------------------
read_endpoint() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const d=require(process.argv[1]);const e=d.endpoints.find(x=>x.signedIn)||d.endpoints[0];console.log(e.wslBaseUrl||e.baseUrl);console.log(e.token)' "$DESC"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));e=next((x for x in d["endpoints"] if x.get("signedIn")),d["endpoints"][0]);print(e.get("wslBaseUrl") or e["baseUrl"]);print(e["token"])' "$DESC"
  else
    echo "FAIL  need node or python3 to read the descriptor"
    exit 1
  fi
}

INFO="$(read_endpoint)"
URL="$(printf '%s\n' "$INFO" | sed -n 1p)"
TOKEN="$(printf '%s\n' "$INFO" | sed -n 2p)"
ORIGIN="$(printf '%s' "$URL" | sed 's#/v1$##')"

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
  echo "FAIL  could not read endpoint/token from $DESC"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL  curl is not installed in this shell"
  exit 1
fi

echo "descriptor : $DESC"
echo "endpoint   : $URL"
echo "model      : $MODEL"
echo

# --- step 1: reachability ----------------------------------------------------
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
S1="$(curl -sS -m 10 -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$ORIGIN/healthz" 2>/dev/null || echo 000)"
if [ "$S1" = "200" ]; then
  echo "PASS  1 reachability        /healthz -> 200"
else
  echo "FAIL  1 reachability        /healthz -> $S1"
  echo "      this shell cannot reach $ORIGIN — networking, not the bridge."
  echo "      (000 = connection refused/timeout; 404 = bridge was started without --wsl)"
  sed -n '1,3p' "$BODY" | sed 's/^/      /'
  exit 1
fi

# --- step 2: auth + catalog --------------------------------------------------
S2="$(curl -sS -m 15 -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$URL/models" 2>/dev/null || echo 000)"
if [ "$S2" = "200" ]; then
  N="$(grep -o '"id"' "$BODY" | wc -l | tr -d ' ')"
  echo "PASS  2 auth + catalog      /v1/models -> 200 ($N models)"
else
  echo "FAIL  2 auth + catalog      /v1/models -> $S2"
  echo "      a 401 means the token is stale: the bridge restarted, so the"
  echo "      port and token both changed. Re-read them from the descriptor."
  sed -n '1,3p' "$BODY" | sed 's/^/      /'
  exit 1
fi

# --- step 3: a real chat turn ------------------------------------------------
S3="$(curl -sS -N -m 90 -o "$BODY" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}]}" \
  "$URL/chat/completions" 2>/dev/null || echo 000)"

if [ "$S3" = "200" ]; then
  if grep -q '"content"' "$BODY"; then
    echo "PASS  3 chat turn           /v1/chat/completions -> 200, streamed content"
  else
    echo "WARN  3 chat turn           /v1/chat/completions -> 200 but no content delta"
    sed -n '1,5p' "$BODY" | sed 's/^/      /'
  fi
else
  echo "FAIL  3 chat turn           /v1/chat/completions -> $S3"
  echo "      the request reached the bridge and the bridge reached upstream;"
  echo "      the upstream refused it. Its own words:"
  sed -n '1,6p' "$BODY" | sed 's/^/      /'
  echo
  echo "      the bridge recorded this exchange at:"
  echo "      \$HOME/.workbuddy-bridge/last-channel-failure.json"
  exit 1
fi

echo
echo "VERDICT: the bridge works from this shell, end to end."
echo "         If zcode still fails, its request differs from the one above —"
echo "         compare zcode's model id and base URL with the values printed here."
