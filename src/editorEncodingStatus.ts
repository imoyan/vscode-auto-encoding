// Editor diagnostics and status bar presentation for file, Git, and comparison views.

import * as vscode from "vscode";
import { t } from "./l10n.js";
import { ISO2022JP_ENCODING, encodingInfo, isReopenableEncoding } from "./rules.js";
import { type RuleMatch, resolveRule, fileUriForResource } from "./workspaceRules.js";
import {
  UNCONFIRMED_RULE_MESSAGE,
  type SideResolution,
  activeComparison,
  autoDetectedUris,
  comparisonLabel,
  effectiveDefaultFilesEncoding,
  effectiveStatusBarVisibility,
  findDocument,
  guessedUris,
  isDocumentEncodingMatch,
  isManualEncodingOverride,
  isReopenableScheme,
  sameEncoding,
  uniqueCandidates,
} from "./editorEncodingState.js";
import { currentFileInspection, currentSideResolution } from "./editorEncodingDetection.js";

/** Builds a warning diagnostic for workspace files whose open encoding or saved bytes mismatch. */
export function diagnosticFor(document: vscode.TextDocument): vscode.Diagnostic | undefined {
  if (document.isClosed || document.uri.scheme === "git") return undefined;
  if (document.uri.scheme === "file" && !vscode.workspace.getWorkspaceFolder?.(document.uri)) {
    return undefined;
  }
  const match = resolveRule(document.uri);
  const actual = encodingInfo(document.encoding).label;
  let message: string | undefined;
  if (match && !isDocumentEncodingMatch(document, match)) {
    const expected = encodingInfo(match.rule.encoding).label;
    const inspection = currentFileInspection(document);
    if (inspection?.ruleConfirmed === false && inspection.status !== "ok") {
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        message = t(
          "Current encoding ({0}) and configured rule ({1}) differ from saved bytes. Detected: {2}",
          actual,
          expected,
          encodingInfo(inspection.detectedEncoding).label,
        );
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        const list = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
        message = t(
          "Current encoding ({0}) and configured rule ({1}) differ from saved bytes. Candidates: {2}",
          actual,
          expected,
          list,
        );
      } else {
        message = t(
          "Saved bytes could not be decoded without loss using either the current encoding ({0}) or the configured rule ({1}).",
          actual,
          expected,
        );
      }
    } else if (
      inspection?.ruleConfirmed === false &&
      inspection.status === "ok" &&
      inspection.detectedEncoding &&
      !sameEncoding(inspection.detectedEncoding, match.rule.encoding)
    ) {
      message = t(
        "Saved bytes differ from configured rule ({0}). Detected: {1}",
        expected,
        encodingInfo(inspection.detectedEncoding).label,
      );
    } else {
      message = t(
        "Encoding differs from configured rule. Current: {0} / Expected: {1}",
        actual,
        expected,
      );
    }
  } else {
    const inspection = currentFileInspection(document);
    if (!inspection || inspection.status === "ok") return undefined;
    if (match) {
      const expected = encodingInfo(match.rule.encoding).label;
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        message = t(
          "Saved bytes differ from configured rule ({0}). Detected: {1}",
          expected,
          encodingInfo(inspection.detectedEncoding).label,
        );
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        const list = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
        message = t(
          "Saved bytes differ from configured rule ({0}). Candidates: {1}",
          expected,
          list,
        );
      } else {
        message = t(
          "Saved bytes could not be decoded without loss using the configured rule ({0}).",
          expected,
        );
      }
    } else if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
      message = t(
        "Current encoding ({0}) differs from saved bytes. Detected: {1}",
        actual,
        encodingInfo(inspection.detectedEncoding).label,
      );
    } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
      const list = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
      message = t("Current encoding ({0}) differs from saved bytes. Candidates: {1}", actual, list);
    } else {
      message = t(
        "Saved bytes could not be decoded without loss using the current encoding ({0}).",
        actual,
      );
    }
  }
  if (
    typeof vscode.Diagnostic !== "function" ||
    !vscode.DiagnosticSeverity ||
    typeof document.lineAt !== "function"
  ) {
    return undefined;
  }
  const range = document.lineAt(0).range;
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  diagnostic.source = "Auto Encoding";
  diagnostic.code = "encoding-mismatch";
  return diagnostic;
}

