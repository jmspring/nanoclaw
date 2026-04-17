# DTrace Integration for NanoClaw

DTrace is FreeBSD's dynamic tracing framework providing kernel-level observability with near-zero overhead when not active. NanoClaw ships D scripts for tracing jail agent activity without modifying agent code — a capability unique to FreeBSD that Docker cannot match.

## Prerequisites

- FreeBSD 15.0+ with DTrace kernel module loaded
- Root access (DTrace requires elevated privileges)
- NanoClaw running with jail runtime (`NANOCLAW_RUNTIME=jail`)

## Available Scripts

### nanoclaw-io.d — File I/O Tracing

Traces `open()`, `read()`, `write()`, and `unlink()` syscalls within a jail.

```bash
sudo dtrace -C -s etc/dtrace/nanoclaw-io.d -D jailid=5
```

Example output:
```
TIMESTAMP	SYSCALL	PID	PROCESS	ARG	RETVAL
2026 Mar 27 10:00:01	open	1234	node	/workspace/CLAUDE.md	3
2026 Mar 27 10:00:01	read	1234	node	4096 bytes	4096
2026 Mar 27 10:00:02	write	1234	node	256 bytes	256
```

### nanoclaw-net.d — Network Activity Tracing

Traces `connect()`, `sendto()`, and `recvfrom()` syscalls within a jail.

```bash
sudo dtrace -C -s etc/dtrace/nanoclaw-net.d -D jailid=5
```

Example output:
```
TIMESTAMP	SYSCALL	PID	PROCESS	FD	BYTES	RETVAL
2026 Mar 27 10:00:01	connect	1234	node	fd=8	-	0
2026 Mar 27 10:00:01	sendto	1234	node	fd=8	1024	1024
2026 Mar 27 10:00:02	recvfrom	1234	node	fd=8	4096	4096
```

**Limitation:** IP address extraction from sockaddr structs is not implemented in these scripts. For full address-level visibility, use `tcpdump` on the jail's epair interface: `sudo tcpdump -i epair<N>b`.

### nanoclaw-proc.d — Process Activity Tracing

Traces fork, exec, and exit events within a jail.

```bash
sudo dtrace -C -s etc/dtrace/nanoclaw-proc.d -D jailid=5
```

Example output:
```
TIMESTAMP	EVENT	PID	PROCESS	DETAIL
2026 Mar 27 10:00:01	exec	1234	node	/usr/local/bin/node /workspace/agent.js
2026 Mar 27 10:00:02	fork	1234	node	child_pid=1235
2026 Mar 27 10:00:05	exit	1235	node	exit_status=0
```

## Finding the Jail ID

The jail ID (JID) is needed for all D scripts. Find it with:

```bash
# List all active jails
jls

# Find a specific NanoClaw jail
jls | grep nanoclaw
```

## Jail ID Filtering Approach

The D scripts filter by jail ID using `curthread->td_ucred->cr_prison->pr_id`, which accesses the kernel's process credential structure to get the jail ID of the current thread. This is the standard approach on FreeBSD 15 and works reliably across all syscall probes.

## Security Considerations

DTrace has full kernel access. It can read any memory, trace any process, and observe any syscall on the system — not just within jails.

- **Who should have access:** Only system administrators with root access
- **When to use:** Debugging agent behavior, investigating security incidents, performance analysis
- **When NOT to use:** DTrace adds overhead when active. Do not leave traces running in production unless investigating a specific issue
- **Audit trail:** DTrace sessions are logged by NanoClaw when started via the TypeScript API. Manual sessions via `sudo dtrace` are not logged automatically

## Programmatic Usage

The TypeScript module (`src/jail/dtrace.ts`) provides a wrapper for starting and stopping DTrace sessions:

```typescript
import { isDTraceAvailable, startTrace, stopTrace, listAvailableScripts } from './jail/dtrace.js';

if (isDTraceAvailable()) {
  const session = startTrace(jailId, 'nanoclaw-io.d', logsDir);
  // ... run agent ...
  if (session) {
    const outputPath = await stopTrace(session);
    // outputPath contains the trace log
  }
}
```
