export interface ToolStep {
  id: string
  kind: 'command' | 'read' | 'search' | 'check' | 'edit' | 'tool'
  label: string
  detail?: string
  tool?: string
  status: 'running' | 'completed' | 'failed' | 'declined' | 'finished'
  messageOffset: number
  afterFollowups: number
  startedAt: string
  durationMs?: number
  exitCode?: number
  checkResult?: 'passed' | 'issues'
  path?: string
  line?: number
  input?: string
  output?: string
  detailsOmitted?: boolean
}
export const MAX_TOOL_STEPS: number
export function mergeToolStep(steps: ToolStep[], step: ToolStep): ToolStep[]
export function isToolStep(value: unknown): value is ToolStep
