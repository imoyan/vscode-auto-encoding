// Interactive QuickPick encoding inspection, ranked candidate previews, and line-ending reporting.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import {
  extractNonAsciiPreview,
  rankDecodedCandidates,
  type RankedEncodingCandidate,
} from "./candidatePreview.js";
import {
  classifyTextLineEndings,
  classifyLineEndings,
  decodeIso2022JpStrict,
} from "./scanCore.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import {
  ENCODINGS,
  ISO2022JP_ENCODING,
  encodingInfo,
  isReopenableEncoding,
} from "./rules.js";
import {
  type RuleMatch,
  resolveRule,
  fileUriForResource,
  clearWorkspaceRuleCache,
} from "./workspaceRules.js";
import {
  type ActiveComparison,
  type ComparisonInput,
  type FileEncodingInspection,
  type SideResolution,
  activeComparison,
  activeComparisonDocument,
  clearAutoReopenFailure,
  clearCleanFileEncodingInspections,
  clearEncodingDetectionCache,
  clearFileEncodingInspection,
  comparisonLabel,
  findDocument,
  isDocumentEncodingMatch,
  isReopenableScheme,
  manualSides,
  maxResourceBytes,
  sameEncoding,
  sideName,
} from "./editorEncodingState.js";
import {
  canAlignAsciiCounterpart,
  inspectFileDocument,
  readResourceBytes,
  resolveComparisonSides,
  resolveSingleSide,
} from "./editorEncodingDetection.js";
import {
  reopenComparisonManually,
  reopenComparisonToExpectation,
  reopenWithEncoding,
  reopenWithExpectedEncoding,
} from "./editorEncodingReopen.js";

const REOPEN_NOTE = t(
  "Reopen changes display only (does not modify files). To change the saved format, use Convert from the context menu.",
);
const FILE_INSPECT_NOTE = t(
  "Reopen changes display only (does not modify files). To change the saved format, choose Convert and Save.",
);

type InspectAction =
  | "candidate"
  | "expected"
  | "choose"
  | "convertRule"
  | "convertFile"
  | "registerFile"
  | "registerFolder"
  | "original"
  | "modified"
  | "openWorkingFile";

interface InspectChoice extends vscode.QuickPickItem {
  readonly action: InspectAction;
  readonly encoding?: string;
}

function inspectableCandidates(
  resolutions: readonly SideResolution[],
  fileInspection?: FileEncodingInspection,
): string[] {
  const fromSides = resolutions.flatMap((res) =>
    (!res.encoding || res.basis === "guessed") && res.candidates ? res.candidates : [],
  );
  const fromFile =
    fileInspection?.basis === "guessed" && fileInspection.candidates
      ? fileInspection.candidates
      : [];
  return [...new Set([...fromSides, ...fromFile])];
}

function candidateTargetsFor(
  comparison: ComparisonInput,
  resolutions: readonly SideResolution[],
  candidate: string,
): vscode.Uri[] {
  const pairs: [vscode.Uri, SideResolution | undefined][] = [
    [comparison.original, resolutions[0]],
    [comparison.modified, resolutions[1]],
  ];
  const direct = pairs
    .filter(
      ([uri, res]) =>
        isReopenableScheme(uri.scheme) &&
        (!res?.encoding || res.basis === "guessed") &&
        res?.candidates?.includes(candidate) === true,
    )
    .map(([uri]) => uri);
  if (direct.length === 0) return [];
  for (const [uri, res] of pairs) {
    if (
      isReopenableScheme(uri.scheme) &&
      !res?.encoding &&
      res?.ascii &&
      canAlignAsciiCounterpart(candidate, res.empty === true) &&
      !direct.some((entry) => entry.toString() === uri.toString())
    ) {
      direct.push(uri);
    }
  }
  return direct;
}

function expectedActionLabel(
  resolutions: readonly SideResolution[],
  match: RuleMatch | undefined,
): string {
  const encodings = [...new Set(resolutions.flatMap((res) => (res.encoding ? [res.encoding] : [])))];
  if (resolutions.some((res) => res.keepCurrentEncoding) && encodings.length === 1) {
    return t("$(check) Reopen detected side as {0}", encodingInfo(encodings[0]!).label);
  }
  if (encodings.length === 2) {
    return t(
      "$(check) Reopen with detected encodings (Left: {0} / Right: {1})",
      encodingInfo(encodings[0]!).label,
      encodingInfo(encodings[1]!).label,
    );
  }
  const single = encodings[0] ?? match?.rule.encoding ?? "utf8";
  const label = encodingInfo(single).label;
  if (match && !resolutions.some((res) => res.actualMismatch)) {
    return t("$(check) Reopen with expected encoding ({0})", label);
  }
  if (resolutions.some((res) => res.basis === "openFile")) {
    return t("$(check) Reopen with working file encoding ({0})", label);
  }
  return t("$(check) Reopen with auto-detected encoding ({0})", label);
}

