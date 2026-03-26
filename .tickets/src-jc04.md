---
id: src-jc04
status: closed
deps: []
links: []
created: 2026-03-16T14:30:00Z
type: task
priority: 2
tags: [jail-cleanup, phase6, config]
---
# Consolidate pf firewall configuration files

Two pf configuration files exist:
- `etc/pf-nanoclaw.conf` - standalone rules
- `etc/pf-nanoclaw-anchor.conf` - anchor format for existing pf.conf

Tasks:
- Document when to use each file in FREEBSD_JAILS.md
- OR remove redundant file if one approach is preferred
- Ensure installation instructions are clear

