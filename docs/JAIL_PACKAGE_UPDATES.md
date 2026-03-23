# Jail Template Package Update Procedure

This document describes how to update npm packages in the jail template while maintaining supply chain security. For the full template build/update guide, see [Template Setup](TEMPLATE_SETUP.md).

## Security Principles

The jail template uses pinned package versions and checksums to ensure reproducibility and prevent supply chain attacks:

1. **Global packages** - Pinned to specific versions in `setup-jail-template.sh`
2. **Agent-runner dependencies** - Locked via `package-lock.json` and installed with `npm ci`
3. **Checksum verification** - npm automatically verifies package integrity using `package-lock.json`

## Updating Global Packages

Global packages (TypeScript, Claude Code CLI) are pinned in `scripts/setup-jail-template.sh`:

```sh
# Current versions (example)
jexec_cmd npm install -g typescript@5.7.3
jexec_cmd npm install -g @anthropic-ai/claude-code@0.2.76
```

### To update a global package:

1. Check the latest version on npm:
   ```sh
   npm view typescript version
   npm view @anthropic-ai/claude-code version
   ```

2. Update the version in `scripts/setup-jail-template.sh`:
   ```sh
   jexec_cmd npm install -g typescript@<NEW_VERSION>
   ```

3. Rebuild the template:
   ```sh
   ./scripts/setup-jail-template.sh
   ```

4. Test with a new jail to verify the updated package works correctly.

## Updating Agent-Runner Dependencies

Agent-runner dependencies are managed via `package.json` and `package-lock.json` in `container/agent-runner/`.

### To update dependencies:

1. Navigate to the agent-runner directory:
   ```sh
   cd container/agent-runner
   ```

2. Update the desired package(s):
   ```sh
   # Update a specific package to latest compatible version
   npm update @anthropic-ai/claude-agent-sdk

   # Or update to a specific version
   npm install @anthropic-ai/claude-agent-sdk@1.2.3

   # Or update all packages
   npm update
   ```

3. Verify the updates:
   ```sh
   npm run build
   npm test  # if tests exist
   ```

4. Commit the updated `package.json` and `package-lock.json`:
   ```sh
   git add package.json package-lock.json
   git commit -m "chore: update agent-runner dependencies"
   ```

5. Rebuild the jail template to include the new dependencies:
   ```sh
   ./scripts/setup-jail-template.sh
   ```

6. Test with a new jail to verify functionality.

## Security Notes

- **Never** manually edit `package-lock.json` - always use `npm install` or `npm update`
- The template setup uses `npm ci` (not `npm install`) to ensure exact versions match `package-lock.json`
- `package-lock.json` is **required** - the setup script will fail if it's missing
- Always rebuild the template after updating packages
- Test thoroughly before deploying to production

## Troubleshooting

### Template setup fails with missing package-lock.json

The setup script requires `container/agent-runner/package-lock.json`. If missing, generate it:

```sh
cd container/agent-runner
npm install
git add package-lock.json
git commit -m "chore: add package-lock.json"
```

### Global package version conflicts

If a specific version of a global package is not available, check npm for available versions:

```sh
npm view typescript versions --json
```

Then pin to an available version in `scripts/setup-jail-template.sh`.

### Dependencies fail to install in jail

1. Check that `package-lock.json` is present and valid
2. Ensure network connectivity in the jail (ip4=inherit, ip6=inherit)
3. Try rebuilding the template with `--no-cache` if needed
4. Check npm registry availability: `npm view @anthropic-ai/claude-agent-sdk`
