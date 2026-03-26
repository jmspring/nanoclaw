---
id: src-oncl
status: closed
deps: []
links: [src-2ssz]
created: 2026-03-25T00:00:00Z
type: research
priority: 3
assignee: Jim Spring
tags: [onecli, jails, future]
---
# Investigate OneCLI as credential gateway for FreeBSD jails

Research ticket: determine if OneCLI can replace the native credential proxy for jail-based agent isolation.

Use the investigation prompt at `analysis/prompts/investigate-onecli-jails.md`.

Key questions:
1. Does OneCLI run on FreeBSD? Could it run in a Linux jail?
2. Can jails use OneCLI as a plain HTTP proxy (ANTHROPIC_BASE_URL)?
3. Does OneCLI provide per-agent auth, IP filtering, rate limiting?
4. Could OneCLI run in a dedicated gateway jail for isolation?
5. Can pf rules fill any security gaps?

Deliverable: `analysis/experts/onecli-jail-feasibility.md` with platform verdict, security parity matrix, and recommendation.

Not blocking — the native credential proxy (Option A) is the current path. This is forward-looking research for a potential future migration.
