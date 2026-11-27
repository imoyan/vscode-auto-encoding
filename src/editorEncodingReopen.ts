// Display-only encoding reopening and Git/Multi-Diff comparison alignment.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { isReopenableEncoding } from "./rules.js";
import { type RuleMatch, configurationFor, fileUriForResource } from "./workspaceRules.js";
import {
  DIRTY_MESSAGE,
  MAX_MULTI_DIFF_ENTRIES,
  UNCONFIRMED_RULE_MESSAGE,
  type ActiveComparison,
  type ActiveSingleGit,
  type EncodingBasis,
  type SideResolution,
  activeComparison,
  activeMultiDiffComparisons,
  activeSingleGit,
  autoDetectedUris,
  beginOpeningDocument,
  clearAutoReopenFailure,
  clearFileEncodingInspection,
  comparisonLabel,
  endOpeningDocument,
  findDocument,
  guessedUris,
  hasAutoReopenFailed,
  involves,
  isReopenableScheme,
  manualSides,
  markAutoReopenFailed,
  openingDocuments,
  pendingAlignHints,
  sameEncoding,
  setBounded,
} from "./editorEncodingState.js";
import {
  canReopenWithDetectedEncoding,
  canReopenWithRule,
  inspectFileDocument,
  resolveComparisonSides,
  resolveSingleSide,
} from "./editorEncodingDetection.js";

export function isInAutoAlignedComparison(document: vscode.TextDocument): boolean {
  const multiDiffs = activeMultiDiffComparisons();
  if (multiDiffs.length > 0) {
    return multiDiffs.some(
      (comparison) =>
        autoAlignEnabled(comparison) &&
        [comparison.original, comparison.modified].some(
          (uri) => uri.toString() === document.uri.toString(),
        ),
    );
  }
  const comparison = activeComparison();
  return (
    !!comparison &&
    autoAlignEnabled(comparison) &&
    [comparison.original, comparison.modified].some(
      (uri) => uri.toString() === document.uri.toString(),
    )
  );
}

function autoAlignSingleEnabled(uri: vscode.Uri): boolean {
  return (
    uri.scheme === "git" &&
    configurationFor(fileUriForResource(uri)).get<boolean>("autoReopenGitComparison", true)
  );
}

function autoAlignEnabled(comparison: ActiveComparison): boolean {
  const schemes = [comparison.original.scheme, comparison.modified.scheme];
  const hasGit = schemes.includes("git");
  const hasReopenable = schemes.some((scheme) => isReopenableScheme(scheme));
  const hasVirtualPairedWithFile =
    schemes.includes("file") && schemes.some((scheme) => !isReopenableScheme(scheme));
  if (!hasReopenable) return false;
  if (!hasGit && !comparison.multiDiff && !hasVirtualPairedWithFile) return false;
  const scopeUri =
    comparison.modified.scheme === "file" || comparison.modified.scheme === "git"
      ? fileUriForResource(comparison.modified)
      : fileUriForResource(comparison.original);
  return configurationFor(scopeUri).get<boolean>("autoReopenGitComparison", true);
}

function visibleEmbeddedGitComparisons(
  hintUris: readonly vscode.Uri[] = [],
): readonly ActiveComparison[] {
  const seen = new Set<string>();
  const comparisons: ActiveComparison[] = [];
  const pushGitUri = (gitUri: vscode.Uri): void => {
    if (gitUri.scheme !== "git" || comparisons.length >= MAX_MULTI_DIFF_ENTRIES) return;
    const key = gitUri.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const fileUri = fileUriForResource(gitUri);
    comparisons.push({
      original: gitUri,
      modified: fileUri,
      preview: false,
      multiDiff: true,
    });
  };
  for (const hintUri of hintUris) {
    if (hintUri.scheme === "git") {
      pushGitUri(hintUri);
    }
  }
  for (const editor of vscode.window.visibleTextEditors ?? []) {
    if (editor.document.uri.scheme === "git") {
      pushGitUri(editor.document.uri);
    }
  }
  return comparisons;
}

let aligning = false;
let alignAgain = false;