function describeBasisTitle(
  resolutions: readonly SideResolution[],
  match: RuleMatch | undefined,
  mismatched: boolean,
  candidates: readonly string[],
  decodeLoss = false,
  estimated = false,
): string {
  if (candidates.length > 0 && !estimated) {
    const list = candidates.map((id) => encodingInfo(id).label).join(" / ");
    return match
      ? t("Rule: {0} (mismatch · candidates: {1})", encodingInfo(match.rule.encoding).label, list)
      : t("Candidates: {0} (no rule)", list);
  }
  if (decodeLoss) {
    return match
      ? t("Rule: {0} (mismatch · decode loss)", encodingInfo(match.rule.encoding).label)
      : t("Could not decode without loss in current encoding (no rule)");
  }
  if (match) {
    return mismatched
      ? t("Rule: {0} (mismatch)", encodingInfo(match.rule.encoding).label)
      : t("Rule: {0} (matched)", encodingInfo(match.rule.encoding).label);
  }
  if (estimated && candidates.length > 0) {
    const list = candidates.map((id) => encodingInfo(id).label).join(" / ");
    return t("Estimated from candidates: {0} (no rule)", list);
  }
  if (resolutions.some((res) => res.basis === "openFile")) {
    return t("Inherited from working file (no rule)");
  }
  if (
    resolutions.some(
      (res) => res.basis === "detected" && res.encoding && (res.encoding !== "utf8" || mismatched),
    )
  ) {
    return t("Auto-detected (no rule)");
  }
  return t("Encoding rule: none");
}

async function decodeAndRankSideCandidates(
  uri: vscode.Uri,
  sideCandidates: readonly string[],
  previewPrefix?: string,
): Promise<readonly RankedEncodingCandidate[] | undefined> {
  if (sideCandidates.length === 0) return undefined;
  const read = await readResourceBytes(uri, maxResourceBytes(uri));
  if (!read) return undefined;
  const decoded: Array<{ readonly encoding: string; readonly text: string }> = [];
  for (const candidate of sideCandidates) {
    const normalized = candidate.toLowerCase();
    const bomLength =
      normalized === "utf8bom" &&
      read.bytes[0] === 0xef &&
      read.bytes[1] === 0xbb &&
      read.bytes[2] === 0xbf
        ? 3
        : 0;
    const decodeEncoding = normalized === "utf8bom" ? "utf8" : normalized;
    try {
      const text = await vscode.workspace.decode(read.bytes.subarray(bomLength), {
        encoding: decodeEncoding,
      });
      decoded.push({ encoding: candidate, text });
    } catch {
      // Skip unreadable candidates from previews while keeping them in original order.
    }
  }
  if (decoded.length === 0) return undefined;
  if (read.stillCurrent && !(await read.stillCurrent())) return undefined;
  return rankDecodedCandidates(decoded, { previewPrefix });
}

async function buildCandidatePreviews(
  document: vscode.TextDocument,
  comparison: ActiveComparison | undefined,
  resolutions: readonly SideResolution[],
  candidates: readonly string[],
): Promise<
  | {
      readonly ordered: readonly string[];
      readonly byEncoding: ReadonlyMap<string, RankedEncodingCandidate>;
    }
  | undefined
