#!/usr/bin/env bash
set -e

echo "=== Pre-compiling pages ==="
for url in /login /onboarding /anchored-uniforms /anchored-uniforms/agents /anchored-uniforms/connections /anchored-uniforms/settings; do
  echo -n "$url: "
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' "http://localhost:3326$url" --max-time 60
done

echo ""
echo "=== Running E2E tests ==="
E2E_TEST=1 npx playwright test --config=e2e/playwright.config.ts
status=$?

echo ""
echo "=== Done (exit $status) ==="
exit $status
