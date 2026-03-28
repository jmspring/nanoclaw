/**
 * Capsicum Capability-Mode Sandboxing for FreeBSD
 *
 * Design choice: Stub implementation with documented full-implementation path.
 *
 * Capsicum requires calling FreeBSD-specific C APIs (cap_enter, cap_rights_limit)
 * from Node.js. The recommended full implementation is a Node.js N-API native addon
 * (Option A from the design document) because:
 * - N-API provides ABI stability across Node.js versions
 * - cap_rights_limit() uses a complex struct (cap_rights_t) that FFI libraries
 *   struggle with
 * - The addon only needs to expose two functions, keeping build complexity minimal
 *
 * Full implementation would involve:
 * 1. native/capsicum/binding.gyp — node-gyp build configuration
 * 2. native/capsicum/capsicum.cc — N-API addon calling cap_rights_init/cap_rights_limit
 * 3. Listed as optionalDependency in package.json so non-FreeBSD installs succeed
 *
 * For now, these stubs allow the rest of the codebase to integrate Capsicum checks
 * without blocking on native addon development. When the addon is built, only this
 * file needs to change.
 */
import os from 'os';

import { logger } from './logger.js';

/** Capsicum capability rights for socket operations */
export const SOCKET_RIGHTS = [
  'CAP_ACCEPT',
  'CAP_EVENT',
  'CAP_READ',
  'CAP_WRITE',
  'CAP_SHUTDOWN',
  'CAP_GETPEERNAME',
  'CAP_GETSOCKNAME',
  'CAP_GETSOCKOPT',
  'CAP_SETSOCKOPT',
];

/**
 * Check if Capsicum is available on this system.
 *
 * Returns true only on FreeBSD when the native addon is built and loaded.
 * Currently always returns false (stub) since the native addon is not yet built.
 */
export function isCapsicumAvailable(): boolean {
  if (os.platform() !== 'freebsd') {
    return false;
  }

  // Stub: native addon not yet built
  // Full implementation would try: require('./native/capsicum/build/Release/capsicum.node')
  logger.debug(
    'Capsicum: native addon not built, capability restriction unavailable',
  );
  return false;
}

/**
 * Restrict a file descriptor's capabilities using cap_rights_limit().
 *
 * @param fd - File descriptor number to restrict
 * @param rights - Array of Capsicum right names (e.g., 'CAP_READ', 'CAP_WRITE')
 * @returns true on success, false on failure or when Capsicum is unavailable
 */
export function capRightsLimit(fd: number, rights: string[]): boolean {
  if (!isCapsicumAvailable()) {
    logger.debug(
      { fd, rights },
      'Capsicum not available, skipping capability restriction',
    );
    return false;
  }

  // Stub: would call native addon's capRightsLimit(fd, rights)
  // The native addon would:
  // 1. Initialize cap_rights_t via cap_rights_init()
  // 2. Set requested rights via cap_rights_set()
  // 3. Apply via cap_rights_limit(fd, &rights)
  logger.info(
    { fd, rights },
    'Capsicum: would restrict fd capabilities (stub)',
  );
  return false;
}

/**
 * Enter Capsicum capability mode (cap_enter).
 *
 * WARNING: This is a one-way operation. The process can NEVER leave capability mode.
 * DO NOT call this from the main NanoClaw process — it would sandbox the entire
 * orchestrator. This is exported for documentation and potential future use in
 * child processes only.
 *
 * @returns true on success, false on failure or when Capsicum is unavailable
 */
export function capEnter(): boolean {
  if (!isCapsicumAvailable()) {
    return false;
  }

  // Stub: would call native addon's capEnter()
  logger.warn('Capsicum: cap_enter() called (stub — no-op)');
  return false;
}