> {
  if (candidates.length === 0 || typeof vscode.workspace.decode !== "function") {
    return undefined;
  }
  let primary: readonly RankedEncodingCandidate[] | undefined;
  let secondary: readonly RankedEncodingCandidate[] | undefined;

  if (comparison) {
    const rightCandidates =
      !resolutions[1]?.encoding || resolutions[1].basis === "guessed"
        ? (resolutions[1]?.candidates ?? [])
        : [];
    const leftCandidates =
      !resolutions[0]?.encoding || resolutions[0].basis === "guessed"
        ? (resolutions[0]?.candidates ?? [])
        : [];
    const rightRanked =
      rightCandidates.length > 0
        ? await decodeAndRankSideCandidates(comparison.modified, rightCandidates, t("Right"))
        : undefined;
    const rightHasNonAscii = rightRanked?.some((entry) => entry.nonAsciiCount > 0) ?? false;
    const rightSet = new Set(rightRanked?.map((entry) => entry.encoding) ?? []);
    const needsLeft =
      leftCandidates.length > 0 &&
      (!rightHasNonAscii || leftCandidates.some((candidate) => !rightSet.has(candidate)));
    const leftRanked = needsLeft
      ? await decodeAndRankSideCandidates(comparison.original, leftCandidates, t("Left"))
      : undefined;
    const leftHasNonAscii = leftRanked?.some((entry) => entry.nonAsciiCount > 0) ?? false;

    if (rightHasNonAscii) {
      primary = rightRanked;
      secondary = leftRanked;
    } else if (leftHasNonAscii) {
      primary = leftRanked;
      secondary = rightRanked;
    } else {
      primary = rightRanked ?? leftRanked;
      secondary = rightRanked ? leftRanked : undefined;
    }
  } else {
    primary = await decodeAndRankSideCandidates(document.uri, candidates);
  }

  if (!primary && !secondary) return undefined;

  const byEncoding = new Map<string, RankedEncodingCandidate>();
  const ordered: string[] = [];
  for (const entry of primary ?? []) {
    if (byEncoding.has(entry.encoding)) continue;
    byEncoding.set(entry.encoding, entry);
    ordered.push(entry.encoding);
  }
  for (const entry of secondary ?? []) {
    if (byEncoding.has(entry.encoding)) continue;
    byEncoding.set(entry.encoding, primary ? { ...entry, likely: false } : entry);
    ordered.push(entry.encoding);
  }
  for (const candidate of candidates) {
    if (!byEncoding.has(candidate)) {
      ordered.push(candidate);
    }
  }
  return { ordered, byEncoding };
}

async function iso2022JpPreviewFor(uri: vscode.Uri): Promise<string | undefined> {
  const read = await readResourceBytes(uri, maxResourceBytes(uri));
  if (!read) return undefined;
  const decoded = decodeIso2022JpStrict(read.bytes);
  if (decoded === undefined) return undefined;
  if (read.stillCurrent && !(await read.stillCurrent())) return undefined;
  return extractNonAsciiPreview(decoded);
}

async function describeDocumentLineEndings(document: vscode.TextDocument): Promise<string> {
  let endings;
  let source: string;
  if (document.isDirty) {
    endings = classifyTextLineEndings(document.getText());
    source = t("unsaved buffer");
  } else if (document.uri.scheme === "git") {
    const gitRead =
      typeof classifyLineEndings === "function"
        ? await readResourceBytes(document.uri, maxResourceBytes(document.uri))
        : undefined;
    if (gitRead) {
      endings = classifyLineEndings(gitRead.bytes, document.encoding);
      source = t("Git");
    } else {
      endings = classifyTextLineEndings(document.getText());
      source = t("current document");
    }
  } else if (document.uri.scheme !== "file") {
    endings = classifyTextLineEndings(document.getText());
    source = t("current document");
  } else {
    const version = document.version;
    const encoding = document.encoding;
    const changed = (): boolean =>
      document.isDirty || document.version !== version || document.encoding !== encoding;
    const maxSize = maxResourceBytes(document.uri);
    try {
      const read = await readStableResource(document.uri, maxSize, changed);
      if (!read || !(await resourceStillMatchesRead(document.uri, maxSize, read, changed))) {
        return t("EOL: Unchecked (file may be changing, unreadable, or over size limit)");
      }
      endings = classifyLineEndings(read.bytes, encoding);
      source = t("saved file");
    } catch {
      return t("EOL: Unchecked (could not read file safely)");
    }
  }
  const label =
    endings.kind === "none"
      ? t("No EOL")
      : endings.kind === "mixed"
        ? t("Mixed EOL: {0}", endings.styles.join(" / ").toUpperCase())
        : t("EOL: {0}", endings.kind.toUpperCase());
  return `${label} (${source})`;
}

