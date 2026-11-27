import type * as vscode from "vscode";
import {
  StableLocalFileRead,
  localFileStillMatches,
  readStableLocalFile,
  statLocalFileVersion,
} from "./boundedFileRead.js";

export interface StableResourceRead {
  readonly bytes: Uint8Array;
  readonly mtime: number;
  readonly size: number;
  readonly localFile?: StableLocalFileRead;
}

export async function readStableResource(
  uri: vscode.Uri,
  maxSize: number,
  isDirty: () => boolean,
  isCancellationRequested: () => boolean = () => false,
): Promise<StableResourceRead | undefined> {
  if (isDirty() || isCancellationRequested()) {
    return undefined;
  }
  if (uri.scheme !== "file") {
    return undefined;
  }
  const localFile = await readStableLocalFile(
    uri.fsPath,
    maxSize,
    isCancellationRequested,
  );
  return !localFile || isDirty()
    ? undefined
    : {
      bytes: localFile.bytes,
      mtime: localFile.mtimeMs,
      size: localFile.size,
      localFile,
    };
}

export async function resourceStillMatchesRead(
  uri: vscode.Uri,
  maxSize: number,
  read: StableResourceRead,
  isDirty: () => boolean,
): Promise<boolean> {
  if (isDirty()) {
    return false;
  }
  if (uri.scheme !== "file" || !read.localFile) {
    return false;
  }
  return (
    await localFileStillMatches(uri.fsPath, read.localFile, maxSize)
  ) && !isDirty();
}

/** Returns a lightweight metadata token for display-only cache lookups without reading full file bytes. */
export async function statResourceVersion(
  uri: vscode.Uri,
  maxSize: number,
  isDirty: () => boolean,
): Promise<string | undefined> {
  if (isDirty() || uri.scheme !== "file") {
    return undefined;
  }
  const version = await statLocalFileVersion(uri.fsPath, maxSize);
  if (!version || isDirty()) {
    return undefined;
  }
  return `file-stat:${version}`;
}

/** Builds the matching lightweight metadata token from an already-completed `StableResourceRead`. */
export function statTokenFromStableRead(read: StableResourceRead): string | undefined {
  if (!read.localFile) {
    return undefined;
  }
  const f = read.localFile;
  return `file-stat:${f.device}:${f.inode}:${f.size}:${f.mtimeMs}:${f.ctimeMs}`;
}
