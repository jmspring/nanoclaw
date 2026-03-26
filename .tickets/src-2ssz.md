---
id: src-2ssz
status: closed
deps: [src-bwcn]
links: []
created: 2026-03-24T22:36:18Z
type: task
priority: 1
assignee: Jim Spring
tags: [upstream-sync, wave5]
---
# Final verification — lint, build, test, upstream diff audit

Gate ticket: verify full upstream sync is complete.

Steps:
1. npm run build -- 0 errors
2. npm test -- all pass, 0 failures
3. npm run lint -- no errors (warnings OK in jail code)
4. Audit diff against native-credential-proxy branch:
   git diff main...upstream/skill/native-credential-proxy --stat
   - Shared files should match upstream/skill/native-credential-proxy
   - Differences should only be our jail-specific additions (src/jail/, jail hardening in credential-proxy.ts, jail hooks in index.ts, etc.)
5. Audit diff against upstream/main for non-credential features:
   git diff main...upstream/main -- src/remote-control.ts src/ipc.ts
   - Remote control and IPC changes should be merged
6. Verify credential proxy still functional:
   - credential-proxy.ts present with jail hardening
   - index.ts starts proxy on boot
   - jail/runner.ts routes through proxy
   - jail/lifecycle.ts manages tokens
7. Verify jail code compiles and tests pass
8. Fix any lint errors or missed changes
9. git add -A && git commit -m 'upstream(13L): final lint fixes and verification'
10. git push && gh pr create

Acceptance: 0 build errors, 0 test failures, 0 lint errors. Shared files match upstream/skill/native-credential-proxy. Jail hardening intact. Non-credential upstream/main features (remote control, IPC tasks) merged.
