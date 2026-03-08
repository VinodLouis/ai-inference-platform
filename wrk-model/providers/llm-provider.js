'use strict'

/**
 * Base class for LLM inference providers.
 *
 * Providers handle model loading and inference execution.
 * Each provider type corresponds to an inference engine:
 *   - llama-cpp: Local CPU/GPU via node-llama-cpp
 *   - ollama: Remote Ollama server
 */
class LLMProvider {
  /**
   * Initialize provider infrastructure (called at startup).
   * Validates endpoints, loads dependencies, etc.
   * Must be called before any models are loaded.
   *
   * @param {Object} providerConfig - Config from runtime.providers
   * @returns {Promise<Object>} initialized provider state
   */
  static async initialize (providerConfig) {
    throw new Error('Not implemented')
  }

  /**
   * Check if this provider can handle the model configuration.
   * @param {Object} modelMeta - model configuration
   * @returns {boolean}
   */
  static canHandle (modelMeta) {
    throw new Error('Not implemented')
  }

  /**
   * Load a model into memory.
   * @param {string} modelPath - resolved file path or model identifier
   * @param {Object} modelMeta - full model configuration
   * @returns {Promise<Object>} normalized instance object
   */
  static async loadModel (modelPath, modelMeta) {
    throw new Error('Not implemented')
  }

  /**
   * Generate text completion.
   * @param {Object} instance - loaded model instance
   * @param {string} prompt - input text
   * @param {Object} params - normalized inference parameters
   * @returns {Promise<Object>} { output, tokens, latencyMs }
   */
  static async generate (instance, prompt, params) {
    throw new Error('Not implemented')
  }

  /**
   * Unload model and cleanup resources.
   * @param {Object} instance - loaded model instance
   * @returns {Promise<void>}
   */
  static async unload (instance) {
    throw new Error('Not implemented')
  }

  /**
   * Normalize inference parameters to provider-specific format.
   * @param {Object} params - raw request parameters
   * @returns {Object} normalized parameters
   */
  static normalizeParams (params) {
    return {
      maxTokens: params.max_tokens || params.maxTokens || 50,
      temperature: params.temperature ?? 0.8,
      topP: params.top_p ?? params.topP ?? 0.95,
      topK: params.top_k ?? params.topK ?? 40,
      repeatPenalty: params.repeat_penalty ?? params.repeatPenalty ?? 1.1
    }
  }

  /**
   * Count tokens in text (simple approximation).
   * @param {string} text
   * @returns {number}
   */
  static _countTokens (text) {
    return String(text).trim().split(/\s+/).filter(Boolean).length
  }
}

module.exports = LLMProvider
