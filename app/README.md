# Codex Goal — Electron App

Electron + TypeScript + React + Tailwind のクロスプラットフォーム
デスクトップアプリ（macOS / Windows 対応）。

Codex Goal は `codex exec` を非対話モードで繰り返し起動し、最初に設定した
ゴールが達成されるまで新しい Codex セッションをターン単位で走らせます。
各ターンの stdout / stderr / digest / state は `~/.codex-goals/<goal_id>/`
に保存されます。

## Codex 版の実装方針

- 1 ターンごとに `codex -a never --model <model> --sandbox danger-full-access exec --json -C <workspace> -`
  を main プロセスから spawn します。
- prompt は stdin で渡すため、長い goal / digest でもシェル引数長に依存しません。
- `codex exec --json` の JSONL を `formatStream.ts` で人間が読める transcript に変換し、
  `<digest-update>` と `<goal-status>achieved</goal-status>` はそのまま残します。
- 保存先は Claude 版と分離するため `~/.codex-goals` を使います。
- 詳細プランニングを有効にすると、`codex exec` で読み取り専用の計画セッションを開始し、
  以降の質問ラリーは `codex exec resume <thread_id>` で同じ Codex スレッドを継続します。
  `<plan>...</plan>` の候補をユーザーが承認すると `plan.md` に保存され、自走を開始できます。

## 前提条件

- Node.js 20+（開発時のみ）
- `codex` CLI が PATH 上で起動できること
- `codex login` 済みで、`codex exec` が非対話で動くこと

確認:

```bash
codex --help
codex exec --help
```

## 初回セットアップ

```bash
cd /Users/yuyafujita/Projects/codex-goal/app
npm install
```

## 開発モード

```bash
npm run dev
```

## 検証

```bash
npm run typecheck
npm test
```

## 配布用ビルド

```bash
npm run build:mac
npm run dist:mac
npm run build:win
npm run dist:win
```

現在は未署名ビルドです。macOS Gatekeeper / Windows SmartScreen の初回警告は
各 OS の通常手順で許可してください。

## 動作確認シナリオ

1. `npm run dev` で起動
2. ワークスペースを選択
3. 「+ 新規ゴール」から objective を入力
4. 必要なら checker.sh を設定
5. ゴール詳細画面の「開始」をクリック
6. main プロセスが `codex exec` をバックグラウンドで spawn
7. 「ターン出力」に transcript が表示される
8. ターン完了後、digest を引き継いで次の `codex exec` が起動
9. hard checker 成立 or `<goal-status>achieved</goal-status>` で達成
10. 「中止」「一時停止」「再開」が動くことを確認

## 既知の制限

- Codex CLIにはClaudeの `--permission-mode plan` 相当の専用フラグがないため、
  アプリ側で `codex exec` / `codex exec resume` を使って対話型プランニングを構成しています。
- `codex exec` の詳細な JSONL イベント種別は今後の Codex CLI 更新で変わる可能性があるため、
  `formatStream.ts` は未知イベントを無視する保守的な実装にしています。
- 非対話で止まらないことを優先し、実行時は `-a never` と `danger-full-access` を使います。
  信頼できないワークスペースには使わないでください。
