import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { validStoredConversionSizes } from "./conversionCore.js";
import { isConversionBackupSessionPath } from "./localPathSafety.js";
import { readStableResource } from "./stableResourceRead.js";

export const LAST_BACKUP_KEY = "autoEncoding.lastConversionBackup";

export const PROTECTED_BACKUP_KEY = "autoEncoding.protectedConversionBackup";

export const EMPTY_WINDOW_ID_KEY = "autoEncoding.emptyWindowId";

const BACKUP_RECORD_LIMIT = 64 * 1024;
const MAX_EMPTY_WINDOW_SLOTS = 32;
const LAST_BACKUP_PREFIX = `${LAST_BACKUP_KEY}:`;
const PROTECTED_BACKUP_PREFIX = `${PROTECTED_BACKUP_KEY}:`;

const windowIdFallbacks = new WeakMap<object, string>();
const scopedGlobalStates = new WeakMap<object, vscode.Memento>();

function emptyWindowId(context: vscode.ExtensionContext): string {
  const identityTarget = (context.workspaceState ?? context) as object;
  const persisted = context.workspaceState?.get<unknown>(EMPTY_WINDOW_ID_KEY);
  if (typeof persisted === "string" && /^[0-9a-f-]{8,64}$/i.test(persisted)) {
    windowIdFallbacks.set(identityTarget, persisted);
    return persisted;
  }
  const existing = windowIdFallbacks.get(identityTarget);
  if (existing) {
    return existing;
  }
  const generated = randomUUID();
  windowIdFallbacks.set(identityTarget, generated);
  return generated;
}

/** Returns a window-isolated state store for conversion Undo pointers. */
export function activeConversionState(context: vscode.ExtensionContext): vscode.Memento {
  const hasWorkspace = (vscode.workspace?.workspaceFolders?.length ?? 0) > 0;
  if (hasWorkspace || !context.globalState) {
    return context.workspaceState;
  }
  const identityTarget = (context.workspaceState ?? context) as object;
  const cached = scopedGlobalStates.get(identityTarget);
  if (cached) {
    return cached;
  }
  const scoped: vscode.Memento = {
    keys: () => {
      const suffix = `:${emptyWindowId(context)}`;
      return (context.globalState.keys?.() ?? [])
        .filter((key) => key.endsWith(suffix))
        .map((key) => key.slice(0, -suffix.length));
    },
    get: <T>(key: string, defaultValue?: T): T => {
      const value = context.globalState.get<T>(`${key}:${emptyWindowId(context)}`);
      return (value === undefined ? defaultValue : value) as T;
    },
    update: async (key: string, value: unknown): Promise<void> => {
      const id = emptyWindowId(context);
      if (context.workspaceState && context.workspaceState.get<unknown>(EMPTY_WINDOW_ID_KEY) !== id) {
        try {
          await context.workspaceState.update(EMPTY_WINDOW_ID_KEY, id);
        } catch {
          // Keep in-memory window identity when workspaceState cannot persist.
        }
      }
      await context.globalState.update(`${key}:${id}`, value);
    },
  };
  scopedGlobalStates.set(identityTarget, scoped);
  return scoped;
}

/** Evicts excess unprotected empty-window Undo slots from globalState and backup storage. */
export async function pruneEmptyWindowBackups(context: vscode.ExtensionContext): Promise<void> {
  if (
    (vscode.workspace?.workspaceFolders?.length ?? 0) > 0 ||
    typeof context.globalState?.keys !== "function"
  ) {
    return;
  }
  const allLastKeys = context.globalState
    .keys()
    .filter((key) => key.startsWith(LAST_BACKUP_PREFIX));
  if (allLastKeys.length <= MAX_EMPTY_WINDOW_SLOTS) {
    return;
  }
  const currentId = emptyWindowId(context);
  const evictable: Array<{ readonly windowId: string; readonly session: string; readonly sortKey: string }> = [];
  for (const fullKey of allLastKeys) {
    const windowId = fullKey.slice(LAST_BACKUP_PREFIX.length);
    if (!windowId || windowId === currentId) {
      continue;
    }
    const session = context.globalState.get<unknown>(fullKey);
    if (typeof session !== "string" || session.length === 0) {
      continue;
    }
    const protectedSession = context.globalState.get<unknown>(
      `${PROTECTED_BACKUP_PREFIX}${windowId}`,
    );
    if (protectedSession === session) {
      continue;
    }
    let sortKey = session;
    try {
      sortKey = path.basename(vscode.Uri.parse(session).path);
    } catch {
      // Keep raw session string fallback for deterministic ordering.
    }
    evictable.push({ windowId, session, sortKey });
  }
  evictable.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  const excess = allLastKeys.length - MAX_EMPTY_WINDOW_SLOTS;
  for (const entry of evictable.slice(0, excess)) {
    await context.globalState.update(`${LAST_BACKUP_PREFIX}${entry.windowId}`, undefined);
    await deleteStoredBackupSession(context.globalStorageUri, entry.session);
  }
}

