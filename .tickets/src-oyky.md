---
id: src-oyky
status: closed
deps: []
links: []
created: 2026-03-19T15:47:37Z
type: task
priority: 1
assignee: Jim Spring
external-ref: nan-bsv4
---
# Add inter-jail network isolation

Ensure jails cannot communicate with each other over the network.

**Context:**
- With per-jail IPs (10.99.N.0/30 from nan-whvd), jails are on same /24
- Need to prevent jail A from reaching jail B
- etc/pf-nanoclaw.conf has firewall rules
- Currently allows all traffic within jail_net

**Implementation:**
- Add pf rules blocking inter-jail traffic (10.99.0.0/24 -> 10.99.0.0/24)
- Exception: Allow jail -> its own gateway (10.99.N.2 -> 10.99.N.1)
- Allow outbound to external networks (via NAT)
- Test: verify jail cannot ping other jail IPs

**Files:**
- etc/pf-nanoclaw.conf (firewall rules)

**Acceptance:**
- [ ] Inter-jail traffic blocked by pf
- [ ] Jail can reach its own gateway
- [ ] Jail can reach external networks
- [ ] Build succeeds


## Notes

**2026-03-19T17:05:33Z**

Added inter-jail isolation rules to etc/pf-nanoclaw.conf. Block rule prevents direct jail-to-jail communication while preserving jail->gateway:3001 access for credential proxy.
