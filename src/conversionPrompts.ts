// Shared conversion selection types, QuickPick prompts, and auto-source resolution helpers.

import * as vscode from "vscode";
import { t } from "./l10n.js";
import {
  protectedConversionSession,
  bytesEqual,
  looksLikeBinary,
} from "./conversionCore.js";
import { LAST_BACKUP_KEY, PROTECTED_BACKUP_KEY } from "./conversionBackup.js";
import { createWorkspaceCodec } from "./conversionResources.js";
import {
  ENCODINGS,
  ISO2022JP_ENCODING,
  SOURCE_ONLY_ENCODINGS,
  encodingInfo,
  isLegacyMultibyteEncoding,
} from "./rules.js";
import {
  decodeIso2022JpStrict,
  detectUtf16Signal,
  isAsciiCompatibleEncoding,
  type EncodingClassification,
  type LineEndingClassification,
} from "./scanCore.js";
import { extractNonAsciiPreview, rankDecodedCandidates } from "./candidatePreview.js";

export const AUTO_SOURCE = "auto";
export const vscodeCodec = createWorkspaceCodec();

export interface ConversionCandidate extends vscode.QuickPickItem {
  readonly needsConfirmation: boolean;
  readonly uri: vscode.Uri;
  readonly writeUri: vscode.Uri;
  readonly relativePath: string;
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
  readonly originalHash: string;
  readonly originalSize: number;
  readonly originalIdentity: string;
  readonly maxSize: number;
  readonly conversionRootRealPath: string;
  readonly workspaceRootRealPath: string;
  readonly standalone?: boolean;
}

export interface ConversionSelection {
  readonly selected: readonly ConversionCandidate[];
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
  readonly targetLineEnding?: "lf" | "crlf";
}

export interface ConversionPreset extends vscode.QuickPickItem {
  readonly targetEncoding?: string;
  readonly targetLineEnding?: "lf" | "crlf";
}

export function skipReasonLabel(
  reason: "cancelled" | "binary" | "unchanged" | "sourceMismatch" | "targetMismatch",
): string {
  switch (reason) {
    case "cancelled":
      return t("Cancelled");
    case "binary":
      return t("Excluded as binary");
    case "unchanged":
      return t("No conversion needed (unchanged)");
    case "sourceMismatch":
      return t("Source encoding mismatch or unsupported");
    case "targetMismatch":
      return t("Characters unrepresentable in target encoding or conversion failed");
  }
}

export async function decodeSourcePreview(
  bytes: Uint8Array,
  encoding: string | undefined,
): Promise<string | undefined> {
  if (!encoding) {
    return undefined;
  }
  const normalized = encoding.toLowerCase();
  if (normalized === ISO2022JP_ENCODING) {
    const decoded = decodeIso2022JpStrict(bytes);
    return decoded ? extractNonAsciiPreview(decoded, { maxLength: 60 }) : undefined;
  }
  const bomOffset =
    normalized === "utf8bom" &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;
  const decodeTarget = normalized === "utf8bom" ? "utf8" : normalized;
  try {
    const decoded = await vscodeCodec.decode(bytes.subarray(bomOffset), decodeTarget);
    if (decoded.includes("\uFFFD") || looksLikeBinary(decoded)) {
      return undefined;
    }
    const clean = decoded.replace(/^\uFEFF/, "");
    if (!hasNonAsciiCharacter(clean)) {
      return undefined;
    }
    return extractNonAsciiPreview(clean, { maxLength: 60 });
  } catch {
    return undefined;
  }
}

function hasNonAsciiCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x80) {
      return true;
    }
  }
  return false;
}

const COMMON_ENCODING_IDS = new Set(["utf8", "utf8bom", "shiftjis", "eucjp"]);

