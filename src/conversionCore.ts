import { ISO2022JP_ENCODING } from "./rules.js";

export interface PreparedEncodingConversion {
  readonly text: string;
  readonly converted: Uint8Array;
}

export const MAX_CONVERSION_BACKUP_BYTES = 512 * 1024 * 1024;
export const MAX_STORED_BACKUP_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_STORED_CONVERTED_FILE_BYTES = 320 * 1024 * 1024;

export function protectedConversionSession(
  lastSession: unknown,
  protectedSession: unknown,
): string | undefined {
  return typeof lastSession === "string" &&
    lastSession.length > 0 &&
    lastSession === protectedSession
    ? lastSession
    : undefined;
}

export function conversionSelectionBackupBytes(
  sizes: readonly number[],
  maximum = MAX_CONVERSION_BACKUP_BYTES,
): number | undefined {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    return undefined;
  }
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum - total) {
      return undefined;
    }
    total += size;
  }
  return total;
}

export function validStoredConversionSizes(
  originalSize: unknown,
  convertedSize: unknown,
): boolean {
  if (originalSize === undefined && convertedSize === undefined) {
    return true;
  }
  return (
    Number.isSafeInteger(originalSize) &&
    (originalSize as number) >= 0 &&
    (originalSize as number) <= MAX_STORED_BACKUP_FILE_BYTES &&
    Number.isSafeInteger(convertedSize) &&
    (convertedSize as number) >= 0 &&
    (convertedSize as number) <= MAX_STORED_CONVERTED_FILE_BYTES
  );
}

export interface EncodingCodec {
  decode(bytes: Uint8Array, encoding: string): Promise<string>;
  encode(text: string, encoding: string): Promise<Uint8Array>;
}

export function conversionBackupReadLimit(
  originalSize: number | undefined,
  convertedSize: number | undefined,
  legacyLimit: number,
): number {
  return originalSize !== undefined && convertedSize !== undefined
    ? Math.max(originalSize, convertedSize)
    : legacyLimit;
}

export interface ConversionWriteSteps {
  readonly writeBackup: () => Promise<void>;
  readonly writeRecord: () => Promise<void>;
  readonly isCurrent: () => Promise<boolean>;
  readonly registerBackup: () => Promise<void>;
  readonly markTargetStarted?: () => Promise<void>;
  readonly writeTarget: () => Promise<void | boolean>;
  readonly markTargetCompleted?: () => Promise<void>;
  readonly recoverTarget: () => Promise<void>;
  readonly cleanupBackup: () => Promise<void>;
}

export class ConversionTargetWriteError extends Error {
  public constructor(
    cause: unknown,
    public readonly recoveryFailed: boolean,
  ) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
    this.name = "ConversionTargetWriteError";
  }
}

export class ConversionOperationGate {
  private busy = false;

  public enter(): (() => void) | undefined {
    if (this.busy) {
      return undefined;
    }
    this.busy = true;
    return () => {
      this.busy = false;
    };
  }
}

export type ConversionBackupDisposition =
  | "keepNewAndDeletePrevious"
  | "keepNewForRecovery"
  | "restorePreviousAndDeleteNew"
  | "deleteUnusedNew";

export function conversionBackupDisposition(
  convertedCount: number,
  recoveryRequired: boolean,
  backupRegistered: boolean,
): ConversionBackupDisposition {
  if (convertedCount > 0) {
    return "keepNewAndDeletePrevious";
  }
  if (recoveryRequired) {
    return "keepNewForRecovery";
  }
  return backupRegistered
    ? "restorePreviousAndDeleteNew"
    : "deleteUnusedNew";
}

export async function writeConversionIfCurrent(
  steps: ConversionWriteSteps,
): Promise<boolean> {
  try {
    await steps.writeBackup();
    if (!(await steps.isCurrent())) {
      await steps.cleanupBackup();
      return false;
    }
    await steps.writeRecord();
    if (!(await steps.isCurrent())) {
      await steps.cleanupBackup();
      return false;
    }
    await steps.registerBackup();
  } catch (error) {
    await steps.cleanupBackup();
    throw error;
  }
  let targetWriteAttempted = false;
  try {
    await steps.markTargetStarted?.();
    if (!(await steps.isCurrent())) {
      await steps.markTargetCompleted?.();
      await steps.cleanupBackup();
      return false;
    }
    targetWriteAttempted = true;
    if (await steps.writeTarget() === false) {
      targetWriteAttempted = false;
      await steps.markTargetCompleted?.();
      await steps.cleanupBackup();
      return false;
    }
    await steps.markTargetCompleted?.();
  } catch (error) {
    if (!targetWriteAttempted) {
      await steps.markTargetCompleted?.();
      await steps.cleanupBackup();
      throw error;
    }
    let recoveryFailed = false;
    try {
      await steps.recoverTarget();
      await steps.markTargetCompleted?.();
    } catch {
      // Keep the registered backup available when immediate recovery also fails.
      recoveryFailed = true;
    }
    throw new ConversionTargetWriteError(error, recoveryFailed);
  }
  return true;
}