export interface BackupRecord {
  readonly version: 1;
  readonly originalUri: string;
  readonly resolvedUri: string;
  readonly conversionRootUri: string;
  readonly workspaceRootUri?: string;
  readonly standalone?: boolean;
  readonly relativePath: string;
  readonly backupFile: string;
  readonly originalHash: string;
  readonly convertedHash: string;
  readonly originalSize: number;
  readonly convertedSize: number;
  readonly recoveryRequired: boolean;
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
}

export async function isConversionBackupSession(root: vscode.Uri, candidate: vscode.Uri): Promise<boolean> {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) {
    return false;
  }
  if (root.scheme !== "file" && (root.scheme !== "vscode-userdata" || root.authority || vscode.env.remoteName)) return false;
  return isConversionBackupSessionPath(root.fsPath, candidate.fsPath);
}

export async function readBackupRecord(uri: vscode.Uri): Promise<BackupRecord | undefined> {
  const raw = await readBackupResource(uri, BACKUP_RECORD_LIMIT);
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  const standalone = candidate.standalone === true;
  if (
    candidate.version !== 1 ||
    typeof candidate.originalUri !== "string" ||
    typeof candidate.resolvedUri !== "string" ||
    typeof candidate.conversionRootUri !== "string" ||
    (candidate.standalone !== undefined && typeof candidate.standalone !== "boolean") ||
    (!standalone && typeof candidate.workspaceRootUri !== "string") ||
    (standalone &&
      candidate.workspaceRootUri !== undefined &&
      typeof candidate.workspaceRootUri !== "string") ||
    typeof candidate.relativePath !== "string" ||
    typeof candidate.backupFile !== "string" ||
    typeof candidate.originalHash !== "string" ||
    typeof candidate.convertedHash !== "string" ||
    typeof candidate.recoveryRequired !== "boolean" ||
    typeof candidate.sourceEncoding !== "string" ||
    typeof candidate.targetEncoding !== "string"
  ) {
    return undefined;
  }
  if (!validStoredConversionSizes(candidate.originalSize, candidate.convertedSize)) {
    return undefined;
  }
  return candidate as unknown as BackupRecord;
}

/** Native VS Code can expose its local profile storage as vscode-userdata. */
export async function readBackupResource(
  uri: vscode.Uri,
  maxSize: number,
): ReturnType<typeof readStableResource> {
  const localUri = uri.scheme === "vscode-userdata" && !uri.authority && !vscode.env.remoteName
    ? uri.with({ scheme: "file" })
    : uri;
  // Keep bounded, no-follow reads; never map remote/provider paths to local disk.
  return readStableResource(localUri, maxSize, () => false);
}

export async function writeJsonAtomic(uri: vscode.Uri, value: unknown): Promise<void> {
  const temporaryUri = uri.with({ path: `${uri.path}.${randomUUID()}.tmp` });
  try {
    await vscode.workspace.fs.writeFile(
      temporaryUri,
      new TextEncoder().encode(JSON.stringify(value, undefined, 2)),
    );
    await vscode.workspace.fs.rename(temporaryUri, uri, { overwrite: true });
  } finally {
    await deleteIfPresent(temporaryUri);
  }
}

export async function deleteStoredBackupSession(
  storageRoot: vscode.Uri,
  stored: string | undefined,
): Promise<void> {
  if (!stored) {
    return;
  }
  const uri = vscode.Uri.parse(stored);
  if (await isConversionBackupSession(storageRoot, uri)) {
    await deleteIfPresent(uri, true);
  }
}

export async function deleteIfPresent(uri: vscode.Uri, recursive = false): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive });
  } catch {
    // A missing or already-cleaned temporary backup needs no further action.
  }
}
