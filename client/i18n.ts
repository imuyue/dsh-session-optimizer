/**
 * Every word the console shows, in both languages.
 *
 * The settings view carries a language switch, so the whole panel has to be
 * translatable — a switch that only renamed one page would be a lie. Keeping the
 * strings in one module rather than inline has a second effect: the shape of the
 * interface is a checklist, and `TEXT` is a total record, so a view that grows a
 * sentence without a translation stops compiling instead of silently falling
 * back to Chinese in English mode.
 *
 * Interpolated sentences are functions, not templates with placeholders: word
 * order differs between the two languages ("已选择 3 个对话" against
 * "3 conversations selected"), and only a function can put the number where the
 * sentence needs it.
 *
 * @module dsh-session-optimizer/client/i18n
 */

/** Console language, mirroring the Host-side preference. */
export type Language = 'zh' | 'en'

/** The locale used for dates and digit grouping. */
export function localeOf(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en-US'
}

export interface Text {
  readonly title: string
  readonly refresh: string
  readonly refreshing: string
  readonly navLabel: string
  readonly nav: {
    readonly overview: string
    readonly transfer: string
    readonly metrics: string
    readonly settings: string
  }
  readonly footer: {
    /** The footer's conversation total, digits already grouped and localised. */
    readonly sessions: (count: string) => string
    readonly storage: string
  }
  readonly overview: {
    readonly reading: string
    readonly damaged: (count: string) => string
    readonly importing: (sessions: string, importing: string) => string
    readonly healthy: (sessions: string) => string
    readonly updatedAt: (when: string) => string
    readonly cardSessions: string
    readonly cardEvents: string
    readonly cardSpace: string
    readonly cardDamaged: string
    readonly allReady: string
    readonly stillImporting: (count: string) => string
    readonly acrossSessions: (count: string) => string
    readonly databaseNote: (size: string, wal: string) => string
    readonly nothingDamaged: string
    readonly metadataOnly: string
    readonly checkPending: string
    readonly seeTable: string
    readonly usageTitle: string
    readonly noSessions: string
    readonly untitled: string
    readonly readingTitle: string
    readonly childConversations: (value: string) => string
    readonly configTitle: string
    readonly format: string
    readonly layoutVersion: (version: number) => string
    readonly journal: string
    readonly thread: string
    readonly workerThread: string
    readonly hostThread: string
    readonly busyTimeout: string
    readonly mode: string
    readonly modePrivate: (mode: string) => string
    readonly modeShared: (mode: string) => string
    readonly modePlain: (mode: string) => string
    readonly tech: string
    readonly root: string
    readonly columns: {
      readonly session: string
      readonly events: string
      readonly size: string
      readonly share: string
    }
  }
  readonly transfer: {
    readonly directionLabel: string
    readonly rescan: string
    readonly scanning: string
    readonly filter: string
    readonly scanningList: string
    readonly conversations: (count: string) => string
    readonly showMore: string
    readonly previousPage: string
    readonly nextPage: string
    readonly pageOf: (page: number, total: number) => string
    readonly emptyNoRoot: string
    readonly emptyScanning: string
    readonly emptyNone: string
    readonly selectAll: string
    readonly selectOne: (id: string) => string
    readonly currentFormat: (backend: string) => string
    readonly alreadyIn: (backend: string) => string
    readonly linkedChildren: string
    readonly modeOverwrite: string
    readonly modeClone: string
    readonly verify: string
    readonly hintNone: string
    readonly hintSome: (count: number) => string
    readonly submit: string
    readonly submitMany: (count: number) => string
    readonly submitted: string
    readonly singleBackend: string
    readonly noRun: string
    readonly recent: string
    readonly clearHistory: string
    readonly statusDone: string
    readonly statusRunning: string
    readonly statusFailed: string
    readonly verified: string
    readonly failedCount: (count: number) => string
    readonly elapsed: (seconds: string) => string
    readonly failedFallback: string
    readonly noRoot: string
    readonly columns: {
      readonly conversation: string
      readonly events: string
      readonly size: string
      readonly created: string
    }
  }
  readonly metrics: {
    readonly reading: string
    readonly noSamples: string
    readonly window: (minutes: number) => string
    readonly retention: (count: number) => string
    readonly samples: string
    readonly failures: string
    readonly bucket: (seconds: number) => string
    readonly updatedAt: (when: string) => string
    readonly subtitle: string
    readonly nothingTimed: string
    readonly max: string
    readonly calls: string
    readonly noWindowSamples: string
    readonly chartLabel: (series: string) => string
    readonly failureSuffix: (count: number) => string
    readonly columns: {
      readonly op: string
      readonly count: string
      readonly p50: string
      readonly p95: string
      readonly p99: string
      readonly max: string
      readonly mean: string
    }
    /** Table labels for the six timed operations, keyed by their id. */
    readonly ops: Readonly<Record<string, string>>
  }
  readonly settings: {
    readonly storage: string
    readonly newFormat: string
    readonly default: string
    readonly sqliteTitle: string
    readonly sqliteDescription: string
    readonly sqliteSuitable: string
    readonly jsonlTitle: string
    readonly jsonlDescription: string
    readonly jsonlSuitable: string
    readonly stability: string
    readonly stabilityDescription: string
    readonly on: string
    readonly off: string
    readonly language: string
    readonly performance: {
      readonly title: string
      readonly enabled: string
      readonly historyWindow: string
      readonly virtualChat: string
      readonly restore: string
      readonly saving: string
      readonly syncing: string
    }
    readonly version: string
    readonly checkUpdate: string
    readonly checking: string
    readonly upToDate: string
    readonly build: string
    readonly repository: string
    readonly openRepository: string
    readonly support: string
    readonly feedback: string
    readonly license: string
    readonly reading: string
  }
  readonly diagnostics: {
    readonly logTitle: string
    readonly empty: string
    readonly clear: string
    readonly cleared: (count: string) => string
    readonly columns: {
      readonly at: string
      readonly level: string
      readonly scope: string
      readonly message: string
    }
    readonly uninstallTitle: string
    readonly uninstallHint: string
    readonly check: string
    readonly checking: string
    readonly unavailable: string
    readonly checkedAt: (when: string) => string
    readonly resultOk: (sqlite: string, jsonl: string) => string
    readonly resultOrphaned: (count: string) => string
    readonly resultUnreadable: (count: string) => string
    readonly orphanedTitle: string
    readonly unreadableTitle: string
  }
}

