// IPC handlers — main process side.

import { app, dialog, ipcMain, BrowserWindow, Notification } from 'electron'
import path from 'node:path'

import { IPC } from '@shared/types'
import type {
  CreateGoalParams,
  GlobalSettings,
  GoalBudget,
  WorkKind
} from '@shared/types'

import * as goalStore from './goalStore'
import * as planSession from './planSession'
import * as recent from './recentWorkspaces'
import * as runtime from './orchestrator/runtime'
import * as settings from './settings'

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // ---- Workspace ----

  ipcMain.handle(IPC.Workspace.Select, async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'ワークスペースを選択',
      properties: ['openDirectory', 'createDirectory'],
      message: 'Codex Goal の作業ディレクトリにするフォルダを選択'
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = path.resolve(result.filePaths[0])
    await recent.addRecent(chosen)
    return chosen
  })

  ipcMain.handle(IPC.Workspace.RecentList, async () => {
    return recent.listRecent()
  })

  ipcMain.handle(IPC.Workspace.RecentAdd, async (_evt, workspacePath: string) => {
    return recent.addRecent(path.resolve(workspacePath))
  })

  ipcMain.handle(IPC.Workspace.RecentRemove, async (_evt, workspacePath: string) => {
    return recent.removeRecent(workspacePath)
  })

  // ---- Goal ----

  ipcMain.handle(IPC.Goal.List, async (_evt, workspacePath: string | null) => {
    return goalStore.listGoals(workspacePath ?? undefined)
  })

  ipcMain.handle(IPC.Goal.Get, async (_evt, goalId: string) => {
    return goalStore.getGoal(goalId)
  })

  ipcMain.handle(IPC.Goal.Create, async (_evt, params: CreateGoalParams) => {
    return goalStore.createGoal(params)
  })

  ipcMain.handle(IPC.Goal.Delete, async (_evt, goalId: string) => {
    runtime.abortRunner(goalId)
    await goalStore.deleteGoal(goalId)
    return true
  })

  ipcMain.handle(IPC.Goal.Turns, async (_evt, goalId: string) => {
    return goalStore.listTurns(goalId)
  })

  ipcMain.handle(
    IPC.Goal.TurnStdout,
    async (_evt, goalId: string, workId: string, kind: WorkKind) => {
      return goalStore.readTurnStdout(goalId, workId, kind)
    }
  )

  ipcMain.handle(IPC.Goal.BlocksList, async (_evt, goalId: string) => {
    return goalStore.listBlocks(goalId)
  })

  ipcMain.handle(IPC.Goal.BlocksRead, async (_evt, goalId: string, blockId: string) => {
    return goalStore.readBlock(goalId, blockId)
  })

  ipcMain.handle(
    IPC.Goal.UpdateObjective,
    async (_evt, goalId: string, objective: string) => {
      return goalStore.updateObjective(goalId, objective)
    }
  )

  ipcMain.handle(
    IPC.Goal.UpdateBudget,
    async (_evt, goalId: string, budget: GoalBudget) => {
      return goalStore.updateBudget(goalId, budget)
    }
  )

  // ---- Phase 4.3: user-message queue ----

  ipcMain.handle(IPC.Goal.UserMessageList, async (_evt, goalId: string) => {
    return goalStore.listUserMessages(goalId)
  })

  ipcMain.handle(IPC.Goal.UserMessageAdd, async (_evt, goalId: string, text: string) => {
    const msg = await goalStore.addUserMessage(goalId, text)
    // Broadcast immediately so other open windows refresh their list.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.Events.GoalEvent, {
          type: 'user-message',
          goalId,
          message: msg
        })
      }
    }
    return msg
  })

  ipcMain.handle(
    IPC.Goal.UserMessageInterrupt,
    async (_evt, goalId: string, text: string) => {
      const msg = await goalStore.addUserMessage(goalId, text)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.Events.GoalEvent, {
            type: 'user-message',
            goalId,
            message: msg
          })
        }
      }
      // If the goal is currently running, ask it to interrupt and wait for it
      // to fully return before spawning a fresh runner. If we don't wait we'd
      // race two runners against the same state files.
      const wasRunning = runtime.isRunning(goalId)
      if (wasRunning) {
        runtime.interruptRunner(goalId)
        await runtime.waitForRunnerStop(goalId, 15000)
      }
      runtime.startRunner(goalId)
      return msg
    }
  )

  // ---- Settings ----

  ipcMain.handle(IPC.Settings.Get, async () => {
    return settings.getSettings()
  })

  ipcMain.handle(IPC.Settings.Update, async (_evt, next: GlobalSettings) => {
    return settings.updateSettings(next)
  })

  // ---- Plan mode ----
  // Interactive planning session lifecycle. The renderer's PlanReview page
  // drives this surface; events flow back via IPC.Events.PlanEvent (broadcast
  // listener registered below).

  ipcMain.handle(IPC.Plan.Status, async (_evt, goalId: string) => {
    return planSession.getStatus(goalId)
  })

  ipcMain.handle(IPC.Plan.Start, async (_evt, goalId: string) => {
    const summary = await goalStore.getGoal(goalId)
    if (!summary) {
      throw new Error(`Cannot start plan session: goal ${goalId} not found`)
    }
    if (summary.state.status !== 'planning') {
      throw new Error(
        `Cannot start plan session for goal ${goalId}: status is '${summary.state.status}', expected 'planning'`
      )
    }
    // Note: GoalSummary.objective_preview is misleadingly named — getGoal()
    // returns the FULL objective.md content there (only listGoals truncates).
    // Plan-mode needs the complete goal text as the seed message, so this is
    // correct as-is. If getGoal's contract ever changes, swap to a direct
    // fs.readFile of <goalDir>/objective.md.
    return planSession.start(goalId, summary.objective_preview)
  })

  ipcMain.handle(IPC.Plan.SendMessage, async (_evt, goalId: string, text: string) => {
    await planSession.sendMessage(goalId, text)
    return true
  })

  ipcMain.handle(IPC.Plan.Approve, async (_evt, goalId: string, plan?: string) => {
    return planSession.approve(goalId, plan)
  })

  ipcMain.handle(IPC.Plan.Abort, async (_evt, goalId: string) => {
    return planSession.abort(goalId)
  })

  // Forward plan events to all renderer windows. PlanReview subscribes via
  // window.api.plan.onPlanEvent (preload). Errors in one listener must not
  // block delivery to the others, so each send is wrapped.
  // The dispose handle is registered on app quit so a hot-reloaded main
  // process doesn't accumulate duplicate broadcast listeners (each one
  // would emit the same event N times to every window).
  const disposePlanListener = planSession.onPlanEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(IPC.Events.PlanEvent, event)
      } catch {
        // window may have closed mid-send — skip
      }
    }
  })
  app.once('before-quit', disposePlanListener)
  // Kill any live plan-session processes so they don't outlive the
  // parent on macOS (planSession spawns with detached: true → own process
  // group, which survives parent quit unless explicitly group-killed).
  app.once('before-quit', () => planSession.abortAll())

  // ---- Runner ----

  ipcMain.handle(IPC.Runner.Start, async (_evt, goalId: string) => {
    // Plan-mode 2-layer defense (layer 1): refuse to start the auto-runner for a
    // goal that's still in interactive planning. The renderer should route the
    // user to /plan/:goalId instead. Layer 2 lives in runner.ts (status check
    // before transitioning pending → active).
    const summary = await goalStore.getGoal(goalId)
    if (summary && summary.state.status === 'planning') {
      throw new Error(
        `Cannot start runner for goal ${goalId}: still in 'planning' status. Approve or abort the plan session first.`
      )
    }
    runtime.startRunner(goalId)
    return true
  })

  ipcMain.handle(IPC.Runner.Abort, async (_evt, goalId: string) => {
    return runtime.abortRunner(goalId)
  })

  ipcMain.handle(IPC.Runner.Pause, async (_evt, goalId: string) => {
    return runtime.pauseRunner(goalId)
  })

  ipcMain.handle(IPC.Runner.Resume, async (_evt, goalId: string) => {
    return Boolean(runtime.resumeRunner(goalId))
  })

  ipcMain.handle(IPC.Runner.Snapshot, async (_evt, goalId: string) => {
    return runtime.getSnapshot(goalId)
  })

  // Forward runner events to all renderer windows + fire macOS notifications.
  runtime.addEventListener((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.Events.GoalEvent, event)
      }
    }
    if (event.type === 'state' && Notification.isSupported()) {
      const status = event.state.status
      const titles: Record<string, string> = {
        achieved: '✅ ゴール達成',
        blocked: '⚠️ ブロック',
        budget_exhausted: '⏰ Budget 上限到達',
        abandoned: '⏹ 中止'
      }
      if (titles[status]) {
        new Notification({
          title: titles[status],
          body: `${event.goalId}\n${status}`,
          silent: false
        }).show()
      }
    }
  })
}
