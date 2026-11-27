// Pre-save encoding and replacement-character warnings for local file documents.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { encodingInfo } from "./rules.js";
import { configurationFor, notifyConfigurationLimit, resolveRule } from "./workspaceRules.js";
import {
  countReplacementCharacters,
  currentFileInspection,
  isDocumentEncodingMatch,
} from "./editorEncoding.js";

function documentBasename(document: vscode.TextDocument): string {
  return path.basename(document.fileName || document.uri.fsPath || document.uri.path);
}

/** Displays a save warning when the document encoding mismatches rules/bytes or introduces U+FFFD. */
export function handleWillSaveWarning(document: vscode.TextDocument): void {
  try {
    if (document.uri.scheme !== "file") return;
    const folder = vscode.workspace.getWorkspaceFolder?.(document.uri);
    const match = resolveRule(document.uri);
    const config = configurationFor(match?.folder ?? folder ?? document.uri);
    const warnOnSave = config.get("warnOnSave", true);
    const filename = documentBasename(document);
    const details: string[] = [];
    const ruleMismatched = !!match && !isDocumentEncodingMatch(document, match);
    if (warnOnSave && ruleMismatched) {
      details.push(
        t(
          "{0} is open as {1}, while the configured encoding rule is {2}.",
          filename,
          encodingInfo(document.encoding).label,
          encodingInfo(match.rule.encoding).label,
        ),
      );
    }
    const inspection = currentFileInspection(document);
    if (
      warnOnSave &&
      (!ruleMismatched || inspection?.ruleConfirmed === false) &&
      inspection &&
      inspection.status !== "ok"
    ) {
      const currentLabel = encodingInfo(document.encoding).label;
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        details.push(
          t(
            "The current encoding of {0} ({1}) may differ from its saved bytes ({2}).",
            filename,
            currentLabel,
            encodingInfo(inspection.detectedEncoding).label,
          ),
        );
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        details.push(
          t(
            "Saving {0} while its encoding is still ambiguous (candidates: {1}).",
            filename,
            inspection.candidates.map((id) => encodingInfo(id).label).join(" / "),
          ),
        );
      } else {
        details.push(
          t(
            "Saving {0} while it could not be decoded without loss in {1}.",
            filename,
            currentLabel,
          ),
        );
      }
    }
    const maxTextLength = configuredFileSizeLimit(config.get<number>("maxFileSizeKB", 5120));
    const documentLength =
      typeof document.lineAt === "function" &&
      typeof document.offsetAt === "function" &&
      typeof document.lineCount === "number" &&
      document.lineCount > 0
        ? document.offsetAt(document.lineAt(document.lineCount - 1).range.end)
        : document.getText().length;
    const rawText = warnOnSave && documentLength <= maxTextLength ? document.getText() : undefined;
    const text =
      rawText !== undefined && Buffer.byteLength(rawText, "utf8") <= maxTextLength
        ? rawText
        : undefined;
    const shouldWarnReplacement =
      text !== undefined &&
      text.includes("\uFFFD") &&
      (match
        ? true
        : !(inspection?.status === "ok" && inspection.initialHadReplacementCharacter) ||
          countReplacementCharacters(text) > inspection.initialReplacementCharacterCount);
    if (shouldWarnReplacement) {
      details.push(
        t("{0} contains replacement characters (U+FFFD). Please verify the original content.", filename),
      );
    }
    if (details.length > 0) {
      void vscode.window.showErrorMessage(t("Save warning: {0}", details.join(" ")));
    }
  } catch (error) {
    if (!notifyConfigurationLimit(error)) throw error;
  }
}
