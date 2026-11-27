// Folder candidate scanning for batch encoding and line-ending conversion.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { assessEncodingConversion } from "./conversionCore.js";
import { isDirty, hashBytes } from "./conversionResources.js";
import { ENCODINGS, encodingInfo } from "./rules.js";
import { readPinnedLocalFile } from "./pinnedLocalFile.js";
import { resolveRealPathWithin } from "./localPathSafety.js";
import { classifyEncoding, classifyLineEndings } from "./scanCore.js";
import { compileGlob } from "./boundedGlob.js";
import { DirectoryScanCursor } from "./directoryScanCursor.js";
import {
  AUTO_SOURCE,
  type ConversionCandidate,
  formatLineEndingSummary,
  previewText,
  resolveAutoSourceEncoding,
  skipReasonLabel,
  vscodeCodec,
} from "./conversionPrompts.js";

export interface FolderScanResult {
  readonly candidates: ConversionCandidate[];
  readonly excluded: vscode.QuickPickItem[];
  readonly ambiguousCount: number;
  readonly cancelled: boolean;
  readonly exceededLimit: boolean;
}

/** Scans a folder under size/count bounds and collects convertible candidates with exclusion reasons. */
export async function scanFolderConversionCandidates(options: {
  readonly folderUri: vscode.Uri;
  readonly folderRealPath: string;
  readonly workspaceRootRealPath: string;
  readonly maxFiles: number;
  readonly maxFileSize: number;
  readonly autoDetectEncodings: readonly string[];
  readonly exclusion: ReturnType<typeof compileGlob>;
  readonly selectedSource: string;
  readonly requestedTarget?: string;
  readonly targetLineEnding?: "lf" | "crlf";
  readonly expectedEncodingFor: (uri: vscode.Uri) => string | undefined;
}): Promise<FolderScanResult> {
  const {
    folderUri,
    folderRealPath,
    workspaceRootRealPath,
    maxFiles,
    maxFileSize,
    autoDetectEncodings,
    exclusion,
    selectedSource,
    requestedTarget,
    targetLineEnding,
    expectedEncodingFor,
  } = options;
  const convertingEncoding = Boolean(requestedTarget);
  const folderRuleEncoding = expectedEncodingFor(
    vscode.Uri.joinPath(folderUri, "__auto_encoding_probe__"),
  )?.toLowerCase();
  const excluded: vscode.QuickPickItem[] = [];
  let ambiguousCount = 0;
  const recordExcluded = (uri: vscode.Uri, reason: string): void => {
    excluded.push({
      label: path.relative(folderUri.fsPath, uri.fsPath).replaceAll(path.sep, "/"),
      description: reason,
    });
  };
  const scanTitle =
    selectedSource === AUTO_SOURCE
      ? t("Scanning files with auto-detection")
      : t("Scanning files as {0}", encodingInfo(selectedSource).label);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: scanTitle,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: t("Listing target files") });
      let uris: readonly vscode.Uri[];
      try {
        const cursor = new DirectoryScanCursor(folderUri.fsPath, (candidate, directory) => {
          const relative = path.relative(folderUri.fsPath, candidate).replaceAll(path.sep, "/");
          return exclusion.match(relative) || (directory && exclusion.match(`${relative}/`));
        });
        const foundUris: vscode.Uri[] = [];
        try {
          while (foundUris.length <= maxFiles && !token.isCancellationRequested) {
            const page = await cursor.peek(
              Math.min(500, maxFiles + 1 - foundUris.length),
              () => token.isCancellationRequested,
            );
            if (page.unreadable.length) throw new Error(t("Could not read target folder."));
            foundUris.push(...page.paths.map((name) => vscode.Uri.file(name)));
            cursor.commit(page.paths.length);
            if (page.complete) break;
          }
          uris = foundUris;
        } finally {
          await cursor.dispose();
        }
      } catch (error) {
        if (token.isCancellationRequested) {
          return { candidates: [], excluded, ambiguousCount, cancelled: true, exceededLimit: false };
        }
        throw error;
      }
      if (token.isCancellationRequested) {
        return { candidates: [], excluded, ambiguousCount, cancelled: true, exceededLimit: false };
      }
      if (uris.length > maxFiles) {
        return { candidates: [], excluded, ambiguousCount, cancelled: false, exceededLimit: true };
      }
      const found: ConversionCandidate[] = [];
      for (const [index, uri] of uris.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({
          increment: uris.length === 0 ? 100 : 100 / uris.length,
          message: `${index + 1}/${uris.length}`,
        });
        const resolvedPath = await resolveRealPathWithin(folderRealPath, uri.fsPath);
        if (!resolvedPath) {
          recordExcluded(uri, t("Outside target scope or path could not be verified"));
          continue;
        }
        const writeUri = vscode.Uri.file(resolvedPath);
        if (isDirty(uri, writeUri)) {
          recordExcluded(uri, t("Has unsaved changes"));
          continue;
        }
        const fileRuleEncoding = expectedEncodingFor(uri)?.toLowerCase();
        const isConflictingChildRule = Boolean(
          fileRuleEncoding &&
          requestedTarget &&
          fileRuleEncoding !== requestedTarget &&
          fileRuleEncoding !== folderRuleEncoding,
        );
        if (convertingEncoding && isConflictingChildRule) {
          recordExcluded(uri, t("A different encoding rule applies"));
          continue;
        }
        try {
          const info = await vscode.workspace.fs.stat(writeUri);
          if (info.size > maxFileSize) {
            recordExcluded(uri, t("Exceeds file size limit"));
            continue;
          }
          const read = await readPinnedLocalFile(
            workspaceRootRealPath,
            writeUri.fsPath,
            maxFileSize,
            () => isDirty(uri, writeUri) || token.isCancellationRequested,
          );
          if (!read) {
            recordExcluded(uri, t("Unchecked (modifying or unreadable)"));
            continue;
          }
          const original = read.bytes;
          let fileSourceEncoding: string;
          let needsConfirmation = false;
          if (selectedSource === AUTO_SOURCE) {
            const autoClassification = await classifyEncoding(original, "utf8", vscodeCodec, {
              alternativeEncodings: autoDetectEncodings,
              allowNonCanonicalShiftJis: true,
              isCancellationRequested: () => token.isCancellationRequested,
            });
            if (token.isCancellationRequested) break;
            const resolved = await resolveAutoSourceEncoding(original, autoClassification, {
              convertingEncoding,
              fileRuleEncoding,
              manualOverride: false,
              allowRuleDisambiguation: true,
              isCancellationRequested: () => token.isCancellationRequested,
            });
            if (resolved.kind === "binary") {
              recordExcluded(uri, skipReasonLabel("binary"));
              continue;
            }
            if (resolved.kind === "ambiguous") {
              ambiguousCount += 1;
              recordExcluded(uri, t("Encoding could not be uniquely identified"));
              continue;
            }
            fileSourceEncoding = resolved.encoding;
          } else {
            fileSourceEncoding = selectedSource;
          }
          const fileTargetEncoding = requestedTarget ?? fileSourceEncoding;
          const assessment = await assessEncodingConversion(
            original,
            fileSourceEncoding,
            fileTargetEncoding,
            vscodeCodec,
            () => token.isCancellationRequested,
            targetLineEnding,
          );
          if (assessment.kind === "skipped") {
            recordExcluded(uri, skipReasonLabel(assessment.reason));
            continue;
          }
          const prepared = assessment.prepared;
          if (selectedSource !== AUTO_SOURCE) {
            const useAllEncodings =
              selectedSource === "windows1252" || selectedSource === "iso88591";
            const classification = await classifyEncoding(original, selectedSource, vscodeCodec, {
              isCancellationRequested: () => token.isCancellationRequested,
              allowNonCanonicalShiftJis: true,
              ...(useAllEncodings
                ? {
                    alternativeEncodings: ENCODINGS.map((encoding) => encoding.id).filter(
                      (encoding) => encoding !== selectedSource,
                    ),
                  }
                : {}),
            });
            needsConfirmation =
              classification.kind !== "match" && classification.kind !== "ascii";
          }
          const beforeEol = classifyLineEndings(original, fileSourceEncoding);
          const eolLabel = formatLineEndingSummary(beforeEol);
          const relativePath = path
            .relative(folderUri.fsPath, uri.fsPath)
            .replaceAll(path.sep, "/");
          found.push({
            uri,
            writeUri,
            relativePath,
            sourceEncoding: fileSourceEncoding,
            targetEncoding: fileTargetEncoding,
            originalHash: hashBytes(original),
            originalSize: original.byteLength,
            originalIdentity: read.identity,
            maxSize: maxFileSize,
            conversionRootRealPath: folderRealPath,
            workspaceRootRealPath,
            needsConfirmation,
            label: relativePath,
            description: `${needsConfirmation ? `${t("Review required (uncertain encoding)")} · ` : ""}${encodingInfo(fileSourceEncoding).label} → ${encodingInfo(fileTargetEncoding).label} / ${eolLabel} → ${targetLineEnding?.toUpperCase() ?? eolLabel}`,
            detail: previewText(prepared.text),
            picked: !needsConfirmation,
          });
        } catch {
          recordExcluded(uri, t("Failed to read or inspect"));
        }
      }
      return {
        candidates: found,
        excluded,
        ambiguousCount,
        cancelled: token.isCancellationRequested,
        exceededLimit: false,
      };
    },
  );
}
