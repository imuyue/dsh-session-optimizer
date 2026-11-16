import { clearMigrationHistory, listMigrations } from './migrate.ts'
import type { PerformanceToolDefinition } from './performance-tool.ts'
/** Uses exactly the same Host operation as the recent-conversions button. */
export function createMigrationHistoryTool(): PerformanceToolDefinition {
  return {
    name: 'session_migration_history', deferLoading: true,
    description: '查看转换记录数量，或清空已结束的转换记录；保留正在运行和等待的任务，不改变任何会话文件。',
    parameters: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['status', 'clear'] } }, required: ['action'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1) throw new Error('expected a history action')
      const action = Reflect.get(args, 'action')
      if (action === 'clear') return clearMigrationHistory()
      if (action !== 'status') throw new Error('expected status or clear')
      const jobs = listMigrations(), running = jobs.filter(job => job.status === 'running').length
      return { total: jobs.length, running, finished: jobs.length - running }
    },
  }
}
