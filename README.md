# Auto Encoding for VS Code

[日本語 (Japanese)](./README.ja.md)

**Auto Encoding** prevents mojibake in VS Code across regular files and Git diffs—automatically reopening files in the right encoding, managing per-folder/per-file encoding rules, and providing safe one-screen encoding & line-ending conversion with local backup and Undo.

---

## Features

- **Automatic Readable Opening (`autoReopen`)**: Clean files opened in VS Code are automatically reopened when a folder/file rule matches or a unique encoding is detected from bytes (UTF-8, UTF-8 with BOM, UTF-16 LE/BE including BOM-less Japanese text, Shift JIS, EUC-JP, Windows-1252 / ISO-8859-1, and optional GB18030 / Big5 / EUC-KR). Ambiguous files are never auto-reopened; instead, they are highlighted in the status bar with ranked decoded previews so you can choose safely. **ISO-2022-JP (JIS)** files (which VS Code cannot open natively) are also detected automatically with a one-click conversion shortcut to UTF-8, etc.
- **No Mojibake in Git Diffs & Agent Multi-Diffs (`autoReopenGitComparison`)**: Automatically aligns the display encoding of Git comparisons, single Git views, and multi-file diff views (such as the VS Code Agents Window Changes view)—display only, never modifying files. Virtual snapshot sides that VS Code cannot reopen by encoding are safely skipped with a one-click shortcut to open the working file in a standard editor.
- **Agents Window Support**: Declares `capabilities.agentsWindow.supported: true` so Auto Encoding activates automatically inside the VS Code Agents Window (including embedded Changes diffs, outside-workspace local files, and agent worktrees).
- **Per-Folder & Per-File Encoding Rules**: Right-click any folder or file in the Explorer to register an expected encoding (`autoEncoding.rules`), with optional Explorer badges (`SJ`, `U8`, `EJ`, etc.).
- **Safe 1-Screen Conversion + Undo**: Convert a single file or batch-convert a folder (encoding and/or `LF`/`CRLF`) with candidate preview, pre-write verification, automatic local backup, and one-click Undo.
- **Save Warnings**: Warns on save if the open encoding disagrees with the rule, if decode loss is present, or if replacement characters (`U+FFFD`) appear (without blocking saves).
- **Internationalization (i18n)**: Built with VS Code's official `package.nls` and `vscode.l10n` APIs (English and Japanese included; community translations welcome).

---

## Installation

### From GitHub Releases (VSIX)

1. Download `auto-encoding-<version>.vsix` (and optionally `SHA256SUMS`) from [GitHub Releases](https://github.com/imoyan/vscode-auto-encoding/releases).
2. Verify the checksum (optional):
   ```sh
   shasum -a 256 -c SHA256SUMS
   ```
3. Install in VS Code:
   - Command Palette → **Extensions: Install from VSIX...**, or
   - CLI:
     ```sh
     code --install-extension auto-encoding-<version>.vsix
     ```

---

## Usage

- **Editor Title Bar & Status Bar**: Click the `$(symbol-text)` button in the top-right corner of the editor or the Auto Encoding item in the bottom-right status bar to check the active file (or Git diff) and manually reopen in another encoding with one click (display-only, never modifies files).
- **Explorer Context Menu**:
  - **Auto Encoding: Set Folder Encoding** / **Set File Encoding**
  - **Auto Encoding: Convert Files in Folder** / **Convert File Encoding & Line Endings**
- **Command Palette**:
  - `Auto Encoding: Check / Reopen Current File Encoding`
  - `Auto Encoding: Convert File Encoding & Line Endings`
  - `Auto Encoding: Convert Files in Folder`
  - `Auto Encoding: Undo Last Conversion`
  - `Auto Encoding: Set Folder Encoding`
  - `Auto Encoding: Set File Encoding`

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `autoEncoding.rules` | `[]` | Ordered list of `{ "pattern": "legacy/**", "encoding": "shiftjis" }` workspace-relative glob rules. First match wins. |
| `autoEncoding.autoReopen` | `true` | Automatically reopen clean files when a rule matches or a unique encoding is detected. |
| `autoEncoding.autoReopenGitComparison` | `true` | Automatically reopen Git comparisons and single Git views (display only). |
| `autoEncoding.autoDetectEncodings` | `["shiftjis", "eucjp"]` | Priority candidate encodings checked during auto-detection besides UTF-8, BOM, and ISO-2022-JP (`gb18030`, `big5hkscs`, `euckr`, `windows1252`, `iso88591` can be added, or set `[]` to disable legacy multibyte auto-detection). |
| `autoEncoding.warnOnOpen` | `true` | Warn when auto-reopen is disabled or decode loss is detected on open. |
| `autoEncoding.warnOnSave` | `true` | Warn on save for encoding mismatch, decode loss, or `U+FFFD` replacement characters. |
| `autoEncoding.statusBarVisibility` | `"relevant"` | Status bar visibility (`"relevant"` hides on clean default files, `"compact"` shows a minimal icon, `"always"` shows the full label). |
| `autoEncoding.explorerBadges` | `"boundaries"` | Explorer encoding badges (`"boundaries"` shows configured folders and file-level overrides/globs without masking Git colors, `"all"`, or `"none"`). |
| `autoEncoding.conversionExclude` | `**/{.git,.hg,.svn,.vscode,.idea,node_modules,.next,dist,build,.dart_tool}/**` | Glob pattern excluded from batch folder conversion. |
| `autoEncoding.maxFileSizeKB` | `5120` | Max file size in KiB (1–32768) for detection and conversion. |
| `autoEncoding.maxScanFiles` | `5000` | Max file count (1–50000) scanned in a single batch folder conversion. |

### Supported Encodings

`utf8`, `utf8bom`, `shiftjis`, `eucjp`, `gb18030`, `big5hkscs`, `euckr`, `windows1252`, `iso88591`, `utf16le`, `utf16be` (plus `iso2022jp` as a read-only detection & conversion source)

---

## Privacy & Security

- **100% Local**: Auto Encoding performs no network requests and sends no telemetry.
- **Display-Only Reopen**: Reopening a file or Git diff only changes how VS Code decodes the buffer; it never writes to disk.
- **Safe Local Writes**: Conversion uses bounded reads, symlink/path-containment checks, pinned file handles, and local backups under VS Code's `globalStorageUri` so you can undo conversions safely.

For vulnerability reporting, see [SECURITY.md](./SECURITY.md).

---

## Contributing & Translations

Contributions—including new UI translations (`package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json`)—are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 imoyan