/** Keeps active Git/Multi-Diff comparisons, embedded diff views, and single Git views in the expected or detected encoding (display only, never saves). */
export async function alignActiveComparison(hintUri?: vscode.Uri): Promise<boolean> {
  if (hintUri?.scheme === "git") {
    const key = hintUri.toString();
    if (pendingAlignHints.has(key)) pendingAlignHints.delete(key);
    else if (pendingAlignHints.size >= MAX_MULTI_DIFF_ENTRIES) {
      const oldest = pendingAlignHints.keys().next().value;
      if (oldest !== undefined) pendingAlignHints.delete(oldest);
    }
    pendingAlignHints.set(key, hintUri);
  }
  if (aligning) {
    alignAgain = true;
    return false;
  }
  aligning = true;
  let changed = false;
  try {
    do {
      alignAgain = false;
      const currentHints = [...pendingAlignHints.values()];
      pendingAlignHints.clear();
      const multiDiffs = activeMultiDiffComparisons();
      if (multiDiffs.length > 0) {
        const focused = activeComparison();
        const visibleUris = new Set(
          (vscode.window.visibleTextEditors ?? []).map((editor) => editor.document.uri.toString()),
        );
        const prioritized = [...multiDiffs].sort((a, b) => {
          const rank = (entry: ActiveComparison): number => {
            if (
              focused &&
              entry.original.toString() === focused.original.toString() &&
              entry.modified.toString() === focused.modified.toString()
            ) {
              return 0;
            }
            if (
              visibleUris.has(entry.original.toString()) ||
              visibleUris.has(entry.modified.toString())
            ) {
              return 1;
            }
            return 2;
          };
          return rank(a) - rank(b);
        });
        let inspectedCount = 0;
        for (const comparison of prioritized) {
          if (inspectedCount >= MAX_MULTI_DIFF_ENTRIES) break;
          if (!autoAlignEnabled(comparison)) continue;
          const leftDoc = findDocument(comparison.original);
          const rightDoc = findDocument(comparison.modified);
          if (!leftDoc && !rightDoc) continue;
          inspectedCount += 1;
          const [left, right] = await resolveComparisonSides(comparison);
          const pairs: [vscode.Uri, SideResolution, vscode.TextDocument | undefined][] = [
            [comparison.original, left, leftDoc],
            [comparison.modified, right, rightDoc],
          ];
          const items = pairs.flatMap(([uri, res, doc]) => {
            if (!doc || !isReopenableScheme(uri.scheme) || manualSides.has(uri.toString()) || !res.encoding) {
              return [];
            }
            return !sameEncoding(doc.encoding, res.encoding)
              ? [{ uri, encoding: res.encoding, basis: res.basis }]
              : [];
          });
          if (items.length > 0) {
            const result = await reopenComparisonSides(comparison, items);
            if (result.changed) {
              changed = true;
            }
          }
        }
        continue;
      }
      const comparison = activeComparison();
      if (comparison) {
        if (!autoAlignEnabled(comparison)) break;
        const [left, right] = await resolveComparisonSides(comparison);
        const pairs: [vscode.Uri, SideResolution][] = [
          [comparison.original, left],
          [comparison.modified, right],
        ];
        const items = pairs.flatMap(([uri, res]) => {
          if (!isReopenableScheme(uri.scheme) || manualSides.has(uri.toString()) || !res.encoding) {
            return [];
          }
          return !sameEncoding(findDocument(uri)?.encoding, res.encoding)
            ? [{ uri, encoding: res.encoding, basis: res.basis }]
            : [];
        });
        if (items.length > 0) {
          changed = (await reopenComparisonSides(comparison, items)).changed || changed;
        }
        continue;
      }
      const single = activeSingleGit();
      if (single) {
        if (!autoAlignSingleEnabled(single.uri)) break;
        const res = await resolveSingleSide(single.uri);
        if (
          !manualSides.has(single.uri.toString()) &&
          res.encoding &&
          !sameEncoding(findDocument(single.uri)?.encoding, res.encoding)
        ) {
          changed = (await reopenSingleGit(single, res.encoding, res.basis)) || changed;
        }
        continue;
      }
      const embedded = visibleEmbeddedGitComparisons(currentHints);
      for (const embeddedComparison of embedded) {
        if (!autoAlignEnabled(embeddedComparison)) continue;
        const leftDoc = findDocument(embeddedComparison.original);
        const rightDoc = findDocument(embeddedComparison.modified);
        if (!leftDoc && !rightDoc) continue;
        const [left, right] = await resolveComparisonSides(embeddedComparison);
        const pairs: [vscode.Uri, SideResolution, vscode.TextDocument | undefined][] = [
          [embeddedComparison.original, left, leftDoc],
          [embeddedComparison.modified, right, rightDoc],
        ];
        const items = pairs.flatMap(([uri, res, doc]) => {
          if (!doc || !isReopenableScheme(uri.scheme) || manualSides.has(uri.toString()) || !res.encoding) {
            return [];
          }
          return !sameEncoding(doc.encoding, res.encoding)
            ? [{ uri, encoding: res.encoding, basis: res.basis }]
            : [];
        });
        if (items.length > 0) {
          changed = (await reopenComparisonSides(embeddedComparison, items)).changed || changed;
        }
      }
    } while (alignAgain);
  } catch {
    console.error("Auto Encoding: Failed to reopen Git comparison.");
  } finally {
    aligning = false;
  }
  return changed;
}

