# NanoClaw Claude Agent SDK Coupling Analysis

Generated: 2026-03-13

---

## 1. SDK INVOCATION PATH

### Where Is the SDK Imported?

The Claude Agent SDK is imported **inside the container**, not by the orchestrator:

```
container/agent-runner/src/index.ts:19
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
```

### Complete Code Path

```
User Message
    ↓
src/index.ts:493-510          ← onMessage callback stores message in SQLite
    ↓
src/index.ts:353-442          ← startMessageLoop() polls for new messages
    ↓
src/group-queue.ts            ← GroupQueue schedules container invocation
    ↓
src/index.ts:146-261          ← processGroupMessages() builds prompt
    ↓
src/index.ts:263-342          ← runAgent() calls runContainerAgent()
    ↓
src/container-runner.ts:267-272   ← runContainerAgent() signature
    ↓
src/container-runner.ts:310-312   ← spawn(CONTAINER_RUNTIME_BIN, containerArgs)
    ↓
src/container-runner.ts:321-322   ← stdin.write(JSON.stringify(input)); stdin.end()
    ↓
[DOCKER CONTAINER BOUNDARY]
    ↓
container/agent-runner/src/index.ts:467-556   ← main() parses stdin
    ↓
container/agent-runner/src/index.ts:332-465   ← runQuery()
    ↓
container/agent-runner/src/index.ts:392-431   ← query({ prompt: stream, options })
    ↓
@anthropic-ai/claude-agent-sdk               ← SDK processes with Claude API
```

### Critical Finding

