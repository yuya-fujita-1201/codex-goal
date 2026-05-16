/**
 * Scan a plan body for absolute paths that point OUTSIDE the goal's workspace.
 *
 * Worker turns are launched with cwd=workspace, but the plan body can still
 * embed absolute paths like `/Users/x/projects/other-repo/docs/`. With
 * `--dangerously-skip-permissions` the worker happily writes anywhere it's
 * told, so outputs end up in the wrong directory. This helper powers the
 * PlanReview warning banner / approve-time confirm dialog so the user can
 * catch the mismatch before it reaches the runner.
 *
 * Heuristics:
 *  - Match `/Users/...`, `/home/...`, `/tmp/...`, `/var/...`, `/opt/...`,
 *    `/private/...`, `~/...`, `C:\\...` (Windows). Anything else (`./foo`,
 *    bare names, code-style identifiers like `Foo/Bar`) is ignored.
 *  - A match is "external" if it does NOT start with the workspace prefix
 *    (after trailing-slash normalization).
 *  - Trailing punctuation `.,;:` is stripped (markdown sentence enders).
 *  - Results are de-duped and capped at 10 entries so the warning stays
 *    scannable.
 */
export function findExternalAbsolutePaths(plan: string, workspacePath: string): string[] {
  if (!plan || !workspacePath) return []
  const ws = workspacePath.replace(/\/+$/, '')
  // Stop class includes ASCII whitespace/quotes/brackets *and* common CJK
  // punctuation (。、，「」『』（）【】〔〕《》〈〉) so paths embedded in
  // Japanese prose like "保存先は /tmp/foo.md。" stop at the period, not after
  // it.
  const re = /(?:^|[\s`'"(\[<])((?:~|\/(?:Users|home|tmp|var|opt|private)|[A-Z]:\\)[^\s`'"<>)\]。、，「」『』（）【】〔〕《》〈〉]+)/g
  const found = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(plan)) !== null) {
    let p = m[1]
    p = p.replace(/[.,;:]+$/, '')
    if (p.length < 4) continue
    if (p.startsWith(ws + '/') || p === ws) continue
    found.add(p)
    if (found.size >= 10) break
  }
  return Array.from(found)
}