function comparisonStatusSuffix(
  hasIso2022JpSide: boolean,
  ruleMatch: RuleMatch | undefined,
  candidates: readonly string[],
): string {
  if (hasIso2022JpSide) return ` (${t("ISO-2022-JP detected")})`;
  if (!ruleMatch && candidates.length > 0) return ` (${t("candidates")})`;
  return "";
}

function comparisonBasisLine(
  ruleMatch: RuleMatch | undefined,
  candidates: readonly string[],
  resolutions: readonly SideResolution[],
): string {
  if (ruleMatch) {
    return t(
      "Encoding rule: {0} ({1})",
      encodingInfo(ruleMatch.rule.encoding).label,
      ruleMatch.rule.pattern,
    );
  }
  if (candidates.length > 0) {
    const candidateLabels = candidates.map((id) => encodingInfo(id).label).join(" / ");
    return t("Encoding rule: none (candidates: {0})", candidateLabels);
  }
  if (resolutions.some((res) => res.basis === "openFile")) {
    return t("Encoding rule: none (inherited from open working file)");
  }
  if (resolutions.some((res) => res.basis === "guessed")) {
    const guessedLabels = [
      ...new Set(
        resolutions.flatMap((res) => (res.basis === "guessed" && res.candidates ? res.candidates : [])),
      ),
    ]
      .map((id) => encodingInfo(id).label)
      .join(" / ");
    return t("Encoding rule: none (estimated from candidates: {0})", guessedLabels);
  }
  if (resolutions.some((res) => res.basis === "detected")) {
    return t("Encoding rule: none (auto-detected from bytes)");
  }
  return t("Encoding rule: none");
}

function singleGitBasisLine(res: SideResolution): string {
  if (res.basis === "openFile") {
    return t("Displaying Git view using the open working file's encoding (no rule).");
  }
  if (res.basis === "guessed") {
    const labels = (res.candidates ?? []).map((id) => encodingInfo(id).label).join(" / ");
    return t(
      "Displaying Git view using the most likely encoding estimated from candidates ({0}) (no rule).",
      labels,
    );
  }
  if (res.basis === "detected") {
    return t("Displaying Git view using the encoding auto-detected from bytes (no rule).");
  }
  return t("No encoding rule is configured for this Git file.");
}

