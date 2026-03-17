---
id: src-jc03
status: open
deps: []
links: []
created: 2026-03-16T14:30:00Z
type: task
priority: 1
tags: [jail-cleanup, phase6, config]
---
# Update .gitignore for jail runtime artifacts

Ensure jail runtime artifacts are excluded from version control:

Files to exclude:
- `jails/` directory (active jail clones and template userland)
- `groups/*/logs/jail-*.log` (jail operation logs)
- Any ZFS mount point artifacts

Verify current .gitignore coverage and add missing patterns.