export async function reopenWithExpectedEncoding(
  document: vscode.TextDocument,
  match: RuleMatch,
): Promise<void> {
  if (document.isClosed) return;
  const comparison = activeComparison();
  if (comparison && involves(comparison, document)) {
    await reopenComparisonToExpectation(comparison, match.rule.encoding);
    return;
  }
  if (
    document.uri.scheme === "file" &&
    !document.isDirty &&
    !(await canReopenWithRule(document, match))
  ) {
    void vscode.window.showWarningMessage(UNCONFIRMED_RULE_MESSAGE);
    return;
  }
  manualSides.delete(document.uri.toString());
  await reopenWithEncoding(document, match.rule.encoding, false, "rule");
}

export async function reopenComparisonToExpectation(
  comparison: ActiveComparison,
  fallback?: string,
): Promise<void> {
  const [left, right] = await resolveComparisonSides(comparison);
  const pairs: [vscode.Uri, SideResolution][] = [
    [comparison.original, left],
    [comparison.modified, right],
  ];
  const items = pairs.flatMap(([uri, res]) => {
    if (!isReopenableScheme(uri.scheme)) return [];
    if (res.keepCurrentEncoding && !findDocument(uri)?.isDirty) return [];
    const encoding =
      res.encoding ??
      (uri.scheme === "git" || uri.toString() === comparison.modified.toString()
        ? fallback
        : undefined);
    return encoding ? [{ uri, encoding, basis: res.basis }] : [];
  });
  await reopenComparisonManually(comparison, items, false);
}

export async function reopenComparisonManually(
  comparison: ActiveComparison,
  items: { uri: vscode.Uri; encoding: string; basis?: EncodingBasis }[],
  manual: boolean,
  markAllSidesManual = manual,
): Promise<void> {
  // A deliberate reopen pauses automatic alignment for both sides (or only targeted unresolved sides for candidate picks).
  const trackedUris = markAllSidesManual
    ? [comparison.original, comparison.modified, ...items.map((item) => item.uri)]
    : manual
      ? items.map((item) => item.uri)
      : [comparison.original, comparison.modified, ...items.map((item) => item.uri)];
  for (const uri of trackedUris) {
    const key = uri.toString();
    if (manual) {
      manualSides.add(key);
      autoDetectedUris.delete(key);
      guessedUris.delete(key);
    } else {
      manualSides.delete(key);
    }
  }
  try {
    const result = await reopenComparisonSides(comparison, items);
    if (result.blocked) void vscode.window.showErrorMessage(DIRTY_MESSAGE);
  } catch {
    void vscode.window.showErrorMessage(
      t("Failed to reopen with the expected encoding. Please check the file contents and read permissions, then try again."),
    );
  }
}