The orchestrator (`src/index.ts`) does **NOT** import the Claude Agent SDK. It spawns a Docker container and communicates via:
- **stdin**: JSON `ContainerInput` (prompt, sessionId, groupFolder, chatJid, isMain)
- **stdout**: JSON `ContainerOutput` wrapped in `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers
- **IPC files**: `/workspace/ipc/` for messages, tasks, and follow-up input

The SDK dependency exists only in `container/agent-runner/package.json:12`:
```json
"@anthropic-ai/claude-agent-sdk": "^0.2.34"
```

---

## 2. SDK FEATURES USED

| Feature | File:Line | Usage |
|---------|-----------|-------|
| `query()` | `container/agent-runner/src/index.ts:392-431` | Main SDK entry point, invokes Claude with streaming |
| AsyncIterable prompt | `container/agent-runner/src/index.ts:62-95` | `MessageStream` class enables multi-turn streaming |
| Session resume | `container/agent-runner/src/index.ts:397` | `options.resume: sessionId` |
| Resume at UUID | `container/agent-runner/src/index.ts:398` | `options.resumeSessionAt: resumeAt` |
| System prompt | `container/agent-runner/src/index.ts:399-401` | `systemPrompt: { type: 'preset', preset: 'claude_code', append: globalClaudeMd }` |
| Allowed tools | `container/agent-runner/src/index.ts:402-411` | Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, TeamCreate, MCP tools, etc. |
| Permission bypass | `container/agent-runner/src/index.ts:413-414` | `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true` |
| MCP servers | `container/agent-runner/src/index.ts:416-426` | Custom `nanoclaw` MCP server for IPC |
| Hooks | `container/agent-runner/src/index.ts:427-429` | `PreCompact` hook archives conversations before context compaction |
| Additional directories | `container/agent-runner/src/index.ts:396` | `additionalDirectories: extraDirs` loads CLAUDE.md from mounted dirs |
| Environment passthrough | `container/agent-runner/src/index.ts:412` | `env: sdkEnv` passes environment to SDK |
| Setting sources | `container/agent-runner/src/index.ts:415` | `settingSources: ['project', 'user']` |

### Result Message Types Handled

| Type | File:Line | Handling |
|------|-----------|----------|
| `system/init` | `container/agent-runner/src/index.ts:440-443` | Captures `session_id` |
| `system/task_notification` | `container/agent-runner/src/index.ts:445-448` | Logs task status |
| `assistant` with `uuid` | `container/agent-runner/src/index.ts:436-438` | Tracks `lastAssistantUuid` for resume |
| `result` | `container/agent-runner/src/index.ts:450-459` | Calls `writeOutput()` for streaming |

### MCP Server (container-side)

The agent runner spawns an MCP server for IPC tools:

| Tool | File:Line | Purpose |
|------|-----------|---------|
| `send_message` | `container/agent-runner/src/ipc-mcp-stdio.ts:42-63` | Send messages to user immediately |
| `schedule_task` | `container/agent-runner/src/ipc-mcp-stdio.ts:65-153` | Create scheduled tasks |
| `list_tasks` | `container/agent-runner/src/ipc-mcp-stdio.ts:155-191` | List scheduled tasks |
| `pause_task` | `container/agent-runner/src/ipc-mcp-stdio.ts:193-210` | Pause a task |
| `resume_task` | `container/agent-runner/src/ipc-mcp-stdio.ts:212-229` | Resume a task |
| `cancel_task` | `container/agent-runner/src/ipc-mcp-stdio.ts:231-248` | Cancel a task |
| `update_task` | `container/agent-runner/src/ipc-mcp-stdio.ts:250-298` | Update task properties |
| `register_group` | `container/agent-runner/src/ipc-mcp-stdio.ts:300-334` | Register new chat group |

---

## 3. SDK EXECUTION LOCATION

### Finding: SDK Runs INSIDE the Container

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          HOST (FreeBSD jail candidate)                    │
├─────────────────────────────────────────────────────────────────────────┤
│  src/index.ts         - Orchestrator (NO SDK)                            │
│  src/container-runner.ts - Spawns containers (NO SDK)                    │
│  src/credential-proxy.ts - HTTP proxy for API credentials                │
│                                                                          │
│  Imports: child_process, better-sqlite3, pino                            │
│  NO Claude SDK imports                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                       DOCKER CONTAINER (Linux VM)                         │
├─────────────────────────────────────────────────────────────────────────┤
│  container/agent-runner/src/index.ts                                     │
│     import { query } from '@anthropic-ai/claude-agent-sdk' ← SDK HERE    │
│                                                                          │
│  container/agent-runner/src/ipc-mcp-stdio.ts                             │
│     import { McpServer } from '@modelcontextprotocol/sdk'                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Implications for FreeBSD Jail Port

1. **Jail needs the SDK**: The Claude Agent SDK must be available inside the jail/container.
2. **Jail needs Node.js**: The agent-runner is a Node.js application.
3. **Jail needs network access**: API calls originate from inside (via credential proxy).
4. **Host does NOT need the SDK**: The orchestrator only spawns processes.

The container image is built from `node:22-slim` with these key additions:
- `container/Dockerfile:34`: `npm install -g agent-browser @anthropic-ai/claude-code`
- `container/Dockerfile:43`: `npm install` for agent-runner dependencies

---

## 4. LINUX-SPECIFIC ASSUMPTIONS

### In NanoClaw Codebase

| File:Line | Code | Purpose | FreeBSD Impact |
|-----------|------|---------|----------------|
| `src/container-runtime.ts:31` | `fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')` | WSL detection | Not applicable on FreeBSD; check returns false |
| `src/container-runtime.ts:46` | `os.platform() === 'linux'` | Host gateway args | FreeBSD returns `'freebsd'`, needs handling |
| `setup/platform.ts:21` | `fs.readFileSync('/proc/version', 'utf-8')` | WSL detection | FreeBSD has no `/proc/version`; needs error handling |
| `setup/platform.ts:45` | `fs.readFileSync('/proc/1/comm', 'utf-8')` | Init system detection | FreeBSD has no `/proc` by default |
| `setup.sh:27-28` | `grep -qi 'microsoft\|wsl' /proc/version` | WSL detection | Fails gracefully |

### Container Dockerfile (container/Dockerfile)

The container image is explicitly **Linux-based**:

| Line | Dependency | FreeBSD Concern |
|------|------------|-----------------|
| 4 | `FROM node:22-slim` | Debian-based Linux image |
| 7-27 | `apt-get install chromium fonts-* lib*` | Linux-specific packages |
| 30 | `ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` | Linux Chromium path |

**For FreeBSD jails**: A native FreeBSD jail cannot run this Dockerfile. Options:
1. **Linux emulation (linuxulator)**: Run Linux binaries in FreeBSD jail
2. **bhyve VM**: Run full Linux VM for containers
3. **Native port**: Rebuild agent-runner with FreeBSD-native dependencies

### In @anthropic-ai/claude-agent-sdk Package

The SDK is not installed locally (only inside containers at build time), so direct source analysis is not possible. However, the SDK is documented as pure JavaScript with no native modules:

From `runtime-interface.md`:
> `@anthropic-ai/claude-agent-sdk` | ^0.2.34 | No | Pure JavaScript (runs inside Linux container)

**To verify Linux-specific code in the SDK**, you would need to:
```bash
cd container/agent-runner
npm install
grep -r '/proc\|cgroup\|/sys/' node_modules/@anthropic-ai/
```

