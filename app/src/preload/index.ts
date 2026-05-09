import { contextBridge, ipcRenderer } from 'electron'

import { IPC } from '@shared/types'
import type {
  BlockSummaryEntry,
  CreateGoalParams,
  GlobalSettings,
  GoalBudget,
  GoalEvent,
  GoalSummary,
  PlanEvent,
  PlanSessionStatus,
  RecentWorkspace,
  RunnerSnapshot,
  TurnHistoryEntry,
  UserMessage,
  WorkKind
} from '@shared/types'

// API exposed to the renderer through contextBridge.
const api = {
  workspace: {
    select: (): Promise<string | null> => ipcRenderer.invoke(IPC.Workspace.Select),
    recentList: (): Promise<RecentWorkspace[]> => ipcRenderer.invoke(IPC.Workspace.RecentList),
    recentAdd: (p: string): Promise<RecentWorkspace[]> =>
      ipcRenderer.invoke(IPC.Workspace.RecentAdd, p),
    recentRemove: (p: string): Promise<RecentWorkspace[]> =>
      ipcRenderer.invoke(IPC.Workspace.RecentRemove, p)
  },
  goal: {
    list: (workspacePath: string | null): Promise<GoalSummary[]> =>
      ipcRenderer.invoke(IPC.Goal.List, workspacePath),
    get: (goalId: string): Promise<GoalSummary | null> =>
      ipcRenderer.invoke(IPC.Goal.Get, goalId),
    create: (params: CreateGoalParams): Promise<GoalSummary> =>
      ipcRenderer.invoke(IPC.Goal.Create, params),
    delete: (goalId: string): Promise<boolean> => ipcRenderer.invoke(IPC.Goal.Delete, goalId),
    turns: (goalId: string): Promise<TurnHistoryEntry[]> =>
      ipcRenderer.invoke(IPC.Goal.Turns, goalId),
    turnStdout: (goalId: string, workId: string, kind: WorkKind): Promise<string> =>
      ipcRenderer.invoke(IPC.Goal.TurnStdout, goalId, workId, kind),
    blocksList: (goalId: string): Promise<BlockSummaryEntry[]> =>
      ipcRenderer.invoke(IPC.Goal.BlocksList, goalId),
    blocksRead: (goalId: string, blockId: string): Promise<string> =>
      ipcRenderer.invoke(IPC.Goal.BlocksRead, goalId, blockId),
    updateObjective: (goalId: string, objective: string): Promise<GoalSummary | null> =>
      ipcRenderer.invoke(IPC.Goal.UpdateObjective, goalId, objective),
    updateBudget: (goalId: string, budget: GoalBudget): Promise<GoalSummary | null> =>
      ipcRenderer.invoke(IPC.Goal.UpdateBudget, goalId, budget),
    markAchieved: (goalId: string): Promise<GoalSummary | null> =>
      ipcRenderer.invoke(IPC.Goal.MarkAchieved, goalId),
    // Phase 4.3: queue / list mid-flight directives, or interrupt-and-restart.
    userMessageList: (goalId: string): Promise<UserMessage[]> =>
      ipcRenderer.invoke(IPC.Goal.UserMessageList, goalId),
    userMessageAdd: (goalId: string, text: string): Promise<UserMessage> =>
      ipcRenderer.invoke(IPC.Goal.UserMessageAdd, goalId, text),
    userMessageInterrupt: (goalId: string, text: string): Promise<UserMessage> =>
      ipcRenderer.invoke(IPC.Goal.UserMessageInterrupt, goalId, text)
  },
  settings: {
    get: (): Promise<GlobalSettings> => ipcRenderer.invoke(IPC.Settings.Get),
    update: (next: GlobalSettings): Promise<GlobalSettings> =>
      ipcRenderer.invoke(IPC.Settings.Update, next)
  },
  runner: {
    start: (goalId: string): Promise<boolean> => ipcRenderer.invoke(IPC.Runner.Start, goalId),
    abort: (goalId: string): Promise<boolean> => ipcRenderer.invoke(IPC.Runner.Abort, goalId),
    pause: (goalId: string): Promise<boolean> => ipcRenderer.invoke(IPC.Runner.Pause, goalId),
    resume: (goalId: string): Promise<boolean> => ipcRenderer.invoke(IPC.Runner.Resume, goalId),
    snapshot: (goalId: string): Promise<RunnerSnapshot | null> =>
      ipcRenderer.invoke(IPC.Runner.Snapshot, goalId),
    onEvent: (cb: (event: GoalEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: GoalEvent): void => cb(event)
      ipcRenderer.on(IPC.Events.GoalEvent, listener)
      return () => ipcRenderer.removeListener(IPC.Events.GoalEvent, listener)
    }
  },
  // Plan mode (Phase 2+): interactive planning session before the runner starts
  // self-driving. The renderer's PlanReview page drives the lifecycle and
  // subscribes to onPlanEvent for assistant streaming + plan-ready signals.
  plan: {
    status: (goalId: string): Promise<PlanSessionStatus> =>
      ipcRenderer.invoke(IPC.Plan.Status, goalId),
    start: (goalId: string): Promise<PlanSessionStatus> =>
      ipcRenderer.invoke(IPC.Plan.Start, goalId),
    sendMessage: (goalId: string, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.Plan.SendMessage, goalId, text),
    approve: (goalId: string, plan: string): Promise<string> =>
      ipcRenderer.invoke(IPC.Plan.Approve, goalId, plan),
    abort: (goalId: string): Promise<boolean> => ipcRenderer.invoke(IPC.Plan.Abort, goalId),
    onEvent: (cb: (event: PlanEvent) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: PlanEvent): void => cb(event)
      ipcRenderer.on(IPC.Events.PlanEvent, listener)
      return () => ipcRenderer.removeListener(IPC.Events.PlanEvent, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