/** Updates the Auto Encoding status bar item for the active document or comparison view. */
export function updateStatus(status: vscode.StatusBarItem, document: vscode.TextDocument): void {
  status.command = "autoEncoding.inspectActiveFile";
  const comparison = activeComparison();
  if (comparison) {
    const [leftUri, rightUri] = [comparison.original, comparison.modified];
    const sides = [
      {
        uri: leftUri,
        doc: findDocument(leftUri),
        res: currentSideResolution(leftUri, rightUri),
        directMatch: resolveRule(leftUri),
      },
      {
        uri: rightUri,
        doc: findDocument(rightUri),
        res: currentSideResolution(rightUri, leftUri),
        directMatch: resolveRule(rightUri),
      },
    ] as const;
    const candidates = uniqueCandidates(sides.map((side) => side.res));
    const hasVirtualSide = sides.some((side) => !isReopenableScheme(side.uri.scheme));
    const hasIso2022JpSide = sides.some(
      (side) => side.res.encoding?.toLowerCase() === ISO2022JP_ENCODING,
    );
    const targetMismatch = sides.some(
      (side) =>
        isReopenableScheme(side.uri.scheme) &&
        side.res.encoding &&
        isReopenableEncoding(side.res.encoding) &&
        side.doc &&
        !sameEncoding(side.doc.encoding, side.res.encoding),
    );
    const ruleMismatch = sides.some(
      (side) =>
        isReopenableScheme(side.uri.scheme) &&
        side.directMatch &&
        side.doc &&
        !sameEncoding(side.doc.encoding, side.directMatch.rule.encoding),
    );
    const sidesDiffer =
      !!sides[0].doc && !!sides[1].doc && !sameEncoding(sides[0].doc.encoding, sides[1].doc.encoding);
    const unconfirmedWorkingFile = sides.some(
      (side) => side.res.keepCurrentEncoding && side.doc && !side.doc.isDirty,
    );
    const warn =
      hasIso2022JpSide ||
      candidates.length > 0 ||
      targetMismatch ||
      ruleMismatch ||
      sidesDiffer ||
      unconfirmedWorkingFile;
    const ruleMatch =
      sides.find((side) => side.directMatch)?.directMatch ??
      sides.find((side) => side.res.match)?.res.match;
    const suffix = comparisonStatusSuffix(hasIso2022JpSide, ruleMatch, candidates);
    status.text = `${warn ? "$(warning)" : "$(symbol-text)"} ${comparisonLabel(comparison)}${suffix}`;
    status.backgroundColor = warn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    const basisLine = comparisonBasisLine(
      ruleMatch,
      candidates,
      sides.map((side) => side.res),
    );
    const stateLine = hasIso2022JpSide
      ? t(
          "One side is ISO-2022-JP (JIS). Because VS Code cannot open it natively, click to convert and save the working file as UTF-8, etc.",
        )
      : candidates.length > 0
        ? t("Multiple encoding candidates match, so auto-reopen was skipped. Click to choose and reopen.")
        : ruleMatch && sides.some((side) => side.res.actualMismatch)
          ? t(
              "One side differs from the configured rule; displaying the detected encoding to prevent mojibake.",
            )
          : unconfirmedWorkingFile
            ? UNCONFIRMED_RULE_MESSAGE
            : ruleMismatch || targetMismatch
              ? t("One side differs from the expected encoding.")
              : sidesDiffer
                ? hasVirtualSide
                  ? t(
                      "Virtual snapshot sides cannot change encoding due to VS Code limitations; only the working/Git side is aligned. Click to open the working file in a standard editor.",
                    )
                  : t(
                      "Left and right sides use different encodings. Click to align unless inspecting an intentional conversion commit.",
                    )
                : t("Both sides match.");
    status.tooltip = [
      comparison.multiDiff
        ? t("Shows the encodings currently used to read the active file in the multi-file diff.")
        : t("Shows the encodings currently used to read both sides of the Git comparison."),
      basisLine,
      stateLine,
      t(
        "Click to reopen, register an encoding rule, or open the working file in a standard editor. Reopening changes display only and never modifies files.",
      ),
    ].join("\n");
    status.show();
    return;
  }

  if (document.uri.scheme === "git") {
    const fileUri = fileUriForResource(document.uri);
    if (fileUri.scheme !== "file") {
      status.hide();
      return;
    }
    const res = currentSideResolution(document.uri);
    const match = resolveRule(document.uri);
    const actual = encodingInfo(document.encoding).label;
    const candidates = uniqueCandidates([res]);
    if (res.encoding?.toLowerCase() === ISO2022JP_ENCODING) {
      const jisLabel = encodingInfo(ISO2022JP_ENCODING).label;
      status.text = `$(warning) ${t("Git: {0} / Detected: {1} (unsupported by VS Code)", actual, jisLabel)}`;
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      status.tooltip = [
        t("Saved bytes in the Git view are {0}, which VS Code cannot open natively.", jisLabel),
        t("Convert and save the working file as UTF-8, etc., or click to inspect settings."),
      ].join("\n");
      status.show();
      return;
    }
    if (match) {
      const expected = encodingInfo(match.rule.encoding);
      const matches = isDocumentEncodingMatch(document, match);
      status.text = matches
        ? `$(symbol-text) ${t("Git: {0}", expected.label)}`
        : `$(warning) ${t("Git: {0} → {1}", actual, expected.label)}`;
      status.backgroundColor = matches
        ? undefined
        : new vscode.ThemeColor("statusBarItem.warningBackground");
      status.tooltip = [
        res.actualMismatch
          ? t(
              "Saved bytes in the Git view differ from the configured rule ({0}); displaying as {1} to prevent mojibake.",
              expected.label,
              actual,
            )
          : matches
            ? t("Git view matches encoding rule: {0}", match.rule.pattern)
            : t("Git view encoding differs from rule. Click to inspect: {0}", match.rule.pattern),
        t("Click to reopen with another encoding (no save) or manage encoding rules."),
      ].join("\n");
      status.show();
      return;
    }
    if (candidates.length > 0) {
      const candidateLabels = candidates.map((id) => encodingInfo(id).label).join(" / ");
      status.text = `$(warning) ${t("Git: {0} (candidates)", actual)}`;
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      status.tooltip = [
        t("Multiple encoding candidates ({0}) match, so auto-reopen was skipped.", candidateLabels),
        t("Click to reopen from candidates (no save) or set a file/folder encoding rule."),
      ].join("\n");
      status.show();
      return;
    }
    status.text = `$(symbol-text) ${t("Git: {0}", actual)}`;
    status.backgroundColor = undefined;
    status.tooltip = [
      singleGitBasisLine(res),
      t("Click to reopen with another encoding (no save) or set a file/folder encoding rule."),
    ].join("\n");
    status.show();
    return;
  }

  const match = resolveRule(document.uri);
  const inspection = currentFileInspection(document);
  if (!match) {
    const fileUri = fileUriForResource(document.uri);
    if (fileUri.scheme !== "file") {
      status.hide();
      return;
    }
    const actual = encodingInfo(document.encoding).label;
    if (inspection && inspection.status !== "ok") {
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
        if (inspection.detectedEncoding.toLowerCase() === ISO2022JP_ENCODING) {
          status.text = `$(warning) ${t("Open: {0} / Detected: {1} (convertible)", actual, detectedLabel)}`;
          status.tooltip = [
            t("Saved bytes are {0}, which VS Code cannot open natively.", detectedLabel),
            t("Click to convert and save as UTF-8, Shift JIS, etc. with a local backup."),
          ].join("\n");
        } else {
          status.text = `$(warning) ${t("Open: {0} / Detected: {1} (no rule)", actual, detectedLabel)}`;
          status.tooltip = [
            t("Current encoding ({0}) may differ from saved bytes ({1}).", actual, detectedLabel),
            t("Click to reopen with the detected encoding (no save) or register a file/folder encoding rule."),
          ].join("\n");
        }
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        const candidateLabels = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
        status.text = `$(warning) ${t("Open: {0} (candidates · no rule)", actual)}`;
        status.tooltip = [
          t(
            "Current encoding ({0}) does not match saved bytes; multiple candidates ({1}) are possible.",
            actual,
            candidateLabels,
          ),
          t("Click to reopen from candidates (no save) or register an encoding rule."),
        ].join("\n");
      } else {
        status.text = `$(warning) ${t("Open: {0} (decode loss · no rule)", actual)}`;
        status.tooltip = [
          t("Saved bytes could not be decoded without loss using the current encoding ({0}).", actual),
          t("Click to reopen with another encoding (no save) or register a file/folder encoding rule."),
        ].join("\n");
      }
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      status.show();
      return;
    }
    const defaultEncoding = effectiveDefaultFilesEncoding(document);
    const key = document.uri.toString();
    const isGuessed =
      inspection?.status === "ok" && (inspection.basis === "guessed" || guessedUris.has(key));
    if (isGuessed) {
      const candidateLabels = (inspection?.candidates ?? [])
        .map((id) => encodingInfo(id).label)
        .join(" / ");
      status.text = `$(symbol-text) ${actual}`;
      status.backgroundColor = undefined;
      status.tooltip = [
        t(
          "Displaying using the most likely encoding estimated from candidates ({0}) (no rule).",
          candidateLabels,
        ),
        t("Click to reopen from candidates (no save) or register an encoding rule."),
        t("Registered rules are also preserved in VS Code Git comparisons."),
      ].join("\n");
      status.show();
      return;
    }
    if (
      inspection?.status === "ok" &&
      inspection.basis === "detected" &&
      (!sameEncoding(document.encoding, defaultEncoding) || autoDetectedUris.has(key))
    ) {
      status.text = `$(symbol-text) ${actual}`;
      status.backgroundColor = undefined;
      status.tooltip = [
        t("Displaying using the encoding auto-detected from bytes (no rule)."),
        t(
          "Click to reopen with another encoding (no save), register a file/folder encoding rule, or inspect line endings.",
        ),
        t("Registered rules are also preserved in VS Code Git comparisons."),
      ].join("\n");
      status.show();
      return;
    }
    const isRelevantDefaultOverride =
      isManualEncodingOverride(document.uri) || !sameEncoding(document.encoding, defaultEncoding);
    const visibility = effectiveStatusBarVisibility(document.uri);
    if (!isRelevantDefaultOverride && visibility === "relevant") {
      status.backgroundColor = undefined;
      status.hide();
      return;
    }
    const defaultTooltip = [
      t("Current: {0}", actual),
      t("No encoding rule is configured for this file."),
      t(
        "Click to reopen with another encoding (no save), register a file/folder encoding rule, or inspect line endings.",
      ),
      t("Registered rules are also preserved in VS Code Git comparisons."),
    ].join("\n");
    if (!isRelevantDefaultOverride && visibility === "compact") {
      status.text = "$(symbol-text)";
      status.backgroundColor = undefined;
      status.tooltip = defaultTooltip;
      status.show();
      return;
    }
    status.text = `$(symbol-text) ${actual}`;
    status.backgroundColor = undefined;
    status.tooltip = defaultTooltip;
    status.show();
    return;
  }

  const actual = encodingInfo(document.encoding).label;
  const expected = encodingInfo(match.rule.encoding).label;
  const matches = isDocumentEncodingMatch(document, match);
  if (
    !matches &&
    inspection?.ruleConfirmed === false &&
    inspection.status === "ok" &&
    inspection.detectedEncoding &&
    sameEncoding(match.rule.encoding, "utf8bom") &&
    !sameEncoding(inspection.detectedEncoding, match.rule.encoding)
  ) {
    const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
    status.text = `$(warning) ${t("Open: {0} / Rule: {1} (Actual: {2})", actual, expected, detectedLabel)}`;
    status.tooltip = [
      t("Open: {0}", actual),
      t("Rule: {0}", expected),
      t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
      t(
        "Saved bytes are {0}, differing from the configured rule. Click to convert and save or inspect the rule.",
        detectedLabel,
      ),
    ].join("\n");
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    status.show();
    return;
  }
  if (!matches && inspection?.ruleConfirmed === false && inspection.status !== "ok") {
    if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
      const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
      const isIso2022Jp = inspection.detectedEncoding.toLowerCase() === ISO2022JP_ENCODING;
      status.text = `$(warning) ${t("Open: {0} / Rule: {1} (Actual: {2})", actual, expected, detectedLabel)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        isIso2022Jp
          ? t(
              "Saved bytes are {0}, which VS Code cannot open natively. Click to convert and save as UTF-8, etc.",
              detectedLabel,
            )
          : t("Saved bytes appear to be {0}. Click to reopen (no save) or inspect the rule.", detectedLabel),
      ].join("\n");
    } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
      const candidateLabels = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
      status.text = `$(warning) ${t("Open: {0} / Rule: {1} (candidates)", actual, expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t(
          "Saved bytes match neither the current encoding nor the rule; candidates: {0}. Click to inspect and reopen.",
          candidateLabels,
        ),
      ].join("\n");
    } else {
      status.text = `$(warning) ${t("Open: {0} / Rule: {1} (decode loss)", actual, expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t(
          "Saved bytes could not be decoded without loss in either the current encoding or the rule. Click to reopen or inspect.",
        ),
      ].join("\n");
    }
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    status.show();
    return;
  }
  if (matches && inspection && inspection.status !== "ok") {
    if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
      const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
      const isIso2022Jp = inspection.detectedEncoding.toLowerCase() === ISO2022JP_ENCODING;
      status.text = `$(warning) ${t("Rule: {0} (Actual: {1})", expected, detectedLabel)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        isIso2022Jp
          ? t(
              "Saved bytes are {0}, which VS Code cannot open natively. Click to convert and save as UTF-8, etc.",
              detectedLabel,
            )
          : t("Saved bytes appear to be {0}. Click to reopen (no save) or inspect the rule.", detectedLabel),
      ].join("\n");
    } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
      const candidateLabels = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
      status.text = `$(warning) ${t("Rule: {0} (candidates)", expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t(
          "Saved bytes do not match the configured rule; candidates: {0}. Click to inspect and reopen.",
          candidateLabels,
        ),
      ].join("\n");
    } else {
      status.text = `$(warning) ${t("Rule: {0} (decode loss)", expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t(
          "Saved bytes could not be decoded without loss using the configured rule ({0}). Click to reopen or inspect.",
          expected,
        ),
      ].join("\n");
    }
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    status.show();
    return;
  }
  status.text = matches
    ? `$(symbol-text) ${expected}`
    : `$(warning) ${t("Open: {0} / Rule: {1}", actual, expected)}`;
  status.backgroundColor = matches
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
  status.tooltip = [
    t("Open: {0}", actual),
    t("Rule: {0}", expected),
    t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
    t("Click to inspect the rule or reopen with another encoding."),
  ].join("\n");
  status.show();
}
