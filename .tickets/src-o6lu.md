---
id: src-o6lu
status: closed
deps: []
links: []
created: 2026-03-24T22:21:14Z
type: task
priority: 1
assignee: Jim Spring
tags: [upstream-sync, wave2]
---
# Merge upstream native-credential-proxy config.ts changes

Sync config.ts with `upstream/skill/native-credential-proxy` branch (not upstream/main).

This branch keeps CREDENTIAL_PROXY_PORT and .env-based credential management — matching our jail architecture.

Steps:
1. git diff main...upstream/skill/native-credential-proxy -- src/config.ts
2. Read src/config.ts
3. Apply upstream changes from the native-credential-proxy branch:
   - Any new config vars or defaults
   - Keep CREDENTIAL_PROXY_PORT (upstream native proxy branch keeps it too)
   - Keep our jail-specific bounds clamping (clampInt wrappers added in Phase 5E)
4. npm run build && npm test
5. git checkout -b upstream/13G-config-sync && git add src/config.ts && git commit -m 'upstream(13G): sync config.ts with native-credential-proxy branch'
6. git push && gh pr create

Acceptance: config.ts matches upstream/skill/native-credential-proxy with our jail-specific additions preserved. CREDENTIAL_PROXY_PORT still exported. Build and tests pass.
