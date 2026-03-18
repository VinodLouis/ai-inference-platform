export interface User {
  email: string
  roles: string[]
}

export interface SessionState {
  token: string
  user: User | null
}

export interface ModelInfo {
  id: string
  name?: string
  provider?: string
}

export interface InferenceJob {
  jobId: string
  rackId: string
  status: string
  modelId: string
  prompt: string
  createdAt: string | number
  updatedAt: string | number
  output: string
}

export interface LoginResponse {
  token?: string
  user?: User
}

export interface CreateUserFormValues {
  email: string
  password: string
  signupSecret: string
  roles: string
}

export interface LoginFormValues {
  email: string
  password: string
}

export interface InferenceComposerFormValues {
  modelId: string
  prompt: string
  maxTokens: number
  temperature: number
  topP: number
}

export interface InferenceStatusResponse {
  status?: string
  modelId?: string
  rackId?: string
  prompt?: string
  updatedAt?: string | number
  result?: {
    output?: string
    text?: string
  }
  output?: string
}
