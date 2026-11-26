import * as path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

export async function resolveRealDirectory(
  directoryPath: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(directoryPath);
    return (await stat(resolved)).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveRealPathWithin(
  realRootPath: string,
  candidatePath: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidatePath);
    return isPathWithin(realRootPath, resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves a standalone local file's canonical parent directory and path while rejecting leaf symlinks. */
export async function resolveStandaloneRegularFile(
  filePath: string,
): Promise<{ readonly parentRealPath: string; readonly fileRealPath: string } | undefined> {
  if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
    return undefined;
  }
  try {
    const beforeStat = await lstat(filePath, { bigint: true });
    if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
      return undefined;
    }
    const parentRealPath = await resolveRealDirectory(path.dirname(filePath));
    if (!parentRealPath) {
      return undefined;
    }
    const fileRealPath = await resolveRealPathWithin(parentRealPath, filePath);
    if (!fileRealPath || path.dirname(fileRealPath) !== parentRealPath) {
      return undefined;
    }
    const afterStat = await lstat(fileRealPath, { bigint: true });
    if (
      afterStat.isSymbolicLink() ||
      !afterStat.isFile() ||
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino
    ) {
      return undefined;
    }
    return { parentRealPath, fileRealPath };
  } catch {
    return undefined;
  }
}

export async function resolveMissingRecoveryPath(
  realRootPath: string,
  originalPath: string,
  expectedResolvedPath: string,
): Promise<string | undefined> {
  if (!path.isAbsolute(expectedResolvedPath)) {
    return undefined;
  }
  let originalParent: string;
  let expectedParent: string;
  try {
    [originalParent, expectedParent] = await Promise.all([
      realpath(path.dirname(originalPath)),
      realpath(path.dirname(expectedResolvedPath)),
    ]);
  } catch {
    return undefined;
  }
  const originalDestination = path.resolve(originalParent, path.basename(originalPath));
  const expectedDestination = path.resolve(
    expectedParent,
    path.basename(expectedResolvedPath),
  );
  if (
    originalDestination !== expectedDestination ||
    !isPathWithin(realRootPath, expectedDestination)
  ) {
    return undefined;
  }
  try {
    await lstat(expectedDestination);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? path.resolve(expectedResolvedPath)
      : undefined;
  }
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export async function isConversionBackupSessionPath(
  storageRootPath: string,
  candidatePath: string,
): Promise<boolean> {
  const backupRoot = path.resolve(storageRootPath, "conversion-backups");
  const candidate = path.resolve(candidatePath);
  const validShape = (
    path.dirname(candidate) === backupRoot &&
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path.basename(candidate),
    )
  );
  if (!validShape) return false;
  try {
    const realStorage = await realpath(storageRootPath);
    const [parentStat, candidateStat, realParent, realCandidate] = await Promise.all([
      lstat(backupRoot), lstat(candidate), realpath(backupRoot), realpath(candidate),
    ]);
    return parentStat.isDirectory() && !parentStat.isSymbolicLink() &&
      candidateStat.isDirectory() && !candidateStat.isSymbolicLink() &&
      realParent === path.join(realStorage, "conversion-backups") &&
      path.dirname(realCandidate) === realParent;
  } catch {
    return false;
  }
}