export type ConversionSkipReason = "cancelled" | "binary" | "sourceMismatch" | "unchanged" | "targetMismatch";
export type ConversionAssessment =
  | { readonly kind: "ready"; readonly prepared: PreparedEncodingConversion }
  | { readonly kind: "skipped"; readonly reason: ConversionSkipReason; readonly error?: unknown };

export async function prepareEncodingConversion(
  original: Uint8Array,
  sourceEncoding: string,
  targetEncoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean = () => false,
  targetLineEnding?: "lf" | "crlf",
): Promise<PreparedEncodingConversion | undefined> {
  const result = await assessEncodingConversion(original, sourceEncoding, targetEncoding, codec, isCancellationRequested, targetLineEnding);
  if (result.kind === "ready") return result.prepared;
  if ("error" in result) throw result.error;
  return undefined;
}

export async function assessEncodingConversion(
  original: Uint8Array,
  sourceEncoding: string,
  targetEncoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean = () => false,
  targetLineEnding?: "lf" | "crlf",
): Promise<ConversionAssessment> {
  const skipped = (reason: ConversionSkipReason): ConversionAssessment => ({ kind: "skipped", reason });
  if (isCancellationRequested()) return skipped("cancelled");
  if (targetEncoding.toLowerCase() === ISO2022JP_ENCODING) {
    return skipped("targetMismatch");
  }
  const isIso2022JpSource = sourceEncoding.toLowerCase() === ISO2022JP_ENCODING;
  let text: string;
  try {
    text = await codec.decode(original, sourceEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    if (looksLikeBinary(text)) return skipped("binary");
    if (isIso2022JpSource) {
      if (text.includes("\uFFFD") || !strictIso2022JpMatches(original, text)) {
        return skipped("sourceMismatch");
      }
    } else {
      const sourceRoundTrip = await codec.encode(text, sourceEncoding);
      if (isCancellationRequested()) return skipped("cancelled");
      if (
        !bytesEqual(sourceRoundTrip, original) &&
        !(sourceEncoding === "shiftjis" && !text.includes("\uFFFD") && strictShiftJisMatches(original, text))
      ) {
        return skipped("sourceMismatch");
      }
    }
  } catch (error) {
    return { kind: "skipped", reason: "sourceMismatch", error };
  }
  const targetText = targetLineEnding
    ? text.replace(/\r\n|\r|\n/g, targetLineEnding === "lf" ? "\n" : "\r\n") : text;
  if (sourceEncoding === "shiftjis" && targetEncoding === "shiftjis") {
    if (!targetLineEnding) return skipped("unchanged");
    try {
      const converted = replaceShiftJisLineEndings(original, targetLineEnding);
      if (isCancellationRequested()) return skipped("cancelled");
      if (bytesEqual(converted, original)) return skipped("unchanged");
      const targetRoundTrip = await codec.decode(converted, targetEncoding);
      if (isCancellationRequested()) return skipped("cancelled");
      return targetRoundTrip === targetText && !targetRoundTrip.includes("\uFFFD") && strictShiftJisMatches(converted, targetText)
        ? { kind: "ready", prepared: { text, converted } }
        : skipped("targetMismatch");
    } catch (error) {
      return { kind: "skipped", reason: "targetMismatch", error };
    }
  }
  try {
    const converted = await codec.encode(targetText, targetEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    if (bytesEqual(converted, original)) return skipped("unchanged");
    const targetRoundTrip = await codec.decode(converted, targetEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    return targetRoundTrip === targetText ? { kind: "ready", prepared: { text, converted } } : skipped("targetMismatch");
  } catch (error) {
    return { kind: "skipped", reason: "targetMismatch", error };
  }
}

function strictShiftJisMatches(bytes: Uint8Array, expectedText: string): boolean {
  try {
    return new TextDecoder("shift_jis", { fatal: true }).decode(bytes) === expectedText;
  } catch {
    return false;
  }
}

function strictIso2022JpMatches(bytes: Uint8Array, expectedText: string): boolean {
  try {
    return new TextDecoder("iso-2022-jp", { fatal: true }).decode(bytes) === expectedText;
  } catch {
    return false;
  }
}

function replaceShiftJisLineEndings(
  bytes: Uint8Array,
  targetLineEnding: "lf" | "crlf",
): Uint8Array {
  const newline = targetLineEnding === "lf" ? new Uint8Array([0x0a]) : new Uint8Array([0x0d, 0x0a]);
  const chunks: Uint8Array[] = [];
  let spanStart = 0;
  let totalLength = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) && index + 1 < bytes.length) {
      index += 1;
      continue;
    }
    if (byte !== 0x0d && byte !== 0x0a) continue;
    if (index > spanStart) {
      const unchanged = bytes.subarray(spanStart, index);
      chunks.push(unchanged);
      totalLength += unchanged.byteLength;
    }
    chunks.push(newline);
    totalLength += newline.byteLength;
    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      index += 1;
    }
    spanStart = index + 1;
  }
  if (spanStart === 0) return bytes;
  if (spanStart < bytes.length) {
    const tail = bytes.subarray(spanStart);
    chunks.push(tail);
    totalLength += tail.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function looksLikeBinary(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let controls = 0;
  const sampleLength = Math.min(text.length, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      return true;
    }
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      controls += 1;
    }
  }
  return controls / sampleLength > 0.02;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