/** Reopens only the display encoding of comparison sides; unsaved sides are never touched and nothing is written. */
export async function reopenComparisonSides(
  comparison: ActiveComparison,
  items: readonly { uri: vscode.Uri; encoding: string; basis?: EncodingBasis }[],
): Promise<{ changed: boolean; blocked: boolean }> {
  let changed = false;
  let blocked = false;
  for (const { uri, encoding, basis } of items) {
    if (!isReopenableScheme(uri.scheme) || !isReopenableEncoding(encoding)) continue;
    const document = findDocument(uri);
    if (document?.isDirty) {
      blocked = true;
      continue;
    }
    const key = uri.toString();
    if (!beginOpeningDocument(key)) continue;
    try {
      const previous = document?.encoding;
      const reopened = await vscode.workspace.openTextDocument(uri, { encoding });
      if (uri.scheme === "file") {
        clearFileEncodingInspection(uri);
      }
      if (!sameEncoding(previous, reopened.encoding)) {
        changed = true;
        if (basis === "detected" && sameEncoding(reopened.encoding, encoding)) {
          setBounded(autoDetectedUris, key, reopened.encoding);
          guessedUris.delete(key);
        } else if (basis === "guessed" && sameEncoding(reopened.encoding, encoding)) {
          setBounded(guessedUris, key, reopened.encoding);
          autoDetectedUris.delete(key);
        } else {
          autoDetectedUris.delete(key);
          guessedUris.delete(key);
        }
      }
      if (uri.scheme === "file" && !reopened.isClosed && !reopened.isDirty) {
        await inspectFileDocument(reopened);
      }
    } finally {
      endOpeningDocument(key);
    }
  }
  const current = activeComparison();
  if (
    changed &&
    !comparison.multiDiff &&
    current &&
    !current.multiDiff &&
    current.original.toString() === comparison.original.toString() &&
    current.modified.toString() === comparison.modified.toString()
  ) {
    await vscode.commands.executeCommand(
      "vscode.diff",
      comparison.original,
      comparison.modified,
      current.label ??
        comparison.label ??
        `${path.basename(comparison.modified.fsPath)} — ${comparisonLabel(comparison)}`,
      { preview: current.preview },
    );
  }
  return { changed, blocked };
}

export async function reopenSingleGit(
  single: ActiveSingleGit,
  encoding: string,
  basis?: EncodingBasis,
): Promise<boolean> {
  if (!isReopenableEncoding(encoding)) return false;
  const document = findDocument(single.uri);
  if (document?.isDirty) return false;
  const key = single.uri.toString();
  if (!beginOpeningDocument(key)) return false;
  try {
    const previous = document?.encoding;
    const reopened = await vscode.workspace.openTextDocument(single.uri, { encoding });
    if (sameEncoding(previous, reopened.encoding)) return false;
    if (basis === "detected" && sameEncoding(reopened.encoding, encoding)) {
      setBounded(autoDetectedUris, key, reopened.encoding);
      guessedUris.delete(key);
    } else if (basis === "guessed" && sameEncoding(reopened.encoding, encoding)) {
      setBounded(guessedUris, key, reopened.encoding);
      autoDetectedUris.delete(key);
    } else {
      autoDetectedUris.delete(key);
      guessedUris.delete(key);
    }
    const current = activeSingleGit();
    if (current && current.uri.toString() === key && typeof vscode.window.showTextDocument === "function") {
      await vscode.window.showTextDocument(reopened, { preview: current.preview, preserveFocus: true });
    }
    return true;
  } finally {
    endOpeningDocument(key);
  }
}

