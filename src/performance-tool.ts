import { PreferencesUsageError } from './preferences.ts'
import type { PerformanceController } from './performance.ts'

export interface PerformanceToolDefinition {
  readonly name: string
  readonly description: string
  readonly deferLoading: true
  readonly parameters: Record<string, unknown>
  readonly output: { readonly schema: { readonly type: 'object'; readonly additionalProperties: true }; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  execute(args: unknown): Promise<unknown>
}
export interface PerformanceToolRegistry { register(definition: PerformanceToolDefinition): () => void }

/** UI and agent callers operate on this same live, versioned Host controller. */
export function createPerformanceTool(controller: PerformanceController): PerformanceToolDefinition {
  return {
    name: 'session_performance',
    deferLoading: true,
    description: '读取或修改会话加载预览、屏外正文布局优化；设置对当前配置共享。修改前用 status 获取 revision，disable 同时关闭全部三个开关并恢复官方路径。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'update', 'disable'] },
        expectedRevision: { type: 'string', description: 'update/disable 必填：最近 status 返回的 revision。' },
        patch: { type: 'object', description: '仅 update 使用；三个开关均默认 false。', additionalProperties: false, properties: { enabled: { type: 'boolean' }, historyWindow: { type: 'boolean' }, virtualChat: { type: 'boolean' } } },
      }, required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PreferencesUsageError('expected a performance action object')
      const value = args as Record<string, unknown>
      if (Object.keys(value).some(key => !['action', 'patch', 'expectedRevision'].includes(key))) throw new PreferencesUsageError('unknown performance action field')
      // Some tool adapters materialize every optional field. Accept only their
      // inert placeholder (empty revision + all-false patch), never an enabling
      // patch on a read/disable action.
      const inertPatch = value.patch !== null && typeof value.patch === 'object' && !Array.isArray(value.patch)
        && Object.keys(value.patch).length === 3
        && ['enabled', 'historyWindow', 'virtualChat'].every(key => (value.patch as Record<string, unknown>)[key] === false)
      if (value.action === 'status') {
        if ((Object.hasOwn(value, 'expectedRevision') && value.expectedRevision !== '')
          || (Object.hasOwn(value, 'patch') && !inertPatch)) throw new PreferencesUsageError('status accepts only omitted fields or inert adapter placeholders')
        return controller.read()
      }
      if (typeof value.expectedRevision !== 'string' || value.expectedRevision.length > 128) throw new PreferencesUsageError('expectedRevision is required')
      if (value.action === 'disable' && (!Object.hasOwn(value, 'patch') || inertPatch)) return controller.disableAll(value.expectedRevision)
      if (value.action === 'update') return controller.update(value.patch, value.expectedRevision)
      throw new PreferencesUsageError('expected status, update, or disable')
    },
  }
}
