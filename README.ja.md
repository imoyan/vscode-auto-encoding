# Auto Encoding for VS Code

[English](./README.md)

**Auto Encoding** は、VS Code で通常ファイルも Git 比較（差分表示）も文字化けせずに自動で開き直し、フォルダー／ファイル単位の文字コード設定と、バックアップ・元に戻す付きの安全な一括変換を提供する拡張機能です。

---

## 主な機能

- **通常ファイルの自動開き直し（`autoReopen`）**: ルール一致またはバイト列から一意に判定できた文字コード（UTF-8 / UTF-8 BOM / UTF-16 LE・BE / Shift JIS / EUC-JP / Windows-1252 / ISO 8859-1）で未編集ファイルを自動で開き直します。候補が複数ある曖昧なファイルは自動変更せず、ステータスバーからプレビュー付きで安全に選べます。
- **Git 比較・エージェント複数ファイル差分の文字化け防止（`autoReopenGitComparison`）**: 作業中・ステージ済み・コミット履歴・ファイル移動の Git 比較、単体 Git 表示、さらに複数ファイル差分（Multi-Diff / Agents Window の Changes ビュー）でも自動で文字コードを揃えます（表示のみの変更で、ファイルは書き換えません）。VS Code 仕様上文字コード変更できない仮想スナップショット側は安全にスキップし、メニューから作業ファイルを通常エディターで開けます。
- **Agents Window 対応**: `capabilities.agentsWindow.supported: true` を宣言しているため、設定不要で VS Code の Agents Window 内で自動有効化されます（埋め込み Changes 差分・ワークスペース外ローカルファイル・worktree にも対応）。
- **フォルダー・ファイル単位の文字コード設定**: エクスプローラーの右クリックからフォルダーやファイルごとに文字コードルール（`autoEncoding.rules`）を登録でき、エクスプローラー上にバッジ（`SJ`, `U8`, `EJ` など）を表示できます。
- **1 画面の安全な変換＋元に戻す**: 単一ファイル／フォルダー単位で文字コードや改行コード（`LF` / `CRLF`）を変換できます。プレビュー確認・書き込み前再検証・ローカルバックアップ・ワンクリックの「元に戻す」に対応しています。
- **保存時の注意喚起**: ルール不一致・読み込み欠損・置換文字（`U+FFFD`）がある場合に保存時に通知します（保存自体はブロックしません）。
- **多言語対応（i18n）**: VS Code 公式の `package.nls` と `vscode.l10n` に対応し、英語・日本語を標準収録しています。

---

## インストール方法

### GitHub Releases（VSIX）からインストール

1. [GitHub Releases](https://github.com/imoyan/vscode-auto-encoding/releases) から `auto-encoding-<version>.vsix`（および必要に応じて `SHA256SUMS`）をダウンロードします。
2. チェックサムを確認する場合：
   ```sh
   shasum -a 256 -c SHA256SUMS
   ```
3. VS Code にインストールします：
   - コマンドパレット → **拡張機能: VSIX からのインストール...**、または
   - CLI：
     ```sh
     code --install-extension auto-encoding-<version>.vsix
     ```

---

## 使い方

- **ステータスバー**: ステータスバーの項目をクリックすると、現在のファイル（または Git 比較）の文字コード・改行状態の確認、候補プレビューからの開き直し（保存なし）、ルール登録、変換ができます。
- **エクスプローラーの右クリックメニュー**:
  - **Auto Encoding: このフォルダーの文字コードを設定** / **このファイルの文字コードを設定**
  - **Auto Encoding: このフォルダー内のファイルを変換** / **このファイルの文字コード・改行を変換して保存**
- **コマンドパレット**:
  - `Auto Encoding: 現在のファイルの文字コードを確認・開き直す`
  - `Auto Encoding: このファイルの文字コード・改行を変換して保存`
  - `Auto Encoding: このフォルダー内のファイルを変換`
  - `Auto Encoding: 直前の変換を元に戻す`
  - `Auto Encoding: このフォルダーの文字コードを設定`
  - `Auto Encoding: このファイルの文字コードを設定`

---

## 主な設定

| 設定 | 既定値 | 説明 |
|---|---|---|
| `autoEncoding.rules` | `[]` | ワークスペース相対 glob と期待する文字コードの配列。上から順に評価し最初に一致したルールを適用。 |
| `autoEncoding.autoReopen` | `true` | 未編集ファイルをルール一致または一意な自動判定で自動的に開き直す。 |
| `autoEncoding.autoReopenGitComparison` | `true` | Git 比較・単体 Git 表示を自動的に開き直す（表示のみ）。 |
| `autoEncoding.warnOnOpen` | `true` | 自動開き直しオフ時や読み込み欠損時に通知する。 |
| `autoEncoding.warnOnSave` | `true` | 保存時に文字コード不一致・読み込み欠損・置換文字（`U+FFFD`）を通知する。 |
| `autoEncoding.showExplorerBadges` | `true` | 設定済みフォルダー・ルール対象ファイルにエクスプローラーバッジを表示する。 |
| `autoEncoding.conversionExclude` | `**/{.git,.hg,.svn,.vscode,.idea,node_modules,.next,dist,build,.dart_tool}/**` | フォルダー一括変換から除外する glob。 |
| `autoEncoding.maxFileSizeKB` | `5120` | 自動判定・変換の対象にする 1 ファイルあたりの最大サイズ（KiB、最大 32 MiB）。 |
| `autoEncoding.maxScanFiles` | `5000` | 1 回のフォルダー一括変換で走査する最大ファイル数。 |

---

## プライバシーとセキュリティ

- **完全ローカル動作**: 外部通信・テレメトリ送信は一切行いません。
- **表示のみの開き直し**: 開き直し操作はエディターの表示解釈を変えるだけで、ディスク上のファイルは書き換えません。
- **安全なローカル書き込み**: 変換時はサイズ上限付き読み込み・ワークスペース境界検証・ファイルハンドル固定・ローカルバックアップを行い、安全に元に戻せます。

脆弱性報告については [SECURITY.md](./SECURITY.md) をご覧ください。

## ライセンス

[MIT](./LICENSE) © 2026 imoyan
