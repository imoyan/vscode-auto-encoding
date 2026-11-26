# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-11-26

### Fixed
- Queued and drained all concurrent embedded `git:` document hints in `alignActiveComparison()` (deduplicated, bounded) so rapid multi-file openings in Agents Window inline views never drop intermediate files.

## [0.2.1] - 2026-11-26

### Fixed
- Declared `"capabilities": { "agentsWindow": { "supported": true } }` in `package.json` so VS Code automatically loads Auto Encoding inside the Agents Window without requiring manual `extensions.supportAgentsWindow` configuration.
- Added embedded diff fallback alignment for `git:` documents rendered outside standard `tabGroups` (such as inline Changes views in the Agents Window).

## [0.2.0] - 2026-11-26

### Added
- Support for multi-file diff tabs (`TabInputTextMultiDiff`, such as the VS Code Agents Window Changes view), aligning loaded local/Git sides with focus priority without breaking the unified multi-diff layout.
- Safe handling of virtual snapshot schemes (e.g. `chat-editing-snapshot-text-model:`) with a one-click **Open Working File in Standard Editor** action in the status bar QuickPick.
- Support for outside-workspace local files (e.g. agent worktrees) for automatic encoding detection, auto-reopening, status bar inspection, and save warnings (workspace diagnostics remain scoped to workspace folders).

### Changed
- Redesigned extension icon (`media/icon.png`) with a full-bleed transparent rounded-square CJK encoding motif (`◆?` ⇄ `あ・한・漢`) for clear visibility at 42px in the Extensions view.
- Folder batch conversion now includes files inheriting the selected folder's own rule when converting to a different target encoding, while still protecting files with conflicting child rules.

## [0.1.0] - 2026-11-26

### Added
- Initial public release of **Auto Encoding** (`imoyan.auto-encoding`).
- Automatic encoding reopening for clean workspace files (`autoEncoding.autoReopen`) using configured rules or unique byte detection.
- Automatic encoding alignment for Git comparisons and single Git views (`autoEncoding.autoReopenGitComparison`).
- Ranked decoded previews for ambiguous encoding candidates in the status bar QuickPick.
- Per-folder and per-file encoding rules (`autoEncoding.rules`) with Explorer badges (`autoEncoding.showExplorerBadges`).
- One-screen encoding and line-ending (`LF` / `CRLF`) conversion for single files and folders, with local backup and Undo (`autoEncoding.undoLastConversion`).
- Save warnings for encoding mismatch, decode loss, and `U+FFFD` replacement characters (`autoEncoding.warnOnSave`).
- Official VS Code internationalization (`package.nls` + `vscode.l10n`) with English (default) and Japanese (`ja`) support.
