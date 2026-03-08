'use strict'

const LLMProvider = require('./llm-provider')

/**
 * Ollama Provider.
 *
 * Executes inference against a remote Ollama server.
 * Models are managed by Ollama; this provider acts as an HTTP client.
 */
class OllamaProvider extends LLMProvider {
  /**
   * Initialize ollama provider.
   * Validates that Ollama endpoint is reachable.
   *
   * @param {Object} providerConfig - must include endpoint
   * @returns {Promise<Object>}
   */
  static async initialize (providerConfig) {
    const endpoint = providerConfig.endpoint
    if (!endpoint) {
      throw new Error('ERR_OLLAMA_ENDPOINT_REQUIRED')
    }

    try {
      const response = await fetch(`${endpoint}/api/tags`, { timeout: 5000 })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
    } catch (err) {
      throw new Error(`ERR_OLLAMA_UNREACHABLE:${endpoint}:${err.message}`)
    }

    return {
      type: 'ollama',
      endpoint,
      config: providerConfig
    }
  }

  /**
   * Check if this provider handles ollama configuration.
   * @param {Object} modelMeta
   * @returns {boolean}
   */
  static canHandle (modelMeta) {
    return modelMeta.provider === 'ollama'
  }

  /**
   * Load a model (no-op for Ollama; managed by server).
   * @param {string} modelName - Ollama model identifier
   * @param {Object} modelMeta
   * @returns {Promise<Object>}
   */
  static async loadModel (modelName, modelMeta) {
    if (!modelName) throw new Error('ERR_MODEL_NAME_REQUIRED')

    return {
      provider: 'ollama',
      modelName,
      endpoint: modelMeta._ollamaEndpoint // Injected by worker
    }
  }

  /**
   * Generate text completion using Ollama API.
   * @param {Object} instance
   * @param {string} prompt
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  static async generate (instance, prompt, params) {
    const url = `${instance.endpoint}/api/generate`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ***REMOVED*** instance.modelName,
        prompt,
        stream: false,
        temperature: params.temperature,
        top_p: params.topP,
        top_k: params.topK,
        num_predict: params.maxTokens
      })
    })

    if (!response.ok) {
      throw new Error(
        `ERR_OLLAMA_API:${response.status}:${await response.text()}`
      )
    }

    const data = await response.json()
    const output = data.response || ''

    // Use actual token counts and duration from Ollama API
    // Ollama provides: prompt_eval_count, eval_count, total_duration (nanoseconds)
    const totalTokens = (data.prompt_eval_count || 0) + (data.eval_count || 0)
    const latencyMs = Math.round((data.total_duration || 0) / 1_000_000) // Convert ns to ms

    return {
      output,
      tokens: totalTokens,
      latencyMs
    }
  }

  /**
   * Cleanup (no-op for Ollama).
   * @param {Object} instance
   * @returns {Promise<void>}
   */
  static async unload (instance) {
    // Ollama manages its own lifecycle; nothing to cleanup
  }
}

module.exports = OllamaProvider
