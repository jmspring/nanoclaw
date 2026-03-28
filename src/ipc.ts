import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

export const IPC_MAX_FILE_SIZE = 1_048_576; // 1MB

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const processingDir = path.join(messagesDir, 'processing');
          fs.mkdirSync(processingDir, { recursive: true });
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            const processingPath = path.join(processingDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > IPC_MAX_FILE_SIZE) {
                logger.warn(
                  { file: filePath, size: stat.size },
                  'IPC file too large, skipping',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              // Atomic: rename before reading to prevent double-processing
              fs.renameSync(filePath, processingPath);
              const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(processingPath);
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              // Move from processing (or original) to errors
              const sourcePath = fs.existsSync(processingPath)
                ? processingPath
                : filePath;
              if (fs.existsSync(sourcePath)) {
                fs.renameSync(
                  sourcePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        }
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const processingDir = path.join(tasksDir, 'processing');
          fs.mkdirSync(processingDir, { recursive: true });
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            const processingPath = path.join(processingDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > IPC_MAX_FILE_SIZE) {
                logger.warn(
                  { file: filePath, size: stat.size },
                  'IPC file too large, skipping',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              // Atomic: rename before reading to prevent double-processing
              fs.renameSync(filePath, processingPath);
              const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(processingPath);
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              const sourcePath = fs.existsSync(processingPath)
                ? processingPath
                : filePath;
              if (fs.existsSync(sourcePath)) {
                fs.renameSync(
                  sourcePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        }
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For rollback_workspace
    snapshotName?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
            // eslint-disable-next-line no-catch-all/no-catch-all
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });

        // Create CLAUDE.md from template if it doesn't exist
        const groupDir = path.join(GROUPS_DIR, data.folder);
        fs.mkdirSync(groupDir, { recursive: true });
        const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
        if (!fs.existsSync(claudeMdPath)) {
          const template = `# ${data.name}\n\nGroup memory and instructions for ${data.name}.\n`;
          fs.writeFileSync(claudeMdPath, template);
        }
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'rollback_workspace': {
      // Jail-only: roll back a group's jail dataset to a snapshot
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized rollback_workspace attempt blocked',
        );
        break;
      }

      try {
        const { getRuntime } = await import('./container-runtime.js');
        if (getRuntime() !== 'jail') {
          logger.warn('rollback_workspace is only available on jail runtime');
          break;
        }

        const { rollbackToSnapshot, listSnapshots } =
          await import('./jail/snapshots.js');
        const { isJailRunning } = await import('./jail/lifecycle.js');
        const { getJailName } = await import('./jail/lifecycle.js');

        const targetGroup = data.groupFolder || sourceGroup;
        const jailName = getJailName(targetGroup);

        if (isJailRunning(jailName)) {
          logger.error(
            { jailName, targetGroup },
            'Cannot rollback: jail is still running',
          );
          break;
        }

        let snapshotName = data.snapshotName as string | undefined;
        if (!snapshotName) {
          const snapshots = await listSnapshots(targetGroup);
          if (snapshots.length === 0) {
            logger.warn({ targetGroup }, 'No snapshots available for rollback');
            break;
          }
          snapshotName = snapshots[snapshots.length - 1].name;
        }

        await rollbackToSnapshot(targetGroup, snapshotName);
        logger.info(
          { targetGroup, snapshot: snapshotName },
          'Workspace rollback completed via IPC',
        );
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error({ err }, 'rollback_workspace IPC command failed');
      }
      break;
    }

    case 'jail_reset': {
      // Reset (destroy) a persistent jail for a group
      try {
        const { getRuntime } = await import('./container-runtime.js');
        if (getRuntime() !== 'jail') {
          logger.warn('jail_reset is only available on jail runtime');
          break;
        }

        const targetGroup = data.groupFolder || sourceGroup;

        // Non-main groups can only reset their own jail
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized jail_reset attempt for another group',
          );
          break;
        }

        const { removePersistentJail, cleanupJail } =
          await import('./jail/lifecycle.js');
        removePersistentJail(targetGroup);
        await cleanupJail(targetGroup);
        logger.info({ targetGroup }, 'Jail reset completed via IPC');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error({ err }, 'jail_reset IPC command failed');
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
