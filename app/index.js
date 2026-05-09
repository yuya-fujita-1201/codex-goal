"use strict";
const electron = require("electron");
const path = require("node:path");
const utils = require("@electron-toolkit/utils");
const node_fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const node_events = require("node:events");
const node_child_process = require("node:child_process");
const chokidar = require("chokidar");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const chokidar__namespace = /* @__PURE__ */ _interopNamespaceDefault(chokidar);
const IPC = {
  Workspace: {
    Select: "workspace:select",
    RecentList: "workspace:recent:list",
    RecentAdd: "workspace:recent:add",
    RecentRemove: "workspace:recent:remove"
  },
  Goal: {
    List: "goal:list",
    Get: "goal:get",
    Create: "goal:create",
    Delete: "goal:delete",
    Turns: "goal:turns",
    TurnStdout: "goal:turns:stdout"
  },
  Runner: {
    Start: "runner:start",
    Abort: "runner:abort",
    Pause: "runner:pause",
    Resume: "runner:resume",
    Snapshot: "runner:snapshot"
  },
  Events: {
    GoalEvent: "goal:event"
  }
};
const GOALS_ROOT$1 = path.join(os.homedir(), ".claude-goals");
const DEFAULT_PROMPT_TEMPLATE = `# Claude Goal — Continuation Turn

あなたは長時間自走するゴール達成エージェントの **1 ターン分** を実行しています。
本ターンの最後に出力を整えれば、外側オーケストレータが次のターンを別の新しいプロセスで起動します。

## ゴール

{{OBJECTIVE}}

## これまでの作業の長期記憶（block summaries）

直近のブロック単位で要約された過去ターンの記録です。同じ失敗を繰り返さないために
「失敗したアプローチ」セクションを必ず尊重してください。

{{BLOCKS}}

## これまでの作業状況（digest）

{{DIGEST}}

## 残り budget

- ターン: {{TURNS_USED}} / {{MAX_TURNS}}
- 経過時間: 約 {{ELAPSED_MIN}} 分
- per-turn timeout: {{PER_TURN_TIMEOUT}} 秒

## このターンの規律（必ず守ること）

1. ゴール達成に向けて **次の最小ステップを 1 つだけ** 実行せよ。複数ステップを一気にやらない。
2. ユーザーへの確認は求めない。判断は自律的に行え。
3. 作業ディレクトリ（cwd）はワークスペースに固定されている。そこから外れない。
4. 破壊的操作（rm -rf, force push など）は避ける。必要なら digest に記録して停止する。
5. 出力の最後に必ず以下の **digest-update ブロック** を含めよ。これが次ターンへの引き継ぎになる。

## 出力フォーマット

通常通り作業ログを出した後、最後に必ず：

\`\`\`
<digest-update>
## 達成済みサブタスク
- [x] ...

## 現在のファイル状態スナップショット
- ...

## 試したアプローチと失敗理由
- ...

## 未解決ブロッカー
- ...

## 次の最小ステップ候補
- ...

## 直近ターン要約
- Turn {{CURRENT_TURN}}: <今ターンで何をやったか 1〜2 行>
</digest-update>
\`\`\`

ゴールに到達したと判断したら、digest-update の **後に** 以下を追記せよ：

\`\`\`
<goal-status>achieved</goal-status>
\`\`\`

それでは作業を開始してください。
`;
const INITIAL_DIGEST = "（まだ作業履歴はありません。最初のターンです。）\n";
function slugify(input) {
  return input.toLowerCase().normalize("NFKD").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "goal";
}
function shortId() {
  return crypto.randomBytes(3).toString("hex");
}
async function ensureGoalsRoot() {
  await node_fs.promises.mkdir(GOALS_ROOT$1, { recursive: true });
}
async function readJson(p) {
  try {
    const data = await node_fs.promises.readFile(p, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}
async function writeJson(p, value) {
  await node_fs.promises.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}
async function listGoals(workspacePath) {
  await ensureGoalsRoot();
  const entries = await node_fs.promises.readdir(GOALS_ROOT$1, { withFileTypes: true });
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const goalDir2 = path.join(GOALS_ROOT$1, entry.name);
    const state = await readJson(path.join(goalDir2, "state.json"));
    const budget = await readJson(path.join(goalDir2, "budget.json"));
    if (!state || !budget) continue;
    if (workspacePath && state.workspace_path !== workspacePath) continue;
    let objectivePreview = "";
    try {
      const obj = await node_fs.promises.readFile(path.join(goalDir2, "objective.md"), "utf8");
      objectivePreview = obj.split("\n").slice(0, 6).join("\n").slice(0, 400);
    } catch {
      objectivePreview = "(objective not readable)";
    }
    summaries.push({
      goal_id: entry.name,
      objective_preview: objectivePreview,
      state,
      budget,
      has_checker: node_fs.existsSync(path.join(goalDir2, "checker.sh"))
    });
  }
  summaries.sort(
    (a, b) => new Date(b.state.created_at).getTime() - new Date(a.state.created_at).getTime()
  );
  return summaries;
}
async function getGoal(goalId) {
  const goalDir2 = path.join(GOALS_ROOT$1, goalId);
  if (!node_fs.existsSync(goalDir2)) return null;
  const state = await readJson(path.join(goalDir2, "state.json"));
  const budget = await readJson(path.join(goalDir2, "budget.json"));
  if (!state || !budget) return null;
  let objective = "";
  try {
    objective = await node_fs.promises.readFile(path.join(goalDir2, "objective.md"), "utf8");
  } catch {
    objective = "";
  }
  return {
    goal_id: goalId,
    objective_preview: objective,
    state,
    budget,
    has_checker: node_fs.existsSync(path.join(goalDir2, "checker.sh"))
  };
}
async function createGoal(params) {
  await ensureGoalsRoot();
  const goalId = `${slugify(params.goal_id_slug)}-${shortId()}`;
  const goalDir2 = path.join(GOALS_ROOT$1, goalId);
  if (node_fs.existsSync(goalDir2)) {
    throw new Error(`Goal directory already exists: ${goalDir2}`);
  }
  const workspaceAbs = path.resolve(params.workspace_path);
  await node_fs.promises.mkdir(workspaceAbs, { recursive: true });
  await node_fs.promises.mkdir(path.join(goalDir2, "turns"), { recursive: true });
  await node_fs.promises.mkdir(path.join(goalDir2, "history", "raw"), { recursive: true });
  await node_fs.promises.mkdir(path.join(goalDir2, "history", "blocks"), { recursive: true });
  await node_fs.promises.mkdir(path.join(goalDir2, "logs"), { recursive: true });
  await node_fs.promises.writeFile(path.join(goalDir2, "objective.md"), params.objective, "utf8");
  await node_fs.promises.writeFile(path.join(goalDir2, "digest.md"), INITIAL_DIGEST, "utf8");
  await node_fs.promises.writeFile(
    path.join(goalDir2, "prompt-template.md"),
    DEFAULT_PROMPT_TEMPLATE,
    "utf8"
  );
  const now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const state = {
    goal_id: goalId,
    status: "pending",
    // Phase 1: created but orchestrator not started yet
    created_at: now,
    updated_at: now,
    turns: 0,
    last_turn_id: null,
    last_result: null,
    workspace_path: workspaceAbs,
    parent_goal_id: null
  };
  await writeJson(path.join(goalDir2, "state.json"), state);
  await writeJson(path.join(goalDir2, "budget.json"), params.budget);
  if (params.checker_script && params.checker_script.trim().length > 0) {
    const checkerPath = path.join(goalDir2, "checker.sh");
    await node_fs.promises.writeFile(checkerPath, params.checker_script, "utf8");
    await node_fs.promises.chmod(checkerPath, 493);
  }
  const created = await getGoal(goalId);
  if (!created) throw new Error("Failed to read back created goal");
  return created;
}
async function deleteGoal(goalId) {
  const goalDir2 = path.join(GOALS_ROOT$1, goalId);
  if (!node_fs.existsSync(goalDir2)) return;
  await node_fs.promises.rm(goalDir2, { recursive: true, force: true });
}
const KIND_DIRS = [
  ["turn", "turns"],
  ["block", "blocks"],
  ["judge", "judge"]
];
async function listTurns(goalId) {
  const dir = path.join(GOALS_ROOT$1, goalId);
  if (!node_fs.existsSync(dir)) return [];
  const entries = [];
  for (const [kind, sub] of KIND_DIRS) {
    const subDir = path.join(dir, sub);
    if (!node_fs.existsSync(subDir)) continue;
    let names = [];
    try {
      names = await node_fs.promises.readdir(subDir);
    } catch {
      continue;
    }
    const byId = /* @__PURE__ */ new Map();
    for (const name of names) {
      const m = name.match(/^([a-z]+-\d+)\.(prompt|stdout|stderr|result|heartbeat)$/);
      if (!m) continue;
      const id = m[1];
      try {
        const stat = await node_fs.promises.stat(path.join(subDir, name));
        const cur = byId.get(id);
        if (!cur || stat.mtimeMs > cur.mtime) byId.set(id, { mtime: stat.mtimeMs });
      } catch {
      }
    }
    for (const [workId, meta] of byId) {
      let result = null;
      try {
        const r = await node_fs.promises.readFile(path.join(subDir, `${workId}.result`), "utf8");
        result = r.trim();
      } catch {
      }
      entries.push({
        kind,
        workId,
        result,
        mtime: new Date(meta.mtime).toISOString(),
        hasStdout: node_fs.existsSync(path.join(subDir, `${workId}.stdout`)),
        hasPrompt: node_fs.existsSync(path.join(subDir, `${workId}.prompt`))
      });
    }
  }
  entries.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  return entries;
}
async function readTurnStdout(goalId, workId, kind) {
  const sub = kind === "turn" ? "turns" : kind === "block" ? "blocks" : "judge";
  const file = path.join(GOALS_ROOT$1, goalId, sub, `${workId}.stdout`);
  return node_fs.promises.readFile(file, "utf8").catch(() => "");
}
const PID_SUBDIRS = ["turns", "blocks", "judge"];
async function reapOrphanedPids(goalDir2) {
  const reaped = [];
  for (const sub of PID_SUBDIRS) {
    const subDir = path.join(goalDir2, sub);
    let names;
    try {
      names = await node_fs.promises.readdir(subDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".pid")) continue;
      const pidFile = path.join(subDir, name);
      let pid;
      try {
        const raw = await node_fs.promises.readFile(pidFile, "utf8");
        pid = parseInt(raw.trim(), 10);
      } catch {
        continue;
      }
      if (!Number.isFinite(pid) || pid <= 1) {
        await node_fs.promises.unlink(pidFile).catch(() => {
        });
        continue;
      }
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        try {
          process.kill(-pid, "SIGTERM");
          reaped.push(pid);
        } catch {
          try {
            process.kill(pid, "SIGTERM");
            reaped.push(pid);
          } catch {
          }
        }
      } else {
        await node_fs.promises.unlink(pidFile).catch(() => {
        });
      }
    }
  }
  return reaped;
}
async function markOrphanedActiveAsPaused() {
  await ensureGoalsRoot();
  const entries = await node_fs.promises.readdir(GOALS_ROOT$1, { withFileTypes: true });
  const updated = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const goalDir2 = path.join(GOALS_ROOT$1, entry.name);
    const statePath = path.join(goalDir2, "state.json");
    const state = await readJson(statePath);
    if (!state) continue;
    try {
      await reapOrphanedPids(goalDir2);
    } catch {
    }
    if (state.status === "active") {
      const next = {
        ...state,
        status: "paused",
        updated_at: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z")
      };
      await writeJson(statePath, next);
      updated.push(state.goal_id);
    }
  }
  return updated;
}
const MAX_RECENT = 10;
function storePath() {
  return path.join(electron.app.getPath("userData"), "recent-workspaces.json");
}
async function read() {
  try {
    const data = await node_fs.promises.readFile(storePath(), "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}
async function write(items) {
  await node_fs.promises.mkdir(path.dirname(storePath()), { recursive: true });
  await node_fs.promises.writeFile(storePath(), JSON.stringify(items, null, 2), "utf8");
}
async function listRecent() {
  const items = await read();
  const surviving = [];
  for (const item of items) {
    try {
      const stat = await node_fs.promises.stat(item.path);
      if (stat.isDirectory()) surviving.push(item);
    } catch {
    }
  }
  if (surviving.length !== items.length) await write(surviving);
  return surviving;
}
async function addRecent(workspacePath) {
  const items = await read();
  const filtered = items.filter((it) => it.path !== workspacePath);
  filtered.unshift({
    path: workspacePath,
    last_opened_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  const trimmed = filtered.slice(0, MAX_RECENT);
  await write(trimmed);
  return trimmed;
}
async function removeRecent(workspacePath) {
  const items = await read();
  const filtered = items.filter((it) => it.path !== workspacePath);
  await write(filtered);
  return filtered;
}
const GOALS_ROOT = path.join(os.homedir(), ".claude-goals");
function goalDir(goalId) {
  return path.join(GOALS_ROOT, goalId);
}
function turnPaths(goalId, turnId, subdir = "turns") {
  const base = path.join(goalDir(goalId), subdir);
  return {
    prompt: path.join(base, `${turnId}.prompt`),
    stdout: path.join(base, `${turnId}.stdout`),
    stderr: path.join(base, `${turnId}.stderr`),
    result: path.join(base, `${turnId}.result`),
    heartbeat: path.join(base, `${turnId}.heartbeat`)
  };
}
function resourcePath(file) {
  if (electron.app.isPackaged) {
    return path.join(process.resourcesPath, "resources", file);
  }
  return path.join(electron.app.getAppPath(), "resources", file);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isoNow() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
}
function formatTurnId(num) {
  return `turn-${String(num).padStart(3, "0")}`;
}
function escapeForOsa(input) {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
async function readBlocksDigest(goalId) {
  const blocksDir = path.join(goalDir(goalId), "history", "blocks");
  let entries;
  try {
    entries = await node_fs.promises.readdir(blocksDir);
  } catch {
    return "";
  }
  const blockFiles = entries.filter((f) => /^block-\d+\.md$/.test(f)).sort().slice(-6);
  if (blockFiles.length === 0) return "";
  const parts = [];
  for (const f of blockFiles) {
    try {
      const content = await node_fs.promises.readFile(path.join(blocksDir, f), "utf8");
      parts.push(`### ${f}
${content.trim()}`);
    } catch {
    }
  }
  return parts.join("\n\n");
}
async function buildPrompt(args) {
  const dir = goalDir(args.state.goal_id);
  const tmpl = await node_fs.promises.readFile(path.join(dir, "prompt-template.md"), "utf8");
  const objective = await node_fs.promises.readFile(path.join(dir, "objective.md"), "utf8").catch(() => "");
  const digest = await node_fs.promises.readFile(path.join(dir, "digest.md"), "utf8").catch(() => "");
  const blocks = await readBlocksDigest(args.state.goal_id);
  const elapsedMin = Math.max(
    0,
    Math.round((Date.now() - new Date(args.state.created_at).getTime()) / 6e4)
  );
  const subs = {
    "{{OBJECTIVE}}": objective.trim(),
    "{{DIGEST}}": digest.trim(),
    "{{BLOCKS}}": blocks.trim() || "（まだ block summary はありません）",
    "{{TURNS_USED}}": String(args.turnNum),
    "{{MAX_TURNS}}": String(args.budget.max_turns),
    "{{ELAPSED_MIN}}": String(elapsedMin),
    "{{PER_TURN_TIMEOUT}}": String(args.budget.per_turn_timeout_seconds),
    "{{CURRENT_TURN}}": args.turnId
  };
  let out = tmpl;
  for (const [k, v] of Object.entries(subs)) {
    out = out.split(k).join(v);
  }
  return out;
}
function extractDigestUpdate(stdout) {
  const m = stdout.match(/<digest-update>([\s\S]*?)<\/digest-update>/);
  if (!m) return null;
  return m[1].replace(/^\n+/, "").replace(/\n+$/, "") + "\n";
}
function hasGoalAchievedToken(stdout) {
  return /<goal-status>\s*achieved\s*<\/goal-status>/.test(stdout);
}
const BLOCK_PROMPT_TEMPLATE = `# Block Summary Worker

あなたは長時間自走するゴール達成エージェントの **ブロック要約 worker** です。
本タスクは{{FROM}}〜{{TO}}ターン分の生ログを読んで、
後続ターンが効率よく状況把握できる**圧縮された要約**を作成することです。

## ゴール

{{OBJECTIVE}}

## 圧縮対象のターン出力

{{TURNS_RAW}}

## 規律

- 純粋な要約タスク。新たに作業を行わない。
- 失われると致命的な情報（**試して失敗したアプローチ**、**ファイル状態**、
  **未解決ブロッカー**、**達成済みサブタスク**）は必ず保持。
- 推測や創作を含めない。ターン出力に書かれていない事実を作らない。
- 出力は <block-summary> タグで囲まれた構造化マークダウンのみ。前置き・末尾文不要。

## 出力フォーマット（必須）

<block-summary>
## このブロックで試したこと
- ...

## 主な発見・決定
- ...

## ファイル変更
- ...

## 失敗したアプローチ（再試行禁止）
- ...

## ブロック終了時点のステータス
- ...

## 未解決ブロッカー
- ...
</block-summary>
`;
async function buildBlockPrompt(args) {
  const dir = goalDir(args.goalId);
  const objective = await node_fs.promises.readFile(path.join(dir, "objective.md"), "utf8").catch(() => "");
  const rawParts = [];
  for (let i = args.fromTurn; i <= args.toTurn; i++) {
    const id = `turn-${String(i).padStart(3, "0")}`;
    const stdoutPath = path.join(dir, "turns", `${id}.stdout`);
    try {
      const stdout = await node_fs.promises.readFile(stdoutPath, "utf8");
      const trimmed = stdout.length > 8e3 ? stdout.slice(0, 4e3) + "\n...[省略]...\n" + stdout.slice(-3500) : stdout;
      rawParts.push(`### ${id}
\`\`\`
${trimmed}
\`\`\``);
    } catch {
      rawParts.push(`### ${id}
(読み込みエラー)`);
    }
  }
  const subs = {
    "{{OBJECTIVE}}": objective.trim(),
    "{{FROM}}": String(args.fromTurn),
    "{{TO}}": String(args.toTurn),
    "{{TURNS_RAW}}": rawParts.join("\n\n")
  };
  let out = BLOCK_PROMPT_TEMPLATE;
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  return out;
}
function extractBlockSummary(stdout) {
  const m = stdout.match(/<block-summary>([\s\S]*?)<\/block-summary>/);
  if (!m) return null;
  return m[1].replace(/^\n+/, "").replace(/\n+$/, "") + "\n";
}
const JUDGE_PROMPT_TEMPLATE = `# Judge Worker (independent)

あなたは独立した **判定 worker** です。実装ターンとは別の context で起動されており、
**前回までの作業は知りません**。下記の証拠だけを見て、ゴールが**本当に**達成されたかを判定します。

実装エージェントは「達成しました」と過大報告しがちです。**懐疑的に**判定してください。
証拠が不十分・部分実装・テスト未通過のいずれかであれば躊躇なく **not_yet** を返すこと。

## ゴール

{{OBJECTIVE}}

## 実装エージェントが提出した digest（自己報告）

{{DIGEST}}

## トリガとなったターンの最終出力（抜粋）

{{TRIGGER_TURN}}

## ワークスペース内の証拠を自分で確認してよい

cwd はワークスペースに固定されている。必要なら ls / cat / git log などで現状を確認すること。
ただし新たな実装は行わず、**判定のための読み取りのみ**に留めること。

## 出力フォーマット（必須）

判定理由を簡潔に述べた後、最後に必ず以下の verdict タグを出力すること。

<judge-reason>
（1〜3 文で根拠を述べる）
</judge-reason>

<judge-verdict>achieved</judge-verdict>

または

<judge-verdict>not_yet</judge-verdict>
`;
async function buildJudgePrompt(args) {
  const dir = goalDir(args.goalId);
  const objective = await node_fs.promises.readFile(path.join(dir, "objective.md"), "utf8").catch(() => "");
  const digest = await node_fs.promises.readFile(path.join(dir, "digest.md"), "utf8").catch(() => "");
  const triggerStdoutPath = path.join(dir, "turns", `${args.triggerTurnId}.stdout`);
  const triggerRaw = await node_fs.promises.readFile(triggerStdoutPath, "utf8").catch(() => "");
  const triggerExcerpt = triggerRaw.length > 6e3 ? "...[前略]...\n" + triggerRaw.slice(-6e3) : triggerRaw;
  const subs = {
    "{{OBJECTIVE}}": objective.trim(),
    "{{DIGEST}}": digest.trim(),
    "{{TRIGGER_TURN}}": triggerExcerpt
  };
  let out = JUDGE_PROMPT_TEMPLATE;
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  return out;
}
function extractJudgeVerdict(stdout) {
  const m = stdout.match(/<judge-verdict>\s*(achieved|not_yet)\s*<\/judge-verdict>/);
  if (!m) return null;
  return m[1];
}
function extractJudgeReason(stdout) {
  const m = stdout.match(/<judge-reason>([\s\S]*?)<\/judge-reason>/);
  return m ? m[1].trim() : "";
}
class TailWatcher {
  constructor(file, onChunk) {
    this.file = file;
    this.onChunk = onChunk;
  }
  watcher = null;
  offset = 0;
  polling = false;
  stopped = false;
  async start() {
    this.offset = 0;
    this.watcher = chokidar__namespace.watch(this.file, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      usePolling: false
    });
    this.watcher.on("add", () => void this.poll());
    this.watcher.on("change", () => void this.poll());
    await this.poll();
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      let stat;
      try {
        stat = await node_fs.promises.stat(this.file);
      } catch {
        return;
      }
      if (stat.size <= this.offset) return;
      const fd = await node_fs.promises.open(this.file, "r");
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, this.offset);
        this.offset = stat.size;
        this.onChunk(buf.toString("utf8"));
      } finally {
        await fd.close();
      }
    } finally {
      this.polling = false;
    }
  }
  async stop() {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
const HEARTBEAT_GRACE_MS = 3e4;
const BLOCK_SIZE = 10;
const MAX_CONSECUTIVE_ANOMALIES = 3;
const ANOMALY_RESULTS = /* @__PURE__ */ new Set([
  "TIMEOUT",
  "HANG",
  "ABORTED",
  "LAUNCH_FAIL"
]);
function isAnomaly(result) {
  if (ANOMALY_RESULTS.has(result)) return true;
  if (result.startsWith("FAIL")) return true;
  return false;
}
class GoalRunner extends node_events.EventEmitter {
  constructor(goalId) {
    super();
    this.goalId = goalId;
  }
  aborted = false;
  paused = false;
  running = false;
  currentTurnId = null;
  currentTail = null;
  recentLog = [];
  recentStdout = "";
  consecutiveAnomalies = 0;
  // C4: judge cooldown — skip judge for 3 turns after a not_yet verdict.
  lastJudgeAtTurn = -Infinity;
  lastJudgeVerdict = null;
  isRunning() {
    return this.running;
  }
  getCurrentTurnId() {
    return this.currentTurnId;
  }
  getRecentLog() {
    return [...this.recentLog];
  }
  getRecentStdout() {
    return this.recentStdout;
  }
  async getDigest() {
    return node_fs.promises.readFile(path.join(goalDir(this.goalId), "digest.md"), "utf8").catch(() => "");
  }
  abort() {
    this.aborted = true;
    void this.log("warn", "Abort requested");
  }
  pause() {
    this.paused = true;
    void this.log("warn", "Pause requested (will pause after current turn)");
  }
  resume() {
    if (this.paused) {
      this.paused = false;
      void this.log("info", "Resume requested");
    }
  }
  // -------- main loop --------
  async run() {
    if (this.running) return "completed";
    this.running = true;
    try {
      await this.transitionPendingToActive();
      while (!this.aborted) {
        if (this.paused) {
          await this.updateState({ status: "paused" });
          return "completed";
        }
        const state = await this.readState();
        const budget = await this.readBudget();
        if (!state || !budget) {
          await this.log("error", "state.json or budget.json missing — stopping");
          return "completed";
        }
        if (state.status === "achieved" || state.status === "abandoned" || state.status === "budget_exhausted" || state.status === "blocked" || state.status === "paused") {
          await this.log("info", `Status is '${state.status}' — stopping loop`);
          return "completed";
        }
        const checkerResult = await this.runHardChecker(state.workspace_path);
        if (checkerResult === "pass") {
          await this.log("info", "Hard checker PASSED — goal achieved");
          await this.updateState({ status: "achieved" });
          return "completed";
        }
        if (state.turns >= budget.max_turns) {
          await this.log("warn", `Budget exhausted: ${state.turns}/${budget.max_turns} turns`);
          await this.updateState({ status: "budget_exhausted" });
          return "completed";
        }
        if (typeof budget.max_wall_time_seconds === "number" && budget.max_wall_time_seconds > 0) {
          const createdMs = new Date(state.created_at).getTime();
          if (Number.isFinite(createdMs)) {
            const elapsedSec = Math.floor((Date.now() - createdMs) / 1e3);
            if (elapsedSec >= budget.max_wall_time_seconds) {
              await this.log(
                "warn",
                `Wall-time budget exhausted: ${elapsedSec}s elapsed >= ${budget.max_wall_time_seconds}s`
              );
              await this.updateState({ status: "budget_exhausted" });
              return "completed";
            }
          }
        }
        const turnNum = state.turns + 1;
        const turnId = formatTurnId(turnNum);
        await this.log("info", `Starting ${turnId} (${turnNum}/${budget.max_turns})`);
        await this.preTurnSnapshot(state.workspace_path, turnId);
        const promptText = await buildPrompt({ state, budget, turnId, turnNum });
        const { result, stdout } = await this.runWorker("turns", turnId, promptText, budget, {
          tail: true
        });
        if (isAnomaly(result)) {
          this.consecutiveAnomalies++;
          await this.appendAnomalyToDigest(turnId, result);
          await this.log(
            "warn",
            `Anomaly: ${turnId} returned ${result} (${this.consecutiveAnomalies}/${MAX_CONSECUTIVE_ANOMALIES} consecutive)`
          );
        } else {
          if (this.consecutiveAnomalies > 0) {
            await this.log(
              "info",
              `Anomaly streak broken (was ${this.consecutiveAnomalies}); resetting counter`
            );
          }
          this.consecutiveAnomalies = 0;
          const digestUpdate = extractDigestUpdate(stdout);
          if (digestUpdate) {
            await node_fs.promises.writeFile(
              path.join(goalDir(this.goalId), "digest.md"),
              digestUpdate,
              "utf8"
            );
            this.emit("event", {
              type: "digest",
              goalId: this.goalId,
              digest: digestUpdate
            });
          } else {
            await this.log("warn", "No <digest-update> block found in stdout");
          }
        }
        await node_fs.promises.writeFile(
          path.join(goalDir(this.goalId), "history", "raw", `${turnId}.json`),
          JSON.stringify(
            { turn_id: turnId, result, started_at: isoNow(), ended_at: isoNow() },
            null,
            2
          ) + "\n",
          "utf8"
        );
        await this.updateState({
          turns: turnNum,
          last_turn_id: turnId,
          last_result: result
        });
        if (this.consecutiveAnomalies >= MAX_CONSECUTIVE_ANOMALIES) {
          await this.log(
            "error",
            `${this.consecutiveAnomalies} consecutive anomalies — marking blocked`
          );
          await this.updateState({ status: "blocked" });
          return "completed";
        }
        if (hasGoalAchievedToken(stdout)) {
          await this.log("info", "Worker emitted <goal-status>achieved</goal-status>");
          const confirm = await this.runHardChecker(state.workspace_path);
          if (confirm === "pass") {
            await this.log("info", "Hard checker confirms achievement");
            await this.updateState({ status: "achieved" });
            return "completed";
          }
          if (confirm === "no_checker") {
            const turnsSinceJudge = turnNum - this.lastJudgeAtTurn;
            if (this.lastJudgeVerdict === "not_yet" && turnsSinceJudge < 3) {
              await this.log(
                "info",
                `Judge cooldown active (last not_yet at turn ${this.lastJudgeAtTurn}, ${turnsSinceJudge} turns ago) — skipping judge`
              );
            } else {
              const verdict = await this.runJudgeWorker(turnId, budget);
              this.lastJudgeAtTurn = turnNum;
              this.lastJudgeVerdict = verdict === "achieved" || verdict === "not_yet" ? verdict : null;
              if (verdict === "achieved") {
                await this.log("info", "Judge confirms achievement — marking achieved");
                await this.updateState({ status: "achieved" });
                return "completed";
              }
              if (verdict === "not_yet") {
                await this.log("warn", "Judge says not_yet — continuing");
              } else {
                await this.log("warn", "Judge produced no verdict — continuing");
              }
            }
          } else {
            await this.log(
              "warn",
              "Worker claims achieved but hard checker failed — continuing"
            );
          }
        }
        if (turnNum > 0 && turnNum % BLOCK_SIZE === 0) {
          const blockNum = Math.floor(turnNum / BLOCK_SIZE);
          const fromTurn = turnNum - BLOCK_SIZE + 1;
          await this.runBlockSummarizer(blockNum, fromTurn, turnNum, budget);
        }
        await sleep((budget.rate_limit_sleep_seconds ?? 5) * 1e3);
      }
      await this.log("warn", "Loop aborted");
      await this.updateState({ status: "abandoned" });
      return "aborted";
    } finally {
      this.running = false;
      this.currentTurnId = null;
      if (this.currentTail) {
        await this.currentTail.stop();
        this.currentTail = null;
      }
    }
  }
  // -------- block summarizer --------
  async runBlockSummarizer(blockNum, fromTurn, toTurn, budget) {
    const blockId = `block-${String(blockNum).padStart(3, "0")}`;
    await this.log(
      "info",
      `Starting ${blockId} (compresses turn-${String(fromTurn).padStart(3, "0")} ~ turn-${String(toTurn).padStart(3, "0")})`
    );
    const prompt = await buildBlockPrompt({
      goalId: this.goalId,
      fromTurn,
      toTurn
    });
    const { result, stdout } = await this.runWorker("blocks", blockId, prompt, budget, {
      tail: true
    });
    if (result !== "DONE") {
      await this.log("warn", `Block summarizer ${blockId} returned ${result} — skipping`);
      return;
    }
    const summary = extractBlockSummary(stdout);
    if (!summary) {
      await this.log("warn", `${blockId}: no <block-summary> tag found — skipping save`);
      return;
    }
    const blocksDir = path.join(goalDir(this.goalId), "history", "blocks");
    await node_fs.promises.mkdir(blocksDir, { recursive: true });
    await node_fs.promises.writeFile(path.join(blocksDir, `${blockId}.md`), summary, "utf8");
    await this.log("info", `${blockId} saved`);
  }
  // -------- judge worker --------
  async runJudgeWorker(triggerTurnId, budget) {
    const judgeId = `judge-${triggerTurnId.replace(/^turn-/, "")}`;
    await this.log("info", `Starting ${judgeId} for ${triggerTurnId}`);
    const prompt = await buildJudgePrompt({ goalId: this.goalId, triggerTurnId });
    const { result, stdout } = await this.runWorker("judge", judgeId, prompt, budget, {
      tail: true
    });
    if (result !== "DONE") {
      await this.log("warn", `${judgeId} returned ${result}`);
      return "error";
    }
    const verdict = extractJudgeVerdict(stdout);
    const reason = extractJudgeReason(stdout);
    if (verdict) {
      await this.log("info", `${judgeId} verdict: ${verdict}${reason ? ` — ${reason}` : ""}`);
      return verdict;
    }
    await this.log("warn", `${judgeId}: no verdict tag found`);
    return "error";
  }
  // -------- generic worker turn (used by main / block / judge) --------
  async runWorker(subdir, workId, prompt, budget, options) {
    const tp = turnPaths(this.goalId, workId, subdir);
    await node_fs.promises.mkdir(path.dirname(tp.prompt), { recursive: true });
    await node_fs.promises.writeFile(tp.prompt, prompt, "utf8");
    this.currentTurnId = workId;
    this.recentStdout = "";
    this.emit("event", {
      type: "turn:started",
      goalId: this.goalId,
      turnId: workId,
      ts: isoNow()
    });
    let tail = null;
    if (options.tail) {
      tail = new TailWatcher(tp.stdout, (chunk) => {
        this.recentStdout += chunk;
        if (this.recentStdout.length > 2e5) {
          this.recentStdout = this.recentStdout.slice(-2e5);
        }
        this.emit("event", {
          type: "turn:stdout",
          goalId: this.goalId,
          turnId: workId,
          chunk
        });
      });
      await tail.start();
      this.currentTail = tail;
    }
    try {
      await this.launchTurnWindow(workId, subdir);
    } catch (err) {
      await this.log("error", `Failed to launch Terminal: ${String(err)}`);
      if (tail) {
        await tail.stop();
        this.currentTail = null;
      }
      this.currentTurnId = null;
      this.emit("event", {
        type: "turn:finished",
        goalId: this.goalId,
        turnId: workId,
        result: "LAUNCH_FAIL",
        ts: isoNow()
      });
      return { result: "LAUNCH_FAIL", stdout: "" };
    }
    const result = await this.waitForTurn(workId, subdir, budget);
    if (tail) {
      await tail.stop();
      this.currentTail = null;
      await this.flushTailOnce(tp.stdout, workId);
    }
    const stdout = await node_fs.promises.readFile(tp.stdout, "utf8").catch(() => "");
    this.emit("event", {
      type: "turn:finished",
      goalId: this.goalId,
      turnId: workId,
      result,
      ts: isoNow()
    });
    this.currentTurnId = null;
    return { result, stdout };
  }
  // -------- helpers --------
  async transitionPendingToActive() {
    const state = await this.readState();
    if (state?.status === "pending") {
      await this.updateState({ status: "active" });
      await this.log("info", "Status: pending → active");
    }
  }
  async readState() {
    try {
      const data = await node_fs.promises.readFile(path.join(goalDir(this.goalId), "state.json"), "utf8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  async readBudget() {
    try {
      const data = await node_fs.promises.readFile(path.join(goalDir(this.goalId), "budget.json"), "utf8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  async updateState(patch) {
    const cur = await this.readState();
    if (!cur) return;
    const next = { ...cur, ...patch, updated_at: isoNow() };
    await node_fs.promises.writeFile(
      path.join(goalDir(this.goalId), "state.json"),
      JSON.stringify(next, null, 2) + "\n",
      "utf8"
    );
    this.emit("event", { type: "state", goalId: this.goalId, state: next });
  }
  async runHardChecker(workspacePath) {
    const checker = path.join(goalDir(this.goalId), "checker.sh");
    if (!node_fs.existsSync(checker)) return "no_checker";
    const checkerLog = path.join(goalDir(this.goalId), "logs", "checker.log");
    const startedAt = isoNow();
    return new Promise((resolve) => {
      const child = node_child_process.spawn("bash", [checker], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += String(d);
      });
      child.stderr?.on("data", (d) => {
        stderr += String(d);
      });
      const finalize = async (outcome, code, errMsg) => {
        const finishedAt = isoNow();
        const sep = "----------------------------------------\n";
        const block = sep + `[${startedAt} -> ${finishedAt}] checker rc=${code ?? "null"} outcome=${outcome}${errMsg ? ` error=${errMsg}` : ""}
` + (stdout ? `--- stdout ---
${stdout}${stdout.endsWith("\n") ? "" : "\n"}` : "") + (stderr ? `--- stderr ---
${stderr}${stderr.endsWith("\n") ? "" : "\n"}` : "");
        try {
          await node_fs.promises.appendFile(checkerLog, block, "utf8");
        } catch {
        }
        if (outcome === "fail") {
          const summarize = (s) => {
            const trimmed = s.trim();
            if (!trimmed) return "";
            const tailLines = trimmed.split("\n").slice(-3).join(" | ");
            return tailLines.length > 240 ? tailLines.slice(-240) : tailLines;
          };
          const tail = summarize(stderr) || summarize(stdout);
          await this.log(
            "warn",
            `Hard checker failed (rc=${code ?? "null"})${tail ? `: ${tail}` : ""}`
          );
        }
        resolve(outcome);
      };
      child.on("exit", (code) => {
        void finalize(code === 0 ? "pass" : "fail", code);
      });
      child.on("error", (err) => {
        void finalize("fail", null, String(err));
      });
    });
  }
  async preTurnSnapshot(workspacePath, turnId) {
    if (!node_fs.existsSync(path.join(workspacePath, ".git"))) return;
    const tag = `claude-goal/${this.goalId}/${turnId}`;
    await new Promise((resolve) => {
      const child = node_child_process.spawn("git", ["tag", "-f", tag], {
        cwd: workspacePath,
        stdio: "ignore"
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
    await this.log("info", `Pre-turn git tag: ${tag}`);
  }
  async launchTurnWindow(workId, subdir) {
    const runTurnPath = resourcePath("run-turn.sh");
    if (!node_fs.existsSync(runTurnPath)) {
      throw new Error(`run-turn.sh not found at ${runTurnPath}`);
    }
    const cmd = `exec bash "${escapeForOsa(runTurnPath)}" "${escapeForOsa(this.goalId)}" "${escapeForOsa(workId)}" "${escapeForOsa(subdir)}"`;
    const titleSuffix = subdir === "blocks" ? "[block]" : subdir === "judge" ? "[judge]" : "";
    const script = `tell application "Terminal"
  activate
  do script "${escapeForOsa(cmd)}"
  set custom title of front window to "${escapeForOsa(this.goalId)} :: ${escapeForOsa(workId)} ${titleSuffix}"
end tell`;
    await new Promise((resolve, reject) => {
      const child = node_child_process.spawn("/usr/bin/osascript", ["-e", script]);
      let err = "";
      child.stderr.on("data", (d) => err += String(d));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(err || `osascript exited with ${code}`));
      });
      child.on("error", reject);
    });
  }
  async waitForTurn(workId, subdir, budget) {
    const tp = turnPaths(this.goalId, workId, subdir);
    const startedAt = Date.now();
    const timeoutMs = budget.per_turn_timeout_seconds * 1e3;
    const heartbeatMs = budget.heartbeat_threshold_seconds * 1e3;
    const graceUntil = startedAt + HEARTBEAT_GRACE_MS;
    while (true) {
      if (this.aborted) {
        await this.markTurnDeadAndKill(workId, subdir, "ABORTED");
        return "ABORTED";
      }
      if (node_fs.existsSync(tp.result)) {
        return (await node_fs.promises.readFile(tp.result, "utf8")).trim();
      }
      const now = Date.now();
      if (now - startedAt > timeoutMs) {
        await this.log(
          "warn",
          `${workId} TIMEOUT after ${Math.floor((now - startedAt) / 1e3)}s`
        );
        await this.markTurnDeadAndKill(workId, subdir, "TIMEOUT");
        return "TIMEOUT";
      }
      if (node_fs.existsSync(tp.heartbeat)) {
        const stat = await node_fs.promises.stat(tp.heartbeat);
        if (now - stat.mtimeMs > heartbeatMs) {
          await this.log(
            "warn",
            `${workId} HANG (heartbeat lost ${Math.floor((now - stat.mtimeMs) / 1e3)}s)`
          );
          await this.markTurnDeadAndKill(workId, subdir, "HANG");
          return "HANG";
        }
      } else if (now > graceUntil) {
        await this.log("warn", `${workId} HANG (no heartbeat appeared)`);
        await this.markTurnDeadAndKill(workId, subdir, "HANG");
        return "HANG";
      }
      await sleep(1e3);
    }
  }
  /**
   * Write the sentinel result and try to kill the run-turn.sh process group
   * so claude stops burning tokens. The result file write is the primary
   * kill signal: run-turn.sh's kill watcher polls it and pkills children.
   * The PID-file SIGTERM here is a backup in case the watcher misses.
   */
  async markTurnDeadAndKill(workId, subdir, reason) {
    const tp = turnPaths(this.goalId, workId, subdir);
    try {
      await node_fs.promises.writeFile(tp.result, `${reason}
`, "utf8");
    } catch {
    }
    const pidFile = path.join(goalDir(this.goalId), subdir, `${workId}.pid`);
    try {
      const raw = await node_fs.promises.readFile(pidFile, "utf8");
      const pid = parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 1) {
        let sentSignal = false;
        try {
          process.kill(-pid, "SIGTERM");
          sentSignal = true;
        } catch {
          try {
            process.kill(pid, "SIGTERM");
            sentSignal = true;
          } catch {
          }
        }
        if (sentSignal) {
          await this.log("info", `Sent SIGTERM to pid=${pid} for ${workId}`);
          setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
              }
            }
          }, 5e3);
        }
      }
    } catch {
    }
  }
  async appendAnomalyToDigest(turnId, result) {
    const digestPath = path.join(goalDir(this.goalId), "digest.md");
    const cur = await node_fs.promises.readFile(digestPath, "utf8").catch(() => "");
    const ANOMALY_HEADING = "## 🚨 直前ターンの異常終了";
    const note = [
      "",
      ANOMALY_HEADING,
      `- ${turnId}: ${result} (連続 ${this.consecutiveAnomalies} 回目)`,
      "  → このアプローチは時間内に完了しなかった。**同じ手順を繰り返さない**こと。",
      "  → 原因仮説: ツール呼び出しが多すぎる / dev-browser 待機が長い / ブラウザが応答しない 等。",
      "  → 次ターンでは作業を **より小さなステップに分割**し、ファイル状態のみ確認して digest を更新するなど **軽い作業**から始めること。",
      ""
    ].join("\n");
    let next;
    if (cur.includes(ANOMALY_HEADING)) {
      next = cur.replace(/\n*## 🚨 直前ターンの異常終了[\s\S]*?(?=\n## |$)/, note);
    } else {
      next = cur.trimEnd() + "\n" + note;
    }
    await node_fs.promises.writeFile(digestPath, next, "utf8");
    this.emit("event", {
      type: "digest",
      goalId: this.goalId,
      digest: next
    });
  }
  async flushTailOnce(stdoutPath, workId) {
    try {
      const content = await node_fs.promises.readFile(stdoutPath, "utf8");
      if (content.length > this.recentStdout.length) {
        const newPart = content.slice(this.recentStdout.length);
        this.recentStdout = content.slice(-2e5);
        this.emit("event", {
          type: "turn:stdout",
          goalId: this.goalId,
          turnId: workId,
          chunk: newPart
        });
      }
    } catch {
    }
  }
  async log(level, message) {
    const line = `[${isoNow()}] ${level.toUpperCase()} ${message}`;
    this.recentLog.push(line);
    if (this.recentLog.length > 500) this.recentLog = this.recentLog.slice(-500);
    try {
      await node_fs.promises.appendFile(
        path.join(goalDir(this.goalId), "logs", "orchestrator.log"),
        line + "\n",
        "utf8"
      );
    } catch {
    }
    this.emit("event", {
      type: "log",
      goalId: this.goalId,
      level,
      message,
      ts: isoNow()
    });
  }
}
const runners = /* @__PURE__ */ new Map();
const listeners = /* @__PURE__ */ new Set();
function broadcast(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
    }
  }
}
function addEventListener(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function startRunner(goalId) {
  let runner = runners.get(goalId);
  if (runner && runner.isRunning()) return runner;
  runner = new GoalRunner(goalId);
  runners.set(goalId, runner);
  runner.on("event", (event) => broadcast(event));
  void runner.run().catch((err) => {
    broadcast({
      type: "log",
      goalId,
      level: "error",
      message: `Runner crashed: ${String(err)}`,
      ts: (/* @__PURE__ */ new Date()).toISOString()
    });
  }).finally(() => {
  });
  return runner;
}
function abortRunner(goalId) {
  const runner = runners.get(goalId);
  if (!runner) return false;
  runner.abort();
  return true;
}
function pauseRunner(goalId) {
  const runner = runners.get(goalId);
  if (!runner) return false;
  runner.pause();
  return true;
}
function resumeRunner(goalId) {
  const runner = runners.get(goalId);
  if (!runner) {
    return startRunner(goalId);
  }
  if (runner.isRunning()) {
    runner.resume();
    return runner;
  }
  return startRunner(goalId);
}
async function getSnapshot(goalId) {
  const runner = runners.get(goalId);
  if (!runner) return null;
  return {
    goalId,
    running: runner.isRunning(),
    currentTurnId: runner.getCurrentTurnId(),
    recentLog: runner.getRecentLog(),
    recentStdout: runner.getRecentStdout(),
    digest: await runner.getDigest()
  };
}
function registerIpcHandlers(getMainWindow) {
  electron.ipcMain.handle(IPC.Workspace.Select, async () => {
    const win = getMainWindow();
    const options = {
      title: "ワークスペースを選択",
      properties: ["openDirectory", "createDirectory"],
      message: "Claude Goal の作業ディレクトリにするフォルダを選択"
    };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = path.resolve(result.filePaths[0]);
    await addRecent(chosen);
    return chosen;
  });
  electron.ipcMain.handle(IPC.Workspace.RecentList, async () => {
    return listRecent();
  });
  electron.ipcMain.handle(IPC.Workspace.RecentAdd, async (_evt, workspacePath) => {
    return addRecent(path.resolve(workspacePath));
  });
  electron.ipcMain.handle(IPC.Workspace.RecentRemove, async (_evt, workspacePath) => {
    return removeRecent(workspacePath);
  });
  electron.ipcMain.handle(IPC.Goal.List, async (_evt, workspacePath) => {
    return listGoals(workspacePath ?? void 0);
  });
  electron.ipcMain.handle(IPC.Goal.Get, async (_evt, goalId) => {
    return getGoal(goalId);
  });
  electron.ipcMain.handle(IPC.Goal.Create, async (_evt, params) => {
    return createGoal(params);
  });
  electron.ipcMain.handle(IPC.Goal.Delete, async (_evt, goalId) => {
    abortRunner(goalId);
    await deleteGoal(goalId);
    return true;
  });
  electron.ipcMain.handle(IPC.Goal.Turns, async (_evt, goalId) => {
    return listTurns(goalId);
  });
  electron.ipcMain.handle(
    IPC.Goal.TurnStdout,
    async (_evt, goalId, workId, kind) => {
      return readTurnStdout(goalId, workId, kind);
    }
  );
  electron.ipcMain.handle(IPC.Runner.Start, async (_evt, goalId) => {
    startRunner(goalId);
    return true;
  });
  electron.ipcMain.handle(IPC.Runner.Abort, async (_evt, goalId) => {
    return abortRunner(goalId);
  });
  electron.ipcMain.handle(IPC.Runner.Pause, async (_evt, goalId) => {
    return pauseRunner(goalId);
  });
  electron.ipcMain.handle(IPC.Runner.Resume, async (_evt, goalId) => {
    return Boolean(resumeRunner(goalId));
  });
  electron.ipcMain.handle(IPC.Runner.Snapshot, async (_evt, goalId) => {
    return getSnapshot(goalId);
  });
  addEventListener((event) => {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.Events.GoalEvent, event);
      }
    }
    if (event.type === "state" && electron.Notification.isSupported()) {
      const status = event.state.status;
      const titles = {
        achieved: "✅ ゴール達成",
        blocked: "⚠️ ブロック",
        budget_exhausted: "⏰ Budget 上限到達",
        abandoned: "⏹ 中止"
      };
      if (titles[status]) {
        new electron.Notification({
          title: titles[status],
          body: `${event.goalId}
${status}`,
          silent: false
        }).show();
      }
    }
  });
}
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0e1116",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
electron.app.whenReady().then(async () => {
  utils.electronApp.setAppUserModelId("com.marumiworks.claude-goal");
  electron.app.on("browser-window-created", (_, window) => {
    utils.optimizer.watchWindowShortcuts(window);
  });
  try {
    const orphaned = await markOrphanedActiveAsPaused();
    if (orphaned.length > 0) {
      console.log(`[orphan] marked ${orphaned.length} active goals as paused:`, orphaned);
    }
  } catch (err) {
    console.error("[orphan] failed to scan goals:", err);
  }
  registerIpcHandlers(() => mainWindow);
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
