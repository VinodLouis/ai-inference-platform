import api from '../api'
import type {
  InferenceComposerFormValues,
  InferenceJob,
  InferenceStatusResponse,
  ModelInfo
} from '../types'

export interface RackInfo {
  id: string
}

export interface SubmitInferenceResponse {
  jobId?: string
  rackId?: string
  status?: string
}

export interface RawInferenceJob extends Partial<InferenceJob> {
  id?: string
  result?: {
    output?: string
    text?: string
  }
  text?: string
}

export async function fetchModels (): Promise<ModelInfo[]> {
  const result = await api.get<ModelInfo[]>('/models')
  return Array.isArray(result.data) ? result.data : []
}

export async function submitInferenceRequest (
  values: InferenceComposerFormValues
): Promise<SubmitInferenceResponse> {
  const payload = {
    modelId: values.modelId,
    prompt: values.prompt,
    params: {
      max_tokens: values.maxTokens,
      temperature: values.temperature,
      top_p: values.topP
    }
  }

  const result = await api.post<SubmitInferenceResponse>('/inference', payload)
  return result.data || {}
}

export async function fetchInferenceRacks (): Promise<RackInfo[]> {
  const result = await api.get<RackInfo[]>('/racks', { params: { type: 'inference' } })
  return Array.isArray(result.data) ? result.data : []
}

export async function fetchJobsByRack (rackId: string, limit = 100): Promise<RawInferenceJob[]> {
  const result = await api.get<RawInferenceJob[]>('/inference', {
    params: {
      rackId,
      limit
    }
  })

  return Array.isArray(result.data) ? result.data : []
}

export async function fetchInferenceStatus (jobId: string): Promise<InferenceStatusResponse> {
  const result = await api.get<InferenceStatusResponse>(`/inference/${jobId}`)
  return result.data || {}
}
