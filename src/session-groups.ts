/** Group only explicit subagents. Forks, missing parents and cycles stay visible. */
export function sessionParents(rows: readonly { id: string; origin?: 'subagent'; parentSession?: string }[]): ReadonlyMap<string, string> {
  const all = new Map(rows.map(row => [row.id, row])), owners = new Map<string, string>()
  for (const row of rows) {
    if (row.origin !== 'subagent' || row.parentSession === undefined || !all.has(row.parentSession)) continue
    let id: string | undefined = row.id
    const seen = new Set<string>()
    while (id !== undefined && all.has(id) && !seen.has(id) && seen.size < 128) {
      seen.add(id)
      const value: { origin?: 'subagent'; parentSession?: string } = all.get(id)!
      id = value.origin === 'subagent' ? value.parentSession : undefined
    }
    if (id === undefined || !all.has(id)) owners.set(row.id, row.parentSession)
  }
  return owners
}
export function sessionChildCounts(owners: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const id of owners.values()) result.set(id, (result.get(id) ?? 0) + 1)
  return result
}
export function sessionRoot(id: string, owners: ReadonlyMap<string, string>): string {
  let root = id
  while (owners.has(root)) root = owners.get(root)!
  return root
}
export function groupedSessions<T extends { id: string; origin?: 'subagent'; parentSession?: string; title?: string | undefined }>(rows: readonly T[], query = '', parent?: string): Array<T & { childCount: number }> {
  const owners = sessionParents(rows), counts = sessionChildCounts(owners)
  const q = query.trim().toLowerCase()
  const matchedRoots = q === '' || parent !== undefined ? undefined : new Set(rows
    .filter(row => row.id.toLowerCase().includes(q) || (row.title ?? '').toLowerCase().includes(q))
    .map(row => sessionRoot(row.id, owners)))
  return rows.filter(row => parent === undefined
    ? !owners.has(row.id) && (matchedRoots === undefined || matchedRoots.has(row.id))
    : owners.get(row.id) === parent).map(row => ({ ...row, childCount: counts.get(row.id) ?? 0 }))
}