**Expected SDK dependencies that may have Linux assumptions:**
- Shell execution (Bash tool) — assumes `/bin/bash`
- File path handling — assumes Unix paths (ok on FreeBSD)
- Process spawning — uses Node.js `child_process` (cross-platform)

---

## 5. NETWORK ACCESS REQUIREMENTS

### Finding: Container Needs Network Access (via Proxy)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              HOST                                        │
│  ┌─────────────────────────┐                                             │
│  │  Credential Proxy       │ ← Binds to PROXY_BIND_HOST:50888            │
│  │  src/credential-proxy.ts│   Injects real API keys/OAuth tokens        │
│  └───────────▲─────────────┘                                             │
│              │ HTTP                                                      │
├──────────────┼──────────────────────────────────────────────────────────┤
│              │           DOCKER CONTAINER                                │
│  ┌───────────┴─────────────┐                                             │
│  │  ANTHROPIC_BASE_URL=    │                                             │
│  │  http://host.docker.internal:50888                                    │
│  │                         │                                             │
│  │  Agent SDK → API calls  │ → Proxy → api.anthropic.com                 │
│  └─────────────────────────┘                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Environment Variables Injected

From `src/container-runner.ts:225-239`:
```typescript
args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);

if (authMode === 'api-key') {
  args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
} else {
  args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
}
```

### Network Flow

1. **Container** makes HTTP requests to `http://host.docker.internal:50888`
2. **Credential Proxy** (`src/credential-proxy.ts:26-119`) intercepts requests
3. **Proxy** replaces placeholder credentials with real ones from `.env`
4. **Proxy** forwards to `https://api.anthropic.com` (or custom `ANTHROPIC_BASE_URL`)
5. **Response** flows back through proxy to container

### FreeBSD Jail Network Requirements

For jails, the equivalent of `host.docker.internal` must be established:
- **VNET jails**: Configure routing to host's loopback
- **IP alias jails**: Use host's IP directly
- **Loopback jail**: Bind proxy to jail-accessible interface

The credential proxy bind address is configurable via:
- `src/container-runtime.ts:23-41`: `PROXY_BIND_HOST` detection
- Environment override: `CREDENTIAL_PROXY_HOST`

---

## 6. SUMMARY TABLE

| Question | Answer |
|----------|--------|
| Is SDK imported by orchestrator? | **No** — only spawns containers |
| Where is SDK imported? | `container/agent-runner/src/index.ts:19` |
| Does SDK run inside or outside container? | **Inside** |
| Does jail need SDK? | **Yes** — agent-runner requires it |
| Does jail need network access? | **Yes** — to reach credential proxy on host |
| Can host reach api.anthropic.com without container? | **Yes** — proxy makes outbound HTTPS calls |
| Linux-specific code in NanoClaw? | Minor: `/proc` checks in platform detection, `os.platform() === 'linux'` |
| Linux-specific code in container? | **Yes**: Dockerfile uses Debian, apt-get, Linux Chromium |

---

## 7. FREEBSD PORT RECOMMENDATIONS

### Option A: Linux Emulation (Recommended)

Use FreeBSD's linuxulator to run the existing Linux container image:
1. Enable Linux compatibility: `kldload linux64`
2. Run Docker/Podman with Linux containers
3. No changes to NanoClaw or agent-runner needed

### Option B: Native FreeBSD Jail

Requires significant work:
1. Port `container/Dockerfile` to FreeBSD base
2. Install FreeBSD Chromium: `pkg install chromium`
3. Install Node.js: `pkg install node22`
4. Build agent-runner inside jail
5. Update `src/container-runtime.ts` for jail commands
6. Update network configuration for jail→host proxy access

### Code Changes Required for Native Port

| File | Change |
|------|--------|
| `src/container-runtime.ts` | Add `freebsd` platform handling, jail spawn commands |
| `src/container-runtime.ts:46` | Handle `os.platform() === 'freebsd'` |
| `setup/platform.ts` | Wrap `/proc` reads in try/catch for FreeBSD |
| `container/Dockerfile` | Create `container/Dockerfile.freebsd` or `container/jail.sh` |

### Testing Checklist

- [ ] Verify SDK has no Linux-only syscalls: `grep -r 'syscall\|/proc\|cgroup' node_modules/@anthropic-ai/`
- [ ] Test agent-runner in FreeBSD environment
- [ ] Verify jail→host networking for credential proxy
- [ ] Test Chromium browser automation in jail (if using agent-browser)