export async function pickConversionPreset(options: {
  readonly ruleEncoding?: string;
  readonly currentEncodingHint?: string;
  readonly currentEolLabel?: string;
  readonly sourcePreview?: string;
}): Promise<ConversionPreset | undefined> {
  const { ruleEncoding, currentEncodingHint, currentEolLabel, sourcePreview } = options;
  const eolNote = currentEolLabel
    ? t("Keep EOL (current: {0})", currentEolLabel)
    : t("Keep EOL");

  const makeEncodingItem = (encoding: (typeof ENCODINGS)[number]): ConversionPreset => {
    const tags: string[] = [encoding.id, eolNote];
    if (encoding.id === ruleEncoding) tags.push(t("Rule target"));
    if (encoding.id === currentEncodingHint) tags.push(t("Current encoding"));
    return {
      label: encoding.label,
      description: tags.join(" · "),
      targetEncoding: encoding.id,
    };
  };

  // Hide "current encoding + keep EOL" for single files to avoid no-op choices.
  const eligible = ENCODINGS.filter((encoding) => encoding.id !== currentEncodingHint);
  const commonEncodings = [
    ...eligible.filter((encoding) => encoding.id === ruleEncoding),
    ...eligible.filter(
      (encoding) => encoding.id !== ruleEncoding && COMMON_ENCODING_IDS.has(encoding.id),
    ),
  ];
  const secondaryEncodings = eligible.filter(
    (encoding) => encoding.id !== ruleEncoding && !COMMON_ENCODING_IDS.has(encoding.id),
  );

  const items: ConversionPreset[] = commonEncodings.map(makeEncodingItem);

  const comboTargets = [
    "utf8",
    "shiftjis",
    ...(ruleEncoding && ruleEncoding !== "utf8" && ruleEncoding !== "shiftjis"
      ? [ruleEncoding]
      : []),
  ];
  for (const id of comboTargets) {
    const info = encodingInfo(id);
    items.push(
      {
        label: `${info.label} + LF`,
        description: t("{0} · Convert encoding and line endings", id),
        targetEncoding: id,
        targetLineEnding: "lf",
      },
      {
        label: `${info.label} + CRLF`,
        description: t("{0} · Convert encoding and line endings", id),
        targetEncoding: id,
        targetLineEnding: "crlf",
      },
    );
  }

  if (currentEncodingHint !== ISO2022JP_ENCODING) {
    items.push(
      {
        label: t("Line endings only → LF"),
        description: t("Keep current encoding"),
        targetLineEnding: "lf",
      },
      {
        label: t("Line endings only → CRLF"),
        description: t("Keep current encoding"),
        targetLineEnding: "crlf",
      },
    );
  }
  items.push(...secondaryEncodings.map(makeEncodingItem));

  let placeHolder: string;
  if (!currentEncodingHint) {
    placeHolder = t("Select target encoding or line ending");
  } else {
    const currentLabel = encodingInfo(currentEncodingHint).label;
    if (currentEolLabel && sourcePreview) {
      placeHolder = t(
        "Current: {0} / {1} (Preview: {2}) — Select target format",
        currentLabel,
        currentEolLabel,
        sourcePreview,
      );
    } else if (sourcePreview) {
      placeHolder = t("Current: {0} (Preview: {1}) — Select target format", currentLabel, sourcePreview);
    } else if (currentEolLabel) {
      placeHolder = t("Current: {0} / {1} — Select target format", currentLabel, currentEolLabel);
    } else {
      placeHolder = t("Current: {0} — Select target format", currentLabel);
    }
  }

  return vscode.window.showQuickPick(items, {
    title: t("Select Target Format"),
    placeHolder,
  });
}

export async function confirmProtectedBackup(state: vscode.Memento): Promise<boolean> {
  const previousSession = protectedConversionSession(
    state.get<unknown>(LAST_BACKUP_KEY),
    state.get<unknown>(PROTECTED_BACKUP_KEY),
  );
  if (!previousSession) {
    return true;
  }
  const protectedUri = vscode.Uri.parse(previousSession);
  const keepAction = t("Keep Backup and Continue");
  const proceed = await vscode.window.showWarningMessage(
    t(
      "The previous restore is incomplete. It will no longer be the automatic Undo target, but do you want to keep the backup at {0} and continue?",
      protectedUri.fsPath,
    ),
    { modal: true },
    keepAction,
  );
  return proceed === keepAction;
}

export function replacingBackupNotice(state: vscode.Memento): string {
  const storedBackup = state.get<unknown>(LAST_BACKUP_KEY);
  const replacingBackup =
    typeof storedBackup === "string" &&
    storedBackup.length > 0 &&
    storedBackup !== state.get<unknown>(PROTECTED_BACKUP_KEY);
  return replacingBackup
    ? ` ${t("Once the new conversion succeeds, the previous backup will be deleted and cannot be undone.")}`
    : "";
}

