import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";

const MAX_FILE_BYTES = 320 * 1024 * 1024;

export interface PinnedFileRead {
  readonly bytes: Uint8Array;
  readonly identity: string;
  readonly contentHash: string;
}

interface DirectoryPin {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface CapturedFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

function toCapturedStat(stat: BigIntStats): CapturedFileStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameCapturedVersion(a: CapturedFileStat, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function captureAncestorPins(realRoot: string, relativeFile: string): Promise<DirectoryPin[] | undefined> {
  const parts = relativeFile.split(path.sep).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    return undefined;
  }
  const pins: DirectoryPin[] = [];
  let current = realRoot;
  const rootStat = await fs.lstat(current, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return undefined;
  }
  pins.push({ path: current, dev: rootStat.dev, ino: rootStat.ino });

  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i]!);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return undefined;
    }
    pins.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return pins;
}

async function verifyAncestorPins(pins: readonly DirectoryPin[]): Promise<boolean> {
  for (const pin of pins) {
    try {
      const stat = await fs.lstat(pin.path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== pin.dev || stat.ino !== pin.ino) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export async function readPinnedLocalFile(
  realRoot: string,
  realFile: string,
  maximum: number,
  isInvalid: () => boolean = () => false,
): Promise<PinnedFileRead | undefined> {
  if (isInvalid()) return undefined;
  const file = await PinnedLocalFile.open(realRoot, realFile, maximum, false);
  if (!file) return undefined;
  try {
    return isInvalid() ? undefined : file.read;
  } finally {
    await file.dispose();
  }
}

export class PinnedLocalFile {
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  public readonly read: PinnedFileRead;

  private constructor(
    private readonly handle: fs.FileHandle,
    private readonly realFile: string,
    private readonly ancestors: readonly DirectoryPin[],
    private captured: CapturedFileStat,
    read: PinnedFileRead,
  ) {
    this.read = read;
  }

  public static async open(
    realRoot: string,
    realFile: string,
    maximum: number,
    writable = false,
  ): Promise<PinnedLocalFile | undefined> {
    const relative = path.relative(realRoot, realFile);
    if (
      !path.isAbsolute(realRoot) ||
      !path.isAbsolute(realFile) ||
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      realRoot.includes("\0") ||
      relative.includes("\0") ||
      Buffer.byteLength(realRoot) >= 16_384 ||
      Buffer.byteLength(relative) >= 16_384 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0 ||
      maximum > MAX_FILE_BYTES
    ) {
      return undefined;
    }

    let handle: fs.FileHandle | undefined;
    try {
      const ancestors = await captureAncestorPins(realRoot, relative);
      if (!ancestors) return undefined;

      // Do not truncate or create anything at open. Validate the opened file
      // and its current name before reading, and keep using this descriptor.
      const flags = (writable ? fsConstants.O_RDWR : fsConstants.O_RDONLY) |
        fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0);
      handle = await fs.open(realFile, flags);

      const openedStat = await handle.stat({ bigint: true });
      const leafBefore = await fs.lstat(realFile, { bigint: true });
      if (
        !openedStat.isFile() ||
        !leafBefore.isFile() ||
        openedStat.size > BigInt(maximum) ||
        !sameCapturedVersion(toCapturedStat(openedStat), leafBefore) ||
        !(await verifyAncestorPins(ancestors))
      ) {
        await handle.close();
        return undefined;
      }

      const expectedLength = Number(openedStat.size);
      const buffer = Buffer.allocUnsafe(expectedLength + 1);
      let offset = 0;
      while (offset <= expectedLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== expectedLength) {
        await handle.close();
        return undefined;
      }

      const afterReadStat = await handle.stat({ bigint: true });
      const leafAfter = await fs.lstat(realFile, { bigint: true });
      if (
        leafAfter.isSymbolicLink() ||
        !leafAfter.isFile() ||
        !sameCapturedVersion(toCapturedStat(openedStat), afterReadStat) ||
        !sameCapturedVersion(toCapturedStat(openedStat), leafAfter) ||
        !(await verifyAncestorPins(ancestors))
      ) {
        await handle.close();
        return undefined;
      }

      const captured = toCapturedStat(afterReadStat);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, expectedLength);
      const identity = [
        ...ancestors.map((pin) => `${pin.dev}:${pin.ino}`),
        `${captured.dev}:${captured.ino}:${captured.birthtimeNs}:${captured.ctimeNs}:${captured.mtimeNs}:${captured.size}:${captured.nlink}`,
      ].join("/");
      const contentHash = createHash("sha256").update(bytes).digest("hex");

      return new PinnedLocalFile(handle, realFile, ancestors, captured, {
        bytes,
        identity,
        contentHash,
      });
    } catch {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      return undefined;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async checkCurrentUnlocked(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      if (!(await verifyAncestorPins(this.ancestors))) {
        return false;
      }
      const [leafStat, handleStat] = await Promise.all([
        fs.lstat(this.realFile, { bigint: true }),
        this.handle.stat({ bigint: true }),
      ]);
      if (leafStat.isSymbolicLink() || !leafStat.isFile() || !handleStat.isFile()) {
        return false;
      }
      return (
        sameCapturedVersion(this.captured, leafStat) &&
        sameCapturedVersion(this.captured, handleStat)
      );
    } catch {
      return false;
    }
  }

  public isCurrent(): Promise<boolean> {
    return this.serial(() => this.checkCurrentUnlocked());
  }

  /** false means authorization changed before any write. A thrown error may
   * mean a partial write; the existing protected-backup flow must retain it. */
  public writeConverted(bytes: Uint8Array): Promise<boolean> {
    return this.serial(async () => {
      if (this.disposed || bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error("Cannot start pinned file write.");
      }
      if (!(await this.checkCurrentUnlocked())) {
        return false;
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await this.handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesWritten <= 0) {
          throw new Error("Failed to complete write to pinned file.");
        }
        offset += bytesWritten;
      }
      await this.handle.truncate(bytes.byteLength);
      await this.handle.datasync();
      this.captured = toCapturedStat(await this.handle.stat({ bigint: true }));
      return true;
    });
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.serial(async () => {
      await this.handle.close().catch(() => undefined);
    });
  }
}