/** Opens the encoding inspection QuickPick for the active editor or Git/Multi-Diff comparison. */
export async function inspectActiveFile(): Promise<void> {
  const comparison = activeComparison();
  const document = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
  if (!document) {
    void vscode.window.showInformationMessage(t("Open a file to inspect its encoding."));
    return;
  }
  const details = await describeDocumentLineEndings(document);
  const resolutions = comparison
    ? await resolveComparisonSides(comparison)
    : [await resolveSingleSide(document.uri)];
  const fileInspection =
    !comparison && document.uri.scheme === "file" ? await inspectFileDocument(document) : undefined;
  const decodeLoss = !comparison && fileInspection?.status === "decodeLoss";
  const match =
    resolveRule(document.uri) ??
    (comparison ? (resolveRule(comparison.modified) ?? resolveRule(comparison.original)) : undefined);
  const name = path.basename(document.fileName || document.uri.fsPath || document.uri.path);
  const iso2022JpDetected =
    !comparison &&
    fileInspection?.status === "detectedMismatch" &&
    fileInspection.detectedEncoding?.toLowerCase() === ISO2022JP_ENCODING;
  const comparisonIso2022JpWorkingUri = comparison
    ? comparison.modified.scheme === "file" &&
      resolutions[1]?.encoding?.toLowerCase() === ISO2022JP_ENCODING
      ? comparison.modified
      : comparison.original.scheme === "file" &&
          resolutions[0]?.encoding?.toLowerCase() === ISO2022JP_ENCODING
        ? comparison.original
        : undefined
    : undefined;
  const mismatched = comparison
    ? ([comparison.original, comparison.modified] as const).some((uri, idx) => {
        if (!isReopenableScheme(uri.scheme)) return false;
        const expected = resolutions[idx]?.encoding;
        const doc = findDocument(uri);
        return (
          !!expected && isReopenableEncoding(expected) && !!doc && !sameEncoding(doc.encoding, expected)
        );
      })
    : (() => {
        const resolution = resolutions[0];
        const expected = resolution?.keepCurrentEncoding
          ? undefined
          : (resolution?.encoding ?? match?.rule.encoding);
        return (
          !!expected && isReopenableEncoding(expected) && !sameEncoding(document.encoding, expected)
        );
      })();
  const candidates = inspectableCandidates(resolutions, fileInspection);
  const isEstimated =
    !mismatched &&
    (resolutions.some((res) => res.basis === "guessed") || fileInspection?.basis === "guessed");
  const rankedCandidates = await buildCandidatePreviews(document, comparison, resolutions, candidates);
  const orderedCandidates = rankedCandidates?.ordered ?? candidates;
  const ruleMismatch = match
    ? comparison
      ? [comparison.original, comparison.modified].some((uri) => {
          const sideRule = resolveRule(uri);
          const doc = findDocument(uri);
          return !!sideRule && !!doc && !sameEncoding(doc.encoding, sideRule.rule.encoding);
        })
      : !isDocumentEncodingMatch(document, match)
    : false;
  const ruleText = describeBasisTitle(
    resolutions,
    match,
    mismatched || ruleMismatch,
    orderedCandidates,
    decodeLoss,
    isEstimated,
  );
  const ruleSource = match ? ` | ${t("Source: {0} / {1}", match.folder.name, match.rule.pattern)}` : "";
  const state = comparison
    ? comparisonLabel(comparison)
    : document.uri.scheme === "git"
      ? t("Git: {0}", encodingInfo(document.encoding).label)
      : t("Current: {0}", encodingInfo(document.encoding).label);

  const fileUri = fileUriForResource(document.uri);
  const isLocalFile = fileUri.scheme === "file";
  const inWorkspaceFile = isLocalFile && Boolean(vscode.workspace.getWorkspaceFolder(fileUri));
  const iso2022JpConvertUri =
    iso2022JpDetected && isLocalFile && document.uri.scheme === "file"
      ? fileUri
      : comparisonIso2022JpWorkingUri
        ? comparisonIso2022JpWorkingUri
        : undefined;
  const choices: InspectChoice[] = [];
  if (iso2022JpConvertUri) {
    const iso2022JpPreview = await iso2022JpPreviewFor(iso2022JpConvertUri);
    choices.push({
      action: "convertFile",
      label: t("$(replace) Convert and Save from ISO-2022-JP (JIS) to UTF-8, etc...."),
      description: t(
        "Recommended because VS Code cannot open this encoding natively (with local backup and Undo)",
      ),
      ...(iso2022JpPreview ? { detail: iso2022JpPreview } : {}),
    });
  }
  for (const candidate of orderedCandidates) {
    const targets = comparison
      ? candidateTargetsFor(comparison, resolutions, candidate)
      : [document.uri];
    const targetDesc = comparison
      ? targets.length === 1
        ? t(
            "{0} only · keep diff view (no save)",
            targets[0]!.toString() === comparison.original.toString()
              ? sideName(comparison, "original")
              : sideName(comparison, "modified"),
          )
        : t("Both sides · keep diff view (no save)")
      : t("Display only (no save)");
    const ranked = rankedCandidates?.byEncoding.get(candidate);
    const isCurrentCandidate = comparison
      ? targets.length > 0 &&
        targets.every((targetUri) => sameEncoding(findDocument(targetUri)?.encoding, candidate))
      : sameEncoding(document.encoding, candidate);
    const descParts = [
      ranked?.likely ? t("Likely") : undefined,
      isCurrentCandidate ? t("Current encoding") : undefined,
      targetDesc,
    ].filter((part): part is string => Boolean(part));
    choices.push({
      action: "candidate",
      encoding: candidate,
      label: t("$(sparkle) Candidate: Reopen as {0}", encodingInfo(candidate).label),
      description: descParts.join(" · "),
      ...(ranked?.preview ? { detail: ranked.preview } : {}),
    });
  }
  if (mismatched) {
    choices.push({
      action: "expected",
      label: expectedActionLabel(resolutions, match),
      description: comparison
        ? resolutions.some((res) => res.keepCurrentEncoding)
          ? t("Keep diff view (no save)")
          : t("Both sides · keep diff view")
        : t("Display only"),
    });
  }
  const hasVirtualComparisonSide = Boolean(
    comparison &&
      (!isReopenableScheme(comparison.original.scheme) ||
        !isReopenableScheme(comparison.modified.scheme)),
  );
  choices.push({
    action: "choose",
    label: t("$(symbol-text) Reopen with Another Encoding (no save)"),
    description: comparison
      ? hasVirtualComparisonSide
        ? t("Working / Git side only · keep diff view")
        : t("Both sides · keep diff view")
      : t("Display only"),
  });
  if (isLocalFile && !comparison && document.uri.scheme === "file") {
    if (
      inWorkspaceFile &&
      match &&
      (fileInspection?.ruleConfirmed === false ||
        (!isDocumentEncodingMatch(document, match) && fileInspection?.ruleConfirmed !== true))
    ) {
      const expectedLabel = encodingInfo(match.rule.encoding).label;
      choices.push({
        action: "convertRule",
        encoding: match.rule.encoding,
        label: t("$(replace) Convert and Save to Configured Encoding ({0})...", expectedLabel),
        description: t("Rewrites the file with local backup and Undo"),
      });
    }
    if (!iso2022JpDetected) {
      choices.push({
        action: "convertFile",
        label: t("$(replace) Convert and Save Encoding / Line Endings..."),
        description: t("Rewrites the file with local backup and Undo"),
      });
    }
  }
  if (inWorkspaceFile) {
    choices.push(
      {
        action: "registerFile",
        label: t("$(pin) Set Encoding Rule for This File"),
        description: t("Also preserved in Git comparisons"),
      },
      {
        action: "registerFolder",
        label: t("$(folder) Set Encoding Rule for This Folder"),
        description: t("Applies to files under this folder and Git comparisons"),
      },
    );
  }
  if (comparison) {
    const reopenableOriginal = isReopenableScheme(comparison.original.scheme);
    const reopenableModified = isReopenableScheme(comparison.modified.scheme);
    if (reopenableOriginal) {
      choices.push({
        action: "original",
        label: t("$(arrow-left) Reopen {0} with Another Encoding", sideName(comparison, "original")),
        description: t("For inspecting intentional encoding conversion commits"),
      });
    }
    if (reopenableModified) {
      choices.push({
        action: "modified",
        label: t("$(arrow-right) Reopen {0} with Another Encoding", sideName(comparison, "modified")),
        description: t("For inspecting intentional encoding conversion commits"),
      });
    }
    const workingFileUri =
      comparison.modified.scheme === "file"
        ? comparison.modified
        : comparison.original.scheme === "file"
          ? comparison.original
          : undefined;
    if (workingFileUri && (comparison.multiDiff || !reopenableOriginal || !reopenableModified)) {
      choices.push({
        action: "openWorkingFile",
        label: t("$(go-to-file) Open Working File in Standard Editor"),
        description: t(
          "Open as a standalone editor when multi-file diff or virtual snapshot is hard to read",
        ),
      });
    }
  }
  const selected = await vscode.window.showQuickPick<InspectChoice>(choices, {
    title: `${name}: ${state} | ${details} | ${ruleText}${ruleSource}`,
    placeHolder:
      !comparison && document.uri.scheme === "file" && isLocalFile ? FILE_INSPECT_NOTE : REOPEN_NOTE,
  });
  if (!selected) return;

  if (selected.action === "openWorkingFile") {
    const workingFileUri =
      comparison?.modified.scheme === "file"
        ? comparison.modified
        : comparison?.original.scheme === "file"
          ? comparison.original
          : undefined;
    if (workingFileUri && typeof vscode.window.showTextDocument === "function") {
      const targetDoc =
        findDocument(workingFileUri) ?? (await vscode.workspace.openTextDocument(workingFileUri));
      await vscode.window.showTextDocument(targetDoc, { preview: false, preserveFocus: false });
    }
    return;
  }

  if (selected.action === "convertRule" || selected.action === "convertFile") {
    const convertTargetUri =
      selected.action === "convertFile" ? (iso2022JpConvertUri ?? fileUri) : fileUri;
    await vscode.commands.executeCommand(
      "autoEncoding.convertFile",
      convertTargetUri,
      selected.encoding,
    );
    const active = findDocument(convertTargetUri);
    if (active && !active.isClosed) {
      clearEncodingDetectionCache(convertTargetUri);
      clearFileEncodingInspection(convertTargetUri);
      await inspectFileDocument(active);
    }
    return;
  }

  if (selected.action === "candidate") {
    if (selected.encoding) {
      if (comparison) {
        const targets = candidateTargetsFor(comparison, resolutions, selected.encoding);
        if (targets.length > 0) {
          await reopenComparisonManually(
            comparison,
            targets.map((uri) => ({ uri, encoding: selected.encoding! })),
            true,
            false,
          );
        }
      } else {
        const matchesRule = Boolean(match && sameEncoding(selected.encoding, match.rule.encoding));
        await reopenWithEncoding(
          document,
          selected.encoding,
          !matchesRule,
          matchesRule ? "rule" : undefined,
        );
      }
    }
    return;
  }
  if (selected.action === "expected") {
    if (comparison) {
      await reopenComparisonToExpectation(comparison, match?.rule.encoding);
    } else {
      const target = resolutions[0]?.encoding;
      if (target) {
        const manualOverride = Boolean(
          match && target.toLowerCase() !== match.rule.encoding.toLowerCase(),
        );
        await reopenWithEncoding(
          document,
          target,
          manualOverride,
          manualOverride ? undefined : resolutions[0]?.basis,
        );
      }
    }
    return;
  }
  if (selected.action === "registerFile" || selected.action === "registerFolder") {
    const registerTarget =
      selected.action === "registerFile"
        ? document.uri.scheme === "git"
          ? document.uri
          : fileUri
        : vscode.Uri.file(path.dirname(fileUri.fsPath));
    const saved = await vscode.commands.executeCommand(
      selected.action === "registerFile" ? "autoEncoding.configureFile" : "autoEncoding.configureFolder",
      registerTarget,
    );
    // A cancelled picker leaves any existing rule untouched; never reopen on its account.
    if (saved !== true) return;
    clearWorkspaceRuleCache();
    clearEncodingDetectionCache();
    clearCleanFileEncodingInspections();
    clearAutoReopenFailure();
    const created =
      resolveRule(document.uri) ??
      (comparison
        ? (resolveRule(comparison.modified) ?? resolveRule(comparison.original))
        : undefined);
    if (created) {
      manualSides.delete(document.uri.toString());
      await reopenWithExpectedEncoding(document, created);
    }
    return;
  }
  const currentEncoding = document.encoding;
  const picked = await vscode.window.showQuickPick(
    ENCODINGS.map((encoding) => ({
      label: encoding.label,
      description: sameEncoding(encoding.id, currentEncoding)
        ? t("{0} · Current encoding", encoding.id)
        : encoding.id,
      encoding: encoding.id,
    })),
    {
      title:
        selected.action === "choose"
          ? t("Select Encoding to Reopen (no save)")
          : t("Select Encoding to Reopen {0} (no save)", sideName(comparison!, selected.action)),
      placeHolder: REOPEN_NOTE,
    },
  );
  if (!picked) return;
  if (selected.action === "original" || selected.action === "modified") {
    await reopenComparisonManually(
      comparison!,
      [{ uri: comparison![selected.action], encoding: picked.encoding }],
      true,
    );
  } else {
    await reopenWithEncoding(document, picked.encoding, true);
  }
}
