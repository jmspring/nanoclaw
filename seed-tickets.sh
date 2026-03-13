# seed-tickets.sh — Create all nanoclaw-jails PoC tickets (v3)
# Run from: /home/jims/code/nanoclaw/src
# Requires: tk in PATH

set -e

if [ ! -f package.json ]; then
  echo "ERROR: Run this from /home/jims/code/nanoclaw/src"
  exit 1
fi

echo "=== Seeding tickets ==="

# --- Phase 0: Bootstrap ---
P0_000=$(tk create "Destroy existing ZFS datasets" -t task -p 2 --external-ref TK-000 | tail -1)
P0_001=$(tk create "Fork NanoClaw on GitHub" -t task -p 1 --external-ref TK-001 | tail -1)
P0_002=$(tk create "Install system packages" -t task -p 2 --external-ref TK-002 | tail -1)
P0_003=$(tk create "Configure sudoers for jail management" -t task -p 1 --external-ref TK-003 | tail -1)
P0_004=$(tk create "Install tk ticket tracker" -t task -p 2 --external-ref TK-004 | tail -1)
P0_005=$(tk create "Authenticate GitHub CLI" -t task -p 2 --external-ref TK-005 | tail -1)
P0_006=$(tk create "Create ZFS dataset hierarchy" -t task -p 2 --external-ref TK-006 | tail -1)
P0_007=$(tk create "Clone fork and configure remotes" -t task -p 1 --external-ref TK-007 | tail -1)
P0_008=$(tk create "Seed tickets from plan" -t task -p 2 --external-ref TK-008 | tail -1)
P0_009=$(tk create "Smoke test Claude Agent SDK" -t task -p 2 --external-ref TK-009 | tail -1)
P0_010=$(tk create "Snapshot phase-0" -t task -p 2 --external-ref TK-010 | tail -1)

echo "Phase 0: $P0_000 $P0_001 $P0_002 $P0_003 $P0_004 $P0_005 $P0_006 $P0_007 $P0_008 $P0_009 $P0_010"

# --- Phase 1: Codebase Analysis ---
P1_100=$(tk create "SUBAGENT: Map container runtime interface" -t task -p 1 --external-ref TK-100 | tail -1)
P1_101=$(tk create "SUBAGENT: Identify SDK coupling" -t task -p 1 --external-ref TK-101 | tail -1)
P1_102=$(tk create "Review subagent analysis outputs" -t task -p 1 --external-ref TK-102 | tail -1)
P1_103=$(tk create "Phase 1 PR and snapshot" -t task -p 2 --external-ref TK-103 | tail -1)

echo "Phase 1: $P1_100 $P1_101 $P1_102 $P1_103"

# --- Phase 2: Jail Infrastructure ---
P2_200=$(tk create "Create jail base template" -t task -p 1 --external-ref TK-200 | tail -1)
P2_201=$(tk create "Create and validate test jail" -t task -p 1 --external-ref TK-201 | tail -1)
P2_202=$(tk create "Test Claude Agent SDK inside jail" -t task -p 0 --external-ref TK-202 | tail -1)
P2_203=$(tk create "Validate filesystem isolation" -t task -p 1 --external-ref TK-203 | tail -1)
P2_204=$(tk create "Validate bidirectional IPC" -t task -p 1 --external-ref TK-204 | tail -1)
P2_205=$(tk create "Tear down test jail cleanly" -t task -p 2 --external-ref TK-205 | tail -1)
P2_206=$(tk create "Document results and Phase 2 PR" -t task -p 2 --external-ref TK-206 | tail -1)

echo "Phase 2: $P2_200 $P2_201 $P2_202 $P2_203 $P2_204 $P2_205 $P2_206"

# --- Phase 3: Jail Runtime Driver ---
P3_300=$(tk create "SUBAGENT: Write jail-runtime.js" -t task -p 0 --external-ref TK-300 | tail -1)
P3_301=$(tk create "SUBAGENT: Write jail-runtime unit tests" -t task -p 1 --external-ref TK-301 | tail -1)
P3_302=$(tk create "Run unit tests, fix issues" -t task -p 1 --external-ref TK-302 | tail -1)
P3_303=$(tk create "SUBAGENT: Wire jail runtime into orchestrator" -t task -p 1 --external-ref TK-303 | tail -1)
P3_304=$(tk create "Review integration diff" -t task -p 1 --external-ref TK-304 | tail -1)
P3_305=$(tk create "Phase 3 PR and snapshot" -t task -p 2 --external-ref TK-305 | tail -1)

echo "Phase 3: $P3_300 $P3_301 $P3_302 $P3_303 $P3_304 $P3_305"

# --- Phase 4: Integration Testing ---
P4_400=$(tk create "Start orchestrator with jail runtime" -t task -p 1 --external-ref TK-400 | tail -1)
P4_401=$(tk create "Send test message via CLI" -t task -p 1 --external-ref TK-401 | tail -1)
P4_402=$(tk create "Validate jail lifecycle during message" -t task -p 0 --external-ref TK-402 | tail -1)
P4_403=$(tk create "Validate agent memory persistence" -t task -p 1 --external-ref TK-403 | tail -1)
P4_404=$(tk create "Validate concurrent jails" -t task -p 1 --external-ref TK-404 | tail -1)
P4_405=$(tk create "Stress test rapid create/destroy" -t task -p 2 --external-ref TK-405 | tail -1)
P4_406=$(tk create "Document results and Phase 4 PR" -t task -p 2 --external-ref TK-406 | tail -1)