export async function autoReopenWithDetectedEncoding(
  document: vscode.TextDocument,
  encoding: string,
  basis: "detected" | "guessed" = "detected",
): Promise<vscode.TextDocument | undefined> {
  if (
    document.isDirty ||
    document.isClosed ||
    document.uri.scheme !== "file" ||
    !isReopenableEncoding(encoding)
  ) {
    return undefined;
  }
  const targetEncoding = encoding.toLowerCase();
  const previousEncoding = document.encoding;
  const normalizedPrevious = previousEncoding.toLowerCase();
  if (normalizedPrevious === targetEncoding) return undefined;
  const key = document.uri.toString();
  if (
    openingDocuments.has(key) ||
    manualSides.has(key) ||
    hasAutoReopenFailed(document.uri, targetEncoding)
  ) {
    return undefined;
  }
  if (!beginOpeningDocument(key)) return undefined;
  try {
    if (!(await canReopenWithDetectedEncoding(document, encoding))) return undefined;
    const reopened = await vscode.workspace.openTextDocument(document.uri, { encoding });
    if (reopened.isClosed) return undefined;
    const reopenedEncoding = reopened.encoding.toLowerCase();
    if (reopenedEncoding !== targetEncoding || reopenedEncoding === normalizedPrevious) {
      markAutoReopenFailed(document.uri, targetEncoding);
      if (reopenedEncoding !== normalizedPrevious) {
        clearFileEncodingInspection(document.uri);
        await inspectFileDocument(reopened);
      }
      return undefined;
    }
    manualSides.delete(key);
    clearAutoReopenFailure(document.uri);
    if (basis === "guessed") {
      setBounded(guessedUris, key, reopened.encoding);
      autoDetectedUris.delete(key);
    } else {
      setBounded(autoDetectedUris, key, reopened.encoding);
      guessedUris.delete(key);
    }
    clearFileEncodingInspection(document.uri);
    await inspectFileDocument(reopened);
    return reopened;
  } catch (error) {
    markAutoReopenFailed(document.uri, targetEncoding);
    throw error;
  } finally {
    endOpeningDocument(key);
  }
}

export async function reopenDocumentWithDetectedEncoding(
  document: vscode.TextDocument,
  encoding: string,
  manual = false,
): Promise<vscode.TextDocument | undefined> {
  return reopenWithEncoding(document, encoding, manual, manual ? undefined : "detected");
}

export async function reopenWithEncoding(
  document: vscode.TextDocument,
  encoding: string,
  manual = false,
  basis?: EncodingBasis,
): Promise<vscode.TextDocument | undefined> {
  if (!isReopenableEncoding(encoding)) return undefined;
  const comparison = activeComparison();
  if (comparison && involves(comparison, document)) {
    const targets = [comparison.original, comparison.modified]
      .filter((uri) => isReopenableScheme(uri.scheme))
      .map((uri) => ({ uri, encoding, basis }));
    await reopenComparisonManually(comparison, targets, manual);
    return findDocument(document.uri);
  }
  if (document.isClosed) return undefined;
  if (document.isDirty) {
    void vscode.window.showErrorMessage(DIRTY_MESSAGE);
    return undefined;
  }
  const key = document.uri.toString();
  if (!beginOpeningDocument(key)) return undefined;
  const hadManual = manualSides.has(key);
  const previousAutoDetected = autoDetectedUris.get(key);
  const previousGuessed = guessedUris.get(key);
  if (manual) {
    manualSides.add(key);
    autoDetectedUris.delete(key);
    guessedUris.delete(key);
  }
  try {
    const reopened = await vscode.workspace.openTextDocument(document.uri, {
      encoding,
    });
    if (!manual) {
      manualSides.delete(key);
      if (basis === "detected" && sameEncoding(reopened.encoding, encoding)) {
        setBounded(autoDetectedUris, key, reopened.encoding);
        guessedUris.delete(key);
      } else if (basis === "guessed" && sameEncoding(reopened.encoding, encoding)) {
        setBounded(guessedUris, key, reopened.encoding);
        autoDetectedUris.delete(key);
      } else {
        autoDetectedUris.delete(key);
        guessedUris.delete(key);
      }
    }
    clearAutoReopenFailure(document.uri);
    clearFileEncodingInspection(document.uri);
    await vscode.window.showTextDocument(reopened, { preview: false, preserveFocus: false });
    if (reopened.uri.scheme === "file" && !reopened.isClosed) {
      await inspectFileDocument(reopened);
    }
    return reopened;
  } catch {
    if (manual) {
      if (!hadManual) manualSides.delete(key);
      if (previousAutoDetected !== undefined) {
        setBounded(autoDetectedUris, key, previousAutoDetected);
      }
      if (previousGuessed !== undefined) {
        setBounded(guessedUris, key, previousGuessed);
      }
    }
    void vscode.window.showErrorMessage(
      t("Failed to reopen with the expected encoding. Please check the file contents and read permissions, then try again."),
    );
    return undefined;
  } finally {
    endOpeningDocument(key);
  }
}