export function findOpenDocumentEncoding(
  uri: vscode.Uri,
  writeUri: vscode.Uri,
): string | undefined {
  const keys = new Set([uri.toString(), writeUri.toString()]);
  return vscode.workspace.textDocuments
    .find((document) => !document.isClosed && keys.has(document.uri.toString()))
    ?.encoding?.toLowerCase();
}

export async function isLosslessRoundTrip(
  bytes: Uint8Array,
  encoding: string,
  isCancellationRequested: () => boolean,
): Promise<{ readonly valid: boolean; readonly text?: string }> {
  if (isCancellationRequested()) return { valid: false };
  try {
    const text = await vscodeCodec.decode(bytes, encoding);
    if (isCancellationRequested()) return { valid: false };
    if (looksLikeBinary(text)) return { valid: false };
    const encoded = await vscodeCodec.encode(text, encoding);
    if (isCancellationRequested()) return { valid: false };
    if (bytesEqual(bytes, encoded)) {
      return { valid: true, text };
    }
    if (encoding === "shiftjis" && !text.includes("\uFFFD")) {
      try {
        if (new TextDecoder("shift_jis", { fatal: true }).decode(bytes) === text) {
          return { valid: true, text };
        }
      } catch {
        // Invalid Shift JIS bytes fall through to invalid.
      }
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

export async function resolveAutoSourceEncoding(
  bytes: Uint8Array,
  classification: EncodingClassification,
  options: {
    readonly convertingEncoding: boolean;
    readonly fileRuleEncoding?: string;
    readonly openDocEncoding?: string;
    readonly manualOverride: boolean;
    readonly allowRuleDisambiguation: boolean;
    readonly isCancellationRequested: () => boolean;
  },
): Promise<
  | { readonly kind: "resolved"; readonly encoding: string }
  | { readonly kind: "binary" }
  | { readonly kind: "ambiguous" }
> {
  if (classification.kind === "skip") {
    return { kind: "binary" };
  }
  const ruleEncoding = options.fileRuleEncoding?.toLowerCase();
  const openEncoding = options.openDocEncoding?.toLowerCase();
  if (classification.kind === "ascii") {
    if (!options.convertingEncoding && ruleEncoding && isAsciiCompatibleEncoding(ruleEncoding)) {
      return { kind: "resolved", encoding: ruleEncoding };
    }
    if (openEncoding && isAsciiCompatibleEncoding(openEncoding)) {
      return { kind: "resolved", encoding: openEncoding };
    }
    return { kind: "resolved", encoding: "utf8" };
  }
  if (
    (classification.kind === "match" || classification.kind === "mismatch") &&
    classification.detectedEncoding
  ) {
    const detected = classification.detectedEncoding.toLowerCase();
    if (isLegacyMultibyteEncoding(detected)) {
      const western =
        options.manualOverride && (openEncoding === "windows1252" || openEncoding === "iso88591")
          ? openEncoding
          : ruleEncoding === "windows1252" || ruleEncoding === "iso88591"
            ? ruleEncoding
            : undefined;
      if (
        western &&
        (await isLosslessRoundTrip(bytes, western, options.isCancellationRequested)).valid
      ) {
        if (options.allowRuleDisambiguation && !options.convertingEncoding && ruleEncoding) {
          const ruleRoundTrip = await isLosslessRoundTrip(
            bytes,
            ruleEncoding,
            options.isCancellationRequested,
          );
          if (ruleRoundTrip.valid) {
            return { kind: "resolved", encoding: ruleEncoding };
          }
        }
        return { kind: "ambiguous" };
      }
    }
    return { kind: "resolved", encoding: detected };
  }
  if (options.allowRuleDisambiguation && !options.convertingEncoding && ruleEncoding) {
    const ruleRoundTrip = await isLosslessRoundTrip(
      bytes,
      ruleEncoding,
      options.isCancellationRequested,
    );
    if (ruleRoundTrip.valid) {
      return { kind: "resolved", encoding: ruleEncoding };
    }
  }
  return { kind: "ambiguous" };
}

export async function pickSingleSourceEncoding(
  bytes: Uint8Array,
  classification: EncodingClassification,
  options: {
    readonly fileRuleEncoding?: string;
    readonly openDocEncoding?: string;
    readonly manualOverride: boolean;
  },
): Promise<{ readonly encoding?: string; readonly noneAvailable?: boolean }> {
  const utf16Signal = detectUtf16Signal(bytes);
  const ruleEncoding = options.fileRuleEncoding?.toLowerCase();
  const openEncoding = options.openDocEncoding?.toLowerCase();
  const relevantUtf16 = new Set(
    [
      utf16Signal,
      ruleEncoding,
      openEncoding,
      ...(classification.candidates?.map((id) => id.toLowerCase()) ?? []),
    ].filter((value): value is string => !!value),
  );
  const candidateResults = new Map<string, string>();
  for (const entry of ENCODINGS) {
    if ((entry.id === "utf16le" || entry.id === "utf16be") && !relevantUtf16.has(entry.id)) {
      continue;
    }
    const roundTrip = await isLosslessRoundTrip(bytes, entry.id, () => false);
    if (roundTrip.valid && roundTrip.text !== undefined) {
      candidateResults.set(entry.id, roundTrip.text);
    }
  }
  if (candidateResults.size === 0) {
    return { noneAvailable: true };
  }
  const classificationSet = new Set<string>([
    ...(classification.detectedEncoding ? [classification.detectedEncoding.toLowerCase()] : []),
    ...(classification.candidates?.map((id) => id.toLowerCase()) ?? []),
  ]);
  const ranked = rankDecodedCandidates(
    [...candidateResults.entries()].map(([encoding, text]) => ({ encoding, text })),
  );
  const rankedById = new Map(ranked.map((entry) => [entry.encoding, entry]));
  const rankedOrder = ranked.map((entry) => entry.encoding);
  const preferredOrder: string[] = [];
  if (
    openEncoding &&
    (options.manualOverride || openEncoding !== "utf8") &&
    candidateResults.has(openEncoding)
  ) {
    preferredOrder.push(openEncoding);
  }
  if (ruleEncoding && candidateResults.has(ruleEncoding)) {
    preferredOrder.push(ruleEncoding);
  }
  for (const id of rankedOrder) {
    if (classificationSet.has(id)) {
      preferredOrder.push(id);
    }
  }
  for (const id of rankedOrder) {
    preferredOrder.push(id);
  }
  const orderedIds = [...new Set(preferredOrder)];
  const items = orderedIds.map((id) => {
    const info = rankedById.get(id);
    const tags: string[] = [id];
    if (info?.likely) tags.push(t("Likely"));
    if (classificationSet.has(id)) tags.push(t("Candidate"));
    if (id === openEncoding) tags.push(t("Current view"));
    if (id === ruleEncoding) tags.push(t("Rule target"));
    return {
      label: encodingInfo(id).label,
      description: tags.join(" · "),
      detail: info?.preview ?? previewText(candidateResults.get(id)!),
      encoding: id,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: t("Select Current Encoding"),
    placeHolder: t(
      "Check the preview and select the encoding that reads the saved file correctly.",
    ),
  });
  return { encoding: picked?.encoding };
}

export async function pickFolderSourceEncoding(
  title: string,
  excludedEncoding?: string,
  placeHolder?: string,
  includeSourceOnly = false,
): Promise<string | undefined> {
  const sourceEntries = includeSourceOnly ? [...ENCODINGS, ...SOURCE_ONLY_ENCODINGS] : ENCODINGS;
  const items = [
    {
      label: t("Auto-detect (uniquely identifiable files only)"),
      description: t("auto · BOM, ISO-2022-JP, UTF-8, UTF-16, unambiguous legacy encodings"),
      encoding: AUTO_SOURCE,
    },
    ...sourceEntries
      .filter((encoding) => encoding.id !== excludedEncoding)
      .map((encoding) => ({
        label: encoding.label,
        description: encoding.id,
        encoding: encoding.id,
      })),
  ];
  const choice = await vscode.window.showQuickPick(items, { title, placeHolder });
  return choice?.encoding;
}

export function formatLineEndingSummary(classification: LineEndingClassification): string {
  if (classification.kind === "mixed") {
    return classification.styles.map((style) => style.toUpperCase()).join("+");
  }
  return classification.kind === "none" ? t("No EOL") : classification.kind.toUpperCase();
}

export async function pickFolder(suppliedUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (suppliedUri) {
    return suppliedUri;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t("Convert Files"),
    title: t("Select a folder to convert"),
  });
  return selected?.[0];
}

export function previewText(text: string): string {
  const sample = text.slice(0, 4096);
  const sanitized = Array.from(sample, (character) => {
    const code = character.charCodeAt(0);
    const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    return control ? "\uFFFD" : character;
  }).join("");
  const compact = sanitized.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact || t("(empty text)");
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
