export const SAMPLE_CHECKER_TEMPLATE = `#!/usr/bin/env bash
# Hard checker - runs from cwd = workspace before each turn.
# Contract:
#   - exit 0   => goal achieved
#   - exit !=0 => not yet
#   - the optional <checker-result> JSON below lets the runner inject
#     per-milestone failure detail into the next turn's prompt.
#
# Side-effect-free, idempotent, fast (<5s) - this runs every turn.

# --- milestone checks (replace with your actual goal criteria) -----------
check_m1() { test -f dist/build.js; }              # M1: build artifact exists
check_m2() { npm test --silent >/dev/null 2>&1; }  # M2: tests pass
# check_m3() { curl -fsS http://localhost:3000/health >/dev/null; }

# --- execute and collect results -----------------------------------------
declare -a milestones
overall=0
add() { local id="$1" label="$2" fn="$3"
  if "$fn" 2>/dev/null; then
    milestones+=("{\\"id\\":\\"$id\\",\\"label\\":\\"$label\\",\\"status\\":\\"pass\\"}")
  else
    milestones+=("{\\"id\\":\\"$id\\",\\"label\\":\\"$label\\",\\"status\\":\\"fail\\"}")
    overall=1
  fi
}
add M1 "build artifact exists" check_m1
add M2 "tests pass" check_m2
# add M3 "health endpoint OK" check_m3

passed=$(printf '%s\\n' "\${milestones[@]}" | grep -c '"pass"' || true)
total=\${#milestones[@]}

# --- emit structured result (PR-D: optional, parsed by runner) -----------
cat <<EOF
<checker-result>
{"schema_version":1,"milestones":[$(IFS=,; echo "\${milestones[*]}")],"evidence":"$passed/$total milestones passed","passed_count":$passed,"total_count":$total}
</checker-result>
EOF
exit "$overall"
`

export function isDefaultSampleCheckerTemplate(script: string): boolean {
  const normalized = script.replace(/\r\n/g, '\n')
  const markers = [
    'replace with your actual goal criteria',
    'check_m1() { test -f dist/build.js; }',
    'check_m2() { npm test --silent >/dev/null 2>&1; }',
    'add M1 "build artifact exists" check_m1',
    'add M2 "tests pass" check_m2',
    '<checker-result>',
    '"evidence":"$passed/$total milestones passed"'
  ]

  return markers.every((marker) => normalized.includes(marker))
}
