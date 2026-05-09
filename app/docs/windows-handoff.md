# Windows 対応 ハンドオフメモ

最終更新: 2026-05-09

このドキュメントは、Claude Goal アプリの **Windows クロスプラットフォーム化対応**
（`run-turn.sh` / `format-stream.py` の TypeScript 移植 + Windows ビルド設定追加）
について、Mac 上で実装・検証した範囲と、**Windows 実機での未検証項目** を整理する
ためのハンドオフ資料です。

実機検証担当者は本ドキュメントに従って動作確認を行い、問題があれば issue として
記録してください。

---

## 1. 何をやったか（実装サマリ）

| マイルストーン | 内容 | コミット |
|---|---|---|
| M1 | `format-stream.py` を TypeScript の `Transform` ストリームに移植 | `483d76c` |
| M2 | `run-turn.sh` を `runTurn.ts` の `startRunTurn` API に移植 | `7470a69` |
| M3 | `runner.ts` を新 `runTurn` API 呼び出しに切り替え | `dcb9ace` |
| M4 | `process.kill(-pid, ...)` を `terminateProcessTree` 経由に統一（Windows は `taskkill /F /T`） | `297841b` |
| M5 | 旧 `app/resources/run-turn.sh` / `format-stream.py` を削除 | `13913e8` |
| M6 | `electron-builder.yml` に `win:` (NSIS, x64+arm64) と `nsis:` 追加、`dist:win` / `build:win` スクリプト追加 | `7a2d971` |
| M7 | `app/README.md` を Windows 対応版に更新 | `35a69a8` |

### 主要な設計判断

- **bash サブプロセス全廃**: `run-turn.sh` 経由で `claude` を起動していた構造を、
  main プロセスが直接 `child_process.spawn(claudeBin, ...)` する構造に変更。
  OS 抽象化が必要なのは「プロセスツリー kill」と「`claude` バイナリ検出」の 2 点のみに
  局所化された。
- **プロセスツリー kill**: `app/src/main/orchestrator/util.ts` の
  `terminateProcessTree(pid, signal)` で抽象化。POSIX は `process.kill(-pid, sig)` →
  `process.kill(pid, sig)` フォールバック、Windows は `child_process.spawn('taskkill',
  ['/F', '/T', '/PID', String(pid)])`。
- **claude バイナリ検出**: `runTurn.ts:detectClaudeBin` が
  POSIX 候補（`~/.claude/local/claude`、`/opt/homebrew/bin/claude` など）に加えて
  Windows では `claude.cmd` / `claude.exe` を `where claude` フォールバックで探索。

---

## 2. Mac 上で検証済みの項目

以下は本対応中に実コマンドで成功を確認している。

- [x] `npm run typecheck` (errors: 0)
- [x] `npm test` (vitest, 93 / 93 passed: 既存 70 + formatStream 23)
- [x] `npm run dist:mac` 成功 → `release/` に dmg 2 件 (arm64 / x64) 生成
- [x] `npm run dist:win` 成功 → `release/` に NSIS インストーラ 3 件 (universal / x64 / arm64) 生成
  - electron-builder が Wine + winCodeSign + NSIS を自動 DL してビルドが通ることを確認
- [x] Mac 実機での `claude` 連携・ターン進行・heartbeat 監視は M3 段階で `npm run dev` 経由で確認

---

## 3. Windows 実機での未検証項目（要 verify）

Mac 上ではクロスビルドのみで、Windows 実機での実行検証は **行えていない**。
以下は実機テスト担当者が必ず確認してほしい項目。

### A. インストール

- [ ] 生成された `Claude Goal-<version>-x64.exe` (NSIS) を Windows 実機でダブルクリックして起動できるか
- [ ] SmartScreen の「WindowsによってPCが保護されました」警告が出た場合、
      「詳細情報 → 実行」で許可できるか（README に記載した手順通り）
- [ ] インストール先ディレクトリを変更できるか（`allowToChangeInstallationDirectory: true`）
- [ ] arm64 版インストーラが Surface Pro X など arm64 機で起動するか

### B. claude CLI 連携

- [ ] Windows に `claude` CLI を別途インストールし PATH を通した状態で、アプリから
      ゴールを起動するとターンが進行するか
- [ ] `detectClaudeBin` が `claude.cmd` または `claude.exe` を `where claude` 経由で
      正しく検出するか
- [ ] `child_process.spawn` で `.cmd` ファイルを起動する際にコンソールウィンドウが
      チラつかないか（`windowsHide: true` 指定済み）

### C. プロセスツリー kill (`taskkill`)

- [ ] ゴールを途中で「中止」した時に `claude` の子プロセスツリーが完全に終了するか
      （`tasklist | findstr claude` でゾンビが残らないか）
- [ ] アプリ再起動時の `reapOrphanedPids` が前回セッションの孤児 PID を `taskkill /F /T`
      で正しく処理するか
- [ ] `per_turn_timeout` 超過時の自動 kill が機能するか
- [ ] 「⚡即時反映」ボタン（INTERRUPTED フロー）で kill → 次ターン起動が機能するか

### D. ファイルシステム / パス

