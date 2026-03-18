import { message } from 'antd'
import type { AxiosError } from 'axios'
import { useCallback, useEffect, useState } from 'react'
import { fetchInferenceRacks, fetchJobsByRack } from '../services/inferenceApi'
import type { InferenceJob } from '../types'
import { mergeAndSortJobsByCreatedAt, normalizeInferenceJob } from '../utils/inference'

interface ApiErrorResponse {
  error?: string
}

export function useInferenceHistory (userEmail?: string) {
  const [history, setHistory] = useState<InferenceJob[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const loadHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      const racks = await fetchInferenceRacks()

      const perRackResults = await Promise.all(
        racks.map(async (rack) => {
          try {
            const rows = await fetchJobsByRack(rack.id)
            return rows.map((job) => normalizeInferenceJob(job, rack.id))
          } catch {
            return []
          }
        })
      )

      const merged = mergeAndSortJobsByCreatedAt(perRackResults.flat())
      setHistory(merged)
    } catch (err: unknown) {
      const apiError = err as AxiosError<ApiErrorResponse>
      message.error(apiError.response?.data?.error || 'Failed to load your inference history')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const appendHistory = useCallback((job: InferenceJob): void => {
    if (!job.jobId) return
    setHistory((prev) => [job, ...prev.filter((item) => item.jobId !== job.jobId)])
  }, [])

  useEffect(() => {
    loadHistory().catch(() => {})
  }, [userEmail, loadHistory])

  return {
    history,
    historyLoading,
    setHistory,
    loadHistory,
    appendHistory
  }
}
