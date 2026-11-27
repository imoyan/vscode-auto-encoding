// Public facade for editor encoding state, detection, reopening, diagnostics, status bar, and inspection UI.

export {
  type FileEncodingInspection,
  UNCONFIRMED_RULE_MESSAGE,
  activeComparisonDocument,
  clearAutoReopenFailure,
  clearCleanFileEncodingInspections,
  clearEncodingDetectionCache,
  clearFileEncodingInspection,
  countReplacementCharacters,
  disposeClosedDocumentState,
  forgetManualEncoding,
  hasAutoReopenFailed,
  isDocumentEncodingMatch,
  isManualEncodingOverride,
  isOpeningDocument,
  markAutoReopenFailed,
  waitForOpeningDocument,
} from "./editorEncodingState.js";

export {
  canReopenWithDetectedEncoding,
  canReopenWithRule,
  currentFileInspection,
  inspectFileDocument,
} from "./editorEncodingDetection.js";

export {
  alignActiveComparison,
  autoReopenWithDetectedEncoding,
  isInAutoAlignedComparison,
  reopenDocumentWithDetectedEncoding,
  reopenWithExpectedEncoding,
} from "./editorEncodingReopen.js";

export { diagnosticFor, updateStatus } from "./editorEncodingStatus.js";

export { inspectActiveFile } from "./editorEncodingInspect.js";