echo "Phase 4: $P4_400 $P4_401 $P4_402 $P4_403 $P4_404 $P4_405 $P4_406"

# --- Phase 5: Network Hardening ---
P5_500=$(tk create "SUBAGENT: Write pf rules for jail NAT" -t task -p 1 --external-ref TK-500 | tail -1)
P5_501=$(tk create "Update jail-runtime for lo1 networking" -t task -p 1 --external-ref TK-501 | tail -1)
P5_502=$(tk create "Test agent with restricted networking" -t task -p 1 --external-ref TK-502 | tail -1)
P5_503=$(tk create "Phase 5 PR and snapshot" -t task -p 2 --external-ref TK-503 | tail -1)

echo "Phase 5: $P5_500 $P5_501 $P5_502 $P5_503"

# --- Phase 6: Documentation and Contribution ---
P6_600=$(tk create "SUBAGENT: Write FREEBSD_JAILS.md" -t task -p 1 --external-ref TK-600 | tail -1)
P6_601=$(tk create "SUBAGENT: Write setup-freebsd.sh" -t task -p 1 --external-ref TK-601 | tail -1)
P6_602=$(tk create "Phase 6 PR" -t task -p 1 --external-ref TK-602 | tail -1)
P6_603=$(tk create "Submit upstream PR to qwibitai/nanoclaw" -t task -p 1 --external-ref TK-603 | tail -1)
P6_604=$(tk create "Final snapshot" -t task -p 2 --external-ref TK-604 | tail -1)

echo "Phase 6: $P6_600 $P6_601 $P6_602 $P6_603 $P6_604"

echo ""
echo "=== Wiring dependencies ==="

# Phase 0 chain
tk dep "$P0_001" "$P0_000"
tk dep "$P0_002" "$P0_001"
tk dep "$P0_003" "$P0_002"
tk dep "$P0_004" "$P0_002"
tk dep "$P0_005" "$P0_002"
tk dep "$P0_006" "$P0_003"
tk dep "$P0_007" "$P0_006"
tk dep "$P0_007" "$P0_005"
tk dep "$P0_008" "$P0_007"
tk dep "$P0_008" "$P0_004"
tk dep "$P0_009" "$P0_007"
tk dep "$P0_010" "$P0_008"
tk dep "$P0_010" "$P0_009"
echo "Phase 0 deps wired"

# Phase 1 depends on Phase 0
tk dep "$P1_100" "$P0_010"
tk dep "$P1_101" "$P0_010"
tk dep "$P1_102" "$P1_100"
tk dep "$P1_102" "$P1_101"
tk dep "$P1_103" "$P1_102"
echo "Phase 1 deps wired"

# Phase 2 depends on Phase 1
tk dep "$P2_200" "$P1_103"
tk dep "$P2_201" "$P2_200"
tk dep "$P2_202" "$P2_201"
tk dep "$P2_203" "$P2_202"
tk dep "$P2_204" "$P2_203"
tk dep "$P2_205" "$P2_204"
tk dep "$P2_206" "$P2_205"
echo "Phase 2 deps wired"

# Phase 3 depends on Phase 2
tk dep "$P3_300" "$P2_206"
tk dep "$P3_301" "$P3_300"
tk dep "$P3_302" "$P3_301"
tk dep "$P3_303" "$P3_302"
tk dep "$P3_304" "$P3_303"
tk dep "$P3_305" "$P3_304"
echo "Phase 3 deps wired"

# Phase 4 depends on Phase 3
tk dep "$P4_400" "$P3_305"
tk dep "$P4_401" "$P4_400"
tk dep "$P4_402" "$P4_401"
tk dep "$P4_403" "$P4_402"
tk dep "$P4_404" "$P4_403"
tk dep "$P4_405" "$P4_404"
tk dep "$P4_406" "$P4_405"
echo "Phase 4 deps wired"

# Phase 5 depends on Phase 4
tk dep "$P5_500" "$P4_406"
tk dep "$P5_501" "$P5_500"
tk dep "$P5_502" "$P5_501"
tk dep "$P5_503" "$P5_502"
echo "Phase 5 deps wired"

# Phase 6 depends on Phase 5
tk dep "$P6_600" "$P5_503"
tk dep "$P6_601" "$P5_503"
tk dep "$P6_602" "$P6_600"
tk dep "$P6_602" "$P6_601"
tk dep "$P6_603" "$P6_602"
tk dep "$P6_604" "$P6_603"
echo "Phase 6 deps wired"

echo ""
echo "=== Closing completed tickets ==="

# Phase 0 tickets through TK-008 (this script) are done
tk close "$P0_000"
tk close "$P0_001"
tk close "$P0_002"
tk close "$P0_003"
tk close "$P0_004"
tk close "$P0_005"
tk close "$P0_006"
tk close "$P0_007"
tk close "$P0_008"

echo "Phase 0 tickets TK-000 through TK-008 closed"

echo ""
echo "=== Done ==="
echo ""
echo "--- Ready ---"
tk ready
echo ""
echo "--- Blocked ---"
tk blocked
echo ""
echo "--- Recently closed ---"
tk closed
