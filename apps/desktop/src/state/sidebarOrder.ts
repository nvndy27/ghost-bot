export function orderSidebarItems<T extends { id: string }>(
  items: readonly T[],
  pinnedIds: readonly string[],
  orderIds: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const pinnedSet = new Set(pinnedIds)
  const orderIndex = new Map<string, number>()
  for (const id of orderIds) {
    if (!orderIndex.has(id)) {
      orderIndex.set(id, orderIndex.size)
    }
  }
  const originalIndex = new Map(items.map((item, idx) => [item.id, idx]))

  const compare = (a: T, b: T): number => {
    const aPinned = pinnedSet.has(a.id)
    const bPinned = pinnedSet.has(b.id)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    const aOrd = orderIndex.get(a.id)
    const bOrd = orderIndex.get(b.id)
    if (aOrd !== undefined && bOrd !== undefined) return aOrd - bOrd
    if (aOrd !== undefined) return -1
    if (bOrd !== undefined) return 1
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0)
  }

  return [...byId.values()].sort(compare)
}
