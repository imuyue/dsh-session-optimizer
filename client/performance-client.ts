import { useSyncExternalStore } from 'react'
import { getPerformanceSnapshot, subscribePerformance, type PerformanceSnapshot } from './performance-store.ts'
export * from './performance-store.ts'

export function usePerformance(): PerformanceSnapshot {
  return useSyncExternalStore(subscribePerformance, getPerformanceSnapshot, getPerformanceSnapshot)
}