const ZH: Text = {
  title: '会话优化',
  refresh: '刷新',
  refreshing: '读取中…',
  navLabel: '会话优化视图',
  nav: { overview: '总览', transfer: '对话转换', metrics: '延迟', settings: '设置' },
  footer: { sessions: (count) => `${count} 个会话`, storage: 'SQLite 存储' },
  overview: {
    reading: '正在读取根目录…',
    damaged: (count) => `存储有异常：${count} 个会话无法完整读取`,
    importing: (sessions, importing) => `存储正常，${sessions} 个会话中 ${importing} 个仍在导入`,
    healthy: (sessions) => `存储正常，${sessions} 个会话均可读取`,
    updatedAt: (when) => `更新于 ${when}`,
    cardSessions: '会话',
    cardEvents: '事件',
    cardSpace: '占用空间',
    cardDamaged: '异常',
    allReady: '全部就绪',
    stillImporting: (count) => `${count} 个仍在导入`,
    acrossSessions: (count) => `${count} 个会话合计`,
    databaseNote: (size, wal) => `数据库 ${size} · WAL ${wal}`,
    nothingDamaged: '无损坏或待恢复会话',
    metadataOnly: '已读取会话文件清单',
    checkPending: '未执行全量校验',
    seeTable: '见下表标记的会话',
    usageTitle: '空间占用',
    noSessions: '这个目录里还没有会话。',
    untitled: '未命名',
    readingTitle: '读取标题中…',
    childConversations: value => `子对话（${value}）`,
    configTitle: '存储配置',
    format: '存储格式',
    layoutVersion: (version) => `SQLite · 布局版本 ${String(version)}`,
    journal: '写入模式',
    thread: '存储线程',
    workerThread: '独立 Worker',
    hostThread: '宿主线程',
    busyTimeout: '锁等待',
    mode: '目录权限',
    modePrivate: (mode) => `仅当前用户可访问 ${mode}`,
    modeShared: (mode) => `其他用户可访问 ${mode}`,
    modePlain: (mode) => `目录 ${mode}`,
    tech: '技术详情',
    root: '根目录',
    columns: { session: '会话', events: '事件', size: '大小', share: '占比' },
  },
  transfer: {
    directionLabel: '转换方向',
    rescan: '重新扫描',
    scanning: '扫描中…',
    filter: '按标题或会话 ID 过滤',
    scanningList: '正在扫描…',
    conversations: (count) => `${count} 个对话`,
    showMore: '显示更多',
    previousPage: '上一页',
    nextPage: '下一页',
    pageOf: (page, total) => `第 ${page} / ${total} 页`,
    emptyNoRoot: '还没有识别到可转换的对话。',
    emptyScanning: '正在扫描目录…',
    emptyNone: '这个目录里没有对话。',
    selectAll: '选择全部对话',
    selectOne: (id) => `选择对话 ${id}`,
    currentFormat: (backend) => `当前格式：${backend}`,
    alreadyIn: (backend) => `${backend} 库已有对应对话或副本`,
    linkedChildren: '会同时转换关联子对话；创建副本时会复制独立的子对话。',
    modeOverwrite: '转换后覆盖原对话',
    modeClone: '转换后创建新对话',
    verify: '完成后校验',
    hintNone: '未选择对话',
    hintSome: (count) => `已选择 ${String(count)} 个对话`,
    submit: '开始转换',
    submitMany: (count) => `转换 ${String(count)} 个对话`,
    submitted: '已提交…',
    singleBackend: '当前 profile 只挂了一个后端，没有可转换的目标。启用 hybrid 模式后这里才能提交。',
    noRun: '本进程还没有运行过转换。',
    recent: '最近转换',
    clearHistory: '清空记录',
    statusDone: '已完成',
    statusRunning: '进行中',
    statusFailed: '有失败',
    verified: '校验通过',
    failedCount: (count) => `${String(count)} 个失败`,
    elapsed: (seconds) => `用时 ${seconds}s`,
    failedFallback: '失败',
    noRoot: '还没有识别到可用的会话目录。',
    columns: { conversation: '对话', events: '事件', size: '大小', created: '创建时间' },
  },
  metrics: {
    reading: '正在读取采样…',
    noSamples: '本次运行还没有计时样本。用一次对话，再回到这里。',
    window: (minutes) => `记录范围：最近 ${String(minutes)} 分钟`,
    retention: (count) => `每类保留最近 ${String(count)} 条`,
    samples: '个样本',
    failures: '次失败',
    bucket: (seconds) => `每 ${String(seconds)} 秒聚合一次`,
    updatedAt: (when) => `更新于 ${when}`,
    subtitle: '已保留的真实操作耗时',
    nothingTimed: '还没有任何操作被计时。',
    max: '最大值',
    calls: '调用次数',
    noWindowSamples: '这个操作在本窗口内没有采样。',
    chartLabel: (series) => `${series} 的 p50、p95 与最大值曲线`,
    failureSuffix: (count) => `${String(count)} 失败`,
    columns: {
      op: '操作',
      count: '次数',
      p50: 'p50',
      p95: 'p95',
      p99: 'p99',
      max: '最大值',
      mean: '平均值',
    },
    ops: {
      read: '读取 read',
      append: '追加 append',
      flush: '刷新 flush',
      open: '打开 open',
      list: '列举 list',
      stat: '元数据 stat',
    },
  },
  settings: {
    storage: '存储',
    newFormat: '新对话数据存储格式',
    default: '默认',
    sqliteTitle: 'SQLite',
    sqliteDescription: '更流畅的长对话体验，更少的历史数据存储占用。',
    sqliteSuitable: '适合：日常使用、长时间对话、大型项目会话。',
    jsonlTitle: 'JSONL',
    jsonlDescription: 'DSH 官方原版，更好的兼容性。',
    jsonlSuitable: '适合：开发调试、手动处理日志、偏好原生格式的用户。',
    stability: '长对话稳定性修复',
    stabilityDescription: '修复部分 DSH 遗留的长对话稳定性问题，降低长时间使用时发生崩溃的风险。',
    on: '开启',
    off: '关闭',
    language: '语言 / Language',
    performance: {
      title: '可选性能优化',
      enabled: '启用可选性能优化',
      historyWindow: '加快历史加载',
      virtualChat: '轻量正文首屏',
      restore: '关闭全部优化并恢复官方',
      saving: '正在保存…',
      syncing: '正在同步…',
    },
    version: '当前插件版本',
    checkUpdate: '检查更新',
    checking: '检查中…',
    upToDate: '已是最新版本',
    build: '构建信息',
    repository: 'GitHub 仓库',
    openRepository: '打开仓库 ↗',
    support: '支持与许可',
    feedback: '反馈 ↗',
    license: '许可证 · MIT ↗',
    reading: '正在读取设置…',
  },
  diagnostics: {
    logTitle: '问题记录',
    empty: '自插件启动以来没有记录到问题。',
    clear: '清空记录',
    cleared: (count) => `已清空 ${count} 条记录`,
    columns: { at: '时间', level: '级别', scope: '位置', message: '内容' },
    uninstallTitle: '卸载前检查',
    uninstallHint: '只存在于 SQLite 的对话，在移除插件后不会出现在 DSH 里。先导出再卸载。',
    check: '开始检查',
    checking: '检查中…',
    unavailable: '这个挂载没有 JSONL 目录可比对，无法判断卸载会隐藏哪些对话。',
    checkedAt: (when) => `检查于 ${when}`,
    resultOk: (sqlite, jsonl) => `两个目录一致：${sqlite} 个 SQLite 会话，${jsonl} 个 JSONL 会话，卸载不会隐藏任何对话。`,
    resultOrphaned: (count) => `${count} 个对话只存在于 SQLite，卸载前请先导出。`,
    resultUnreadable: (count) => `${count} 个库读不出头部，无法判断它是否安全。`,
    orphanedTitle: '只存在于 SQLite',
    unreadableTitle: '无法读取的库',
  },
}

