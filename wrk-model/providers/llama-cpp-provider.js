'use strict'

const LLMProvider = require('./llm-provider')

/**
 * Llama-CPP Provider.
 *
 * Executes GGUF quantized models locally using node-llama-cpp.
 * Supports high-performance CPU/GPU inference with quantized parameters.
 */
class LlamaCppProvider extends LLMProvider {
  static _toPositiveNumber (value, fallback) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  static _sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  static async _acquireSequenceWithBackoff (context, opts = {}) {
    const timeoutMs = this._toPositiveNumber(opts.timeoutMs, 30000)
    const pollMs = this._toPositiveNumber(opts.pollMs, 25)
    const startedAt = Date.now()

    while ((Date.now() - startedAt) < timeoutMs) {
      if (context.sequencesLeft > 0) {
        try {
          return context.getSequence()
        } catch (err) {
          // Another request can grab the last free sequence between the check and acquisition.
          if (!String(err?.message || '').includes('No sequences left')) {
            throw err
          }
        }
      }

      await this._sleep(pollMs)
    }

    throw new Error(`ERR_LLAMA_SEQUENCE_TIMEOUT:${timeoutMs}`)
  }

  /**
   * Initialize llama-cpp provider.
   * Validates that node-llama-cpp is installed.
   *
   * @param {Object} providerConfig
   * @returns {Promise<Object>}
   */
  static async initialize (providerConfig) {
    try {
      await import('node-llama-cpp')
    } catch (err) {
      throw new Error(`ERR_NODE_LLAMA_CPP_NOT_INSTALLED:${err.message}`)
    }

    return {
      type: 'llama-cpp',
      config: providerConfig
    }
  }

  /**
   * Check if this provider handles GGUF format or explicit llama-cpp provider.
   * @param {Object} modelMeta
   * @returns {boolean}
   */
  static canHandle (modelMeta) {
    return modelMeta.format === 'gguf' || modelMeta.provider === 'llama-cpp'
  }

  /**
   * Load a GGUF model into memory.
   * @param {string} modelPath - local file path to GGUF model
   * @param {Object} modelMeta
   * @returns {Promise<Object>} { provider, modelPath, model, context }
   */
  static async loadModel (modelPath, modelMeta) {
    if (!modelPath) throw new Error('ERR_MODEL_PATH_REQUIRED')

    const { getLlama } = await import('node-llama-cpp')
    const llama = await getLlama()

    const model = await llama.loadModel({ modelPath })
    const context = await model.createContext()

    const sequenceAcquireTimeoutMs = this._toPositiveNumber(
      modelMeta?.sequenceAcquireTimeoutMs ?? modelMeta?._providerSettings?.sequenceAcquireTimeoutMs,
      30000
    )
    const sequenceAcquirePollMs = this._toPositiveNumber(
      modelMeta?.sequenceAcquirePollMs ?? modelMeta?._providerSettings?.sequenceAcquirePollMs,
      25
    )

    return {
      provider: 'llama-cpp',
      modelPath,
      model,
      context,
      sequenceAcquireTimeoutMs,
      sequenceAcquirePollMs
    }
  }

  /**
   * Generate text completion using llama-cpp.
   * @param {Object} instance
   * @param {string} prompt
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  static async generate (instance, prompt, params) {
    const { LlamaChatSession } = await import('node-llama-cpp')
    const contextSequence = await this._acquireSequenceWithBackoff(instance.context, {
      timeoutMs: instance.sequenceAcquireTimeoutMs,
      pollMs: instance.sequenceAcquirePollMs
    })

    const session = new LlamaChatSession({
      contextSequence,
      autoDisposeSequence: true
    })

    try {
      const start = Date.now()

      const output = await session.prompt(prompt, {
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        repeatPenalty: params.repeatPenalty
      })

      return {
        output,
        tokens: this._countTokens(output),
        latencyMs: Date.now() - start
      }
    } finally {
      session.dispose()
    }
  }

  /**
   * Cleanup model resources.
   * @param {Object} instance
   * @returns {Promise<void>}
   */
  static async unload (instance) {
    if (instance.context) {
      await instance.context.dispose()
    }
    if (instance.model) {
      await instance.model.dispose()
    }
  }
}

module.exports = LlamaCppProvider