- [ ] `~/.claude-goals/` （Windows では `%USERPROFILE%/.claude-goals/`）配下に
      goal ディレクトリ・ターンファイルが正しく生成されるか
- [ ] `path.join` で組まれたパスが Windows のバックスラッシュ区切りで動作するか
- [ ] `chokidar` の watcher が Windows で stdout / heartbeat を正しく検知するか

### E. NSIS インストーラ固有

- [ ] アンインストーラが `~/.claude-goals/` を残す挙動になっているか
      （ユーザーデータは残すべき）
- [ ] スタートメニューにショートカットが作成されるか
- [ ] 自動アップデータは未実装なので、新バージョン手動上書きインストールが正常に
      動作するか

### F. ストリーム整形

- [ ] `formatStream.ts` 経由の `claude --output-format stream-json` 出力が Windows でも
      Mac と同等に整形されるか（改行コード CRLF/LF 周りの差分）
- [ ] `*.stdout.jsonl` が utf-8 で正しく書かれるか

---

## 4. 既知の制限・注意点

### 4.1 コード署名なし

Windows 版もコード署名 / EV 署名は実施していない。SmartScreen 警告が必ず出る。
配布する場合は EV Code Signing Certificate の取得が必要。

### 4.2 自動アップデータ未実装

`electron-updater` を未統合。新バージョンは手動再インストールが必要。

### 4.3 Wine ビルドの限界

Mac から `npm run dist:win` で NSIS インストーラまでは生成できているが、
内部の Authenticode 署名やレジストリ書き込み等は Windows 実機でのみ正確に
検証できる。問題があれば Windows 実機で再ビルドする方が安全。

### 4.4 `taskkill` の権限

管理者権限なしで動作するが、別ユーザーが起動した `claude` プロセスは kill できない。
通常は同一ユーザーセッション内の起動なので問題ないはず。

### 4.5 PowerShell vs cmd

`taskkill` 自体は cmd.exe / PowerShell どちらからも呼べるが、`where` コマンドの
挙動は環境変数 PATH に依存。`detectClaudeBin` が失敗した場合、ユーザーに
`claude` のフルパスを設定する UI は未実装（→ 将来課題）。

### 4.6 `checker.sh` （Hard checker）の bash 依存

ゴール作成時の詳細設定で指定できる `checker.sh` （Hard checker）は
`runner.ts:runHardChecker` が `spawn('bash', [checker], ...)` で実行する設計のため、
**bash が PATH に存在しない素の Windows 環境では動作しない**。

回避策（実機検証担当者向け）:
- Hard checker を空欄のまま運用し、judge による soft 判定のみで goal-status を決める
- Git for Windows を入れて `bash.exe` が PATH に通っている環境で利用する
- 中期的には checker を TypeScript / PowerShell に置き換える対応が必要（→ 将来課題）

### 4.7 `claude.cmd` の spawn

`detectClaudeBin` が `.cmd` バッチファイルを返した場合、`runTurn.ts` は
`spawn('cmd.exe', ['/c', claudeBin, ...args])` の経由で起動する
（Node.js の `child_process.spawn` は `.cmd` を直接実行できないため）。
`shell: true` は使わず（プロンプトテキストのインジェクション対策）、
引数は配列のまま `cmd.exe` に渡す。`.exe` が見つかればそちらを優先する候補順。

---

## 5. 実機検証時の推奨手順

1. **Windows 実機を用意**（Windows 10 22H2 以降、または Windows 11 推奨）
2. `claude` CLI を https://docs.claude.com 等の手順でインストールし、PowerShell で
   `claude --version` が応答することを確認
3. `release/Claude Goal-<version>-x64.exe` をダウンロードして実行 → SmartScreen を
   バイパスしてインストール
4. アプリを起動し、ワークスペースを選択（例: `C:\Users\<user>\Documents\test-workspace`）
5. 簡単なゴール（例: 「test.txt を作って "hello" と書く」）を作成して開始
6. ターンが進行し、ターン出力ペインに stdout がライブ表示されることを確認
7. 中止ボタンを押し、`tasklist | findstr claude` でプロセスが残っていないことを確認
8. アプリを終了し、再起動して前回ゴールの status が壊れていないことを確認

---

## 6. 検証で問題が出た場合の連絡

- リポジトリ: GitHub (`yuya-fujita-1201/claude-goal`, private)
- 関連コミット範囲: `483d76c` (M1) ... `35a69a8` (M7)
- 主要な変更ファイル:
  - `app/src/main/orchestrator/runTurn.ts` (新規)
  - `app/src/main/orchestrator/formatStream.ts` (新規)
  - `app/src/main/orchestrator/runner.ts` (差し替え)
  - `app/src/main/orchestrator/util.ts` (`terminateProcessTree` 追加)
  - `app/src/main/goalStore.ts` (`reapOrphanedPids` 修正)
  - `app/electron-builder.yml` (`win:` / `nsis:` 追加)
  - `app/package.json` (`dist:win` / `build:win` 追加)
  - `app/README.md` (Windows 対応記載)

問題発生時は該当コミットを参照しつつ、再現手順とログ（`%USERPROFILE%\.claude-goals\<goal>\logs\orchestrator.log`）を添えて issue 化してください。