const EN: Text = {
  title: 'Session Optimization',
  refresh: 'Refresh',
  refreshing: 'Loading…',
  navLabel: 'Session optimization views',
  nav: {
    overview: 'Overview',
    transfer: 'Conversation transfer',
    metrics: 'Latency',
    settings: 'Settings',
  },
  footer: { sessions: (count) => `${count} conversations`, storage: 'SQLite storage' },
  overview: {
    reading: 'Reading the root…',
    damaged: (count) => `Something is wrong: ${count} conversations cannot be read in full`,
    importing: (sessions, importing) => `Storage is healthy; ${importing} of ${sessions} conversations are still importing`,
    healthy: (sessions) => `Storage is healthy; all ${sessions} conversations are readable`,
    updatedAt: (when) => `Updated ${when}`,
    cardSessions: 'Conversations',
    cardEvents: 'Events',
    cardSpace: 'Space used',
    cardDamaged: 'Problems',
    allReady: 'All ready',
    stillImporting: (count) => `${count} still importing`,
    acrossSessions: (count) => `Across ${count} conversations`,
    databaseNote: (size, wal) => `Database ${size} · WAL ${wal}`,
    nothingDamaged: 'Nothing damaged or awaiting repair',
    metadataOnly: 'Session file inventory loaded',
    checkPending: 'Full validation not run',
    seeTable: 'See the marked rows below',
    usageTitle: 'Space used',
    noSessions: 'This root has no conversations yet.',
    untitled: 'Untitled',
    readingTitle: 'Reading title…',
    childConversations: value => `Sub-conversations (${value})`,
    configTitle: 'Storage settings',
    format: 'Storage format',
    layoutVersion: (version) => `SQLite · layout version ${String(version)}`,
    journal: 'Write mode',
    thread: 'Storage thread',
    workerThread: 'Worker thread',
    hostThread: 'Host thread',
    busyTimeout: 'Lock wait',
    mode: 'Directory permissions',
    modePrivate: (mode) => `Only the current user can read it ${mode}`,
    modeShared: (mode) => `Other users can read it ${mode}`,
    modePlain: (mode) => `Directory ${mode}`,
    tech: 'Technical details',
    root: 'Root',
    columns: { session: 'Conversation', events: 'Events', size: 'Size', share: 'Share' },
  },
  transfer: {
    directionLabel: 'Direction',
    rescan: 'Rescan',
    scanning: 'Scanning…',
    filter: 'Filter by title or conversation ID',
    scanningList: 'Scanning…',
    conversations: (count) => `${count} conversations`,
    showMore: 'Show more',
    previousPage: 'Previous',
    nextPage: 'Next',
    pageOf: (page, total) => `Page ${page} / ${total}`,
    emptyNoRoot: 'No convertible conversations found yet.',
    emptyScanning: 'Scanning the directory…',
    emptyNone: 'This directory has no conversations.',
    selectAll: 'Select every conversation',
    selectOne: (id) => `Select conversation ${id}`,
    currentFormat: (backend) => `Current format: ${backend}`,
    alreadyIn: (backend) => `Matching conversation or copy in ${backend}`,
    linkedChildren: 'Includes linked sub-conversations. New copies receive independent sub-conversations.',
    modeOverwrite: 'Convert and replace the original',
    modeClone: 'Convert into a new conversation',
    verify: 'Verify when done',
    hintNone: 'No conversation selected',
    hintSome: (count) => `${String(count)} conversations selected`,
    submit: 'Start',
    submitMany: (count) => `Convert ${String(count)} conversations`,
    submitted: 'Submitted…',
    singleBackend: 'This profile mounts a single backend, so there is nowhere to convert to. Enable hybrid mode to submit from here.',
    noRun: 'No conversion has run in this process.',
    recent: 'Latest conversion',
    clearHistory: 'Clear history',
    statusDone: 'Completed',
    statusRunning: 'Running',
    statusFailed: 'Failed',
    verified: 'Verified',
    failedCount: (count) => `${String(count)} failed`,
    elapsed: (seconds) => `Took ${seconds}s`,
    failedFallback: 'Failed',
    noRoot: 'No usable conversation directory was found yet.',
    columns: { conversation: 'Conversation', events: 'Events', size: 'Size', created: 'Created' },
  },
  metrics: {
    reading: 'Reading samples…',
    noSamples: 'Nothing has been timed in this run. Use a conversation, then come back here.',
    window: (minutes) => `Recorded range: last ${String(minutes)} minutes`,
    retention: (count) => `Latest ${String(count)} calls per operation`,
    samples: 'samples',
    failures: 'failures',
    bucket: (seconds) => `Aggregated every ${String(seconds)}s`,
    updatedAt: (when) => `Updated ${when}`,
    subtitle: 'Retained real operation durations',
    nothingTimed: 'No operation has been timed yet.',
    max: 'Max',
    calls: 'Calls',
    noWindowSamples: 'This operation has no samples in the window.',
    chartLabel: (series) => `${series}: p50, p95 and max`,
    failureSuffix: (count) => `${String(count)} failed`,
    columns: {
      op: 'Operation',
      count: 'Calls',
      p50: 'p50',
      p95: 'p95',
      p99: 'p99',
      max: 'Max',
      mean: 'Mean',
    },
    ops: {
      read: 'Read',
      append: 'Append',
      flush: 'Flush',
      open: 'Open',
      list: 'List',
      stat: 'Stat',
    },
  },
  settings: {
    storage: 'Storage',
    newFormat: 'Storage format for new conversations',
    default: 'Default',
    sqliteTitle: 'SQLite',
    sqliteDescription: 'Smoother long conversations with less historical data storage.',
    sqliteSuitable: 'Best for daily use, long conversations, and large projects.',
    jsonlTitle: 'JSONL',
    jsonlDescription: 'The original DSH format with broader compatibility.',
    jsonlSuitable: 'Best for development, debugging, manual log processing, and users who prefer the native format.',
    stability: 'Long conversation stability fixes',
    stabilityDescription: 'Fixes selected legacy DSH stability issues and reduces the risk of crashes during extended use.',
    on: 'On',
    off: 'Off',
    language: '语言 / Language',
    performance: {
      title: 'Optional performance optimizations',
      enabled: 'Enable optional performance optimizations',
      historyWindow: 'Faster history loading',
      virtualChat: 'Lightweight chat first page',
      restore: 'Disable all optimizations and restore official behavior',
      saving: 'Saving…',
      syncing: 'Syncing…',
    },
    version: 'Plugin version',
    checkUpdate: 'Check for updates',
    checking: 'Checking…',
    upToDate: "You're up to date",
    build: 'Build information',
    repository: 'GitHub repository',
    openRepository: 'Open repository ↗',
    support: 'Support and license',
    feedback: 'Feedback ↗',
    license: 'License · MIT ↗',
    reading: 'Reading settings…',
  },
  diagnostics: {
    logTitle: 'Reported problems',
    empty: 'Nothing has been reported since the plugin started.',
    clear: 'Clear the log',
    cleared: (count) => `Cleared ${count} entries`,
    columns: { at: 'When', level: 'Level', scope: 'Where', message: 'What' },
    uninstallTitle: 'Before uninstalling',
    uninstallHint: 'Conversations that exist only in SQLite disappear from DSH when the plugin is removed. Export them first.',
    check: 'Run the check',
    checking: 'Checking…',
    unavailable: 'This mount has no JSONL directory to compare against, so which conversations an uninstall would hide is unknown.',
    checkedAt: (when) => `Checked ${when}`,
    resultOk: (sqlite, jsonl) => `Both directories agree: ${sqlite} SQLite sessions, ${jsonl} JSONL sessions, nothing would be hidden.`,
    resultOrphaned: (count) => `${count} conversations exist only in SQLite; export them before uninstalling.`,
    resultUnreadable: (count) => `${count} stores have an unreadable header, so whether they are safe is unknown.`,
    orphanedTitle: 'Only in SQLite',
    unreadableTitle: 'Unreadable stores',
  },
}

/** The dictionary for one language. */
export function textOf(language: Language): Text {
  return language === 'zh' ? ZH : EN
}
