import { createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  prepareEncodingConversion,
  type EncodingCodec,
  type PreparedEncodingConversion,
} from "./conversionCore.js";
import { ISO2022JP_ENCODING } from "./rules.js";

/** Creates a codec that wraps VS Code's built-in codec with read-only ISO-2022-JP decoding. */
export function createWorkspaceCodec(): EncodingCodec {
  return {
    decode: async (bytes, encoding) => {
      if (encoding.toLowerCase() === ISO2022JP_ENCODING) {
        return new TextDecoder("iso-2022-jp", { fatal: true }).decode(bytes);
      }
      return vscode.workspace.decode(bytes, { encoding });
    },
    encode: async (text, encoding) => {
      if (encoding.toLowerCase() === ISO2022JP_ENCODING) {
        throw new Error("ISO-2022-JP encoding is read-only");
      }
      return vscode.workspace.encode(text, { encoding });
    },
  };
}

export async function prepareConversion(
  original: Uint8Array,
  sourceEncoding: string,
  targetEncoding: string,
  isCancellationRequested: () => boolean = () => false,
  targetLineEnding?: "lf" | "crlf",
): Promise<PreparedEncodingConversion | undefined> {
  return prepareEncodingConversion(
    original,
    sourceEncoding,
    targetEncoding,
    createWorkspaceCodec(),
    isCancellationRequested,
    targetLineEnding,
  );
}

export function isDirty(...uris: readonly vscode.Uri[]): boolean {
  const keys = new Set(uris.map((uri) => uri.toString()));
  return vscode.workspace.textDocuments.some(
    (document) => keys.has(document.uri.toString()) && document.isDirty,
  );
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function reopenCleanDocument(uri: vscode.Uri, encoding: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
  if (open && !open.isDirty) {
    try {
      await vscode.workspace.openTextDocument(uri, { encoding });
    } catch {
      // The bytes are already converted; a concurrent edit may prevent reopening.
    }
  }
}
