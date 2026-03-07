'use strict'

const async = require('async')
const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const WrkBase = require('wrk-base/workers/base.wrk')

/**
 * Model Worker.
 *
 * Manages one or more AI models loaded locally on this node.
 * Exposes RPC endpoints so Inference Workers can query available models
 * and request synchronous model execution.
 *
 * Architecture notes:
 *   - Each physical GPU node runs exactly one Model Worker.
 *   - Models are loaded lazily on first request and cached in `this.mem.models`.
 *
 * Supported RPC methods:
 *   - listModels    – return catalogue of available models
 *   - loadModel     – explicitly pre-load a model into memory
 *   - unloadModel   – free model from memory
 *   - runModel      – execute inference (called by WrkInference)
 *   - getModelInfo  – return metadata for a specific model
 *
 * @extends WrkBase
 */
class WrkModel extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)

    if (!ctx.rack) throw new Error('ERR_RACK_UNDEFINED')

    this.prefix = `wrk-model-${ctx.rack}`

    this.mem = {
      models: {} // modelId → { meta, instance, loadedAt }
    }

    this.init()
    this.start()
  }

  init () {
    super.init()

    this.setInitFacs([['fac', 'bfx-facs-interval', '0', '0', {}, 0]])
  }

  _ensureModelMem () {
    if (!this.mem || typeof this.mem !== 'object') this.mem = {}
    if (!this.mem.models || typeof this.mem.models !== 'object') {
      this.mem.models = {}
    }
    return this.mem.models
  }

  _getRuntimeProvider () {
    return this.conf.runtime?.provider || 'stub'
  }

  _getModelBaseDir () {
    return this.conf.runtime?.modelBaseDir || process.cwd()
  }

  _getModelCacheDir () {
    return (
      this.conf.runtime?.modelCacheDir ||
      path.resolve(this._getModelBaseDir(), '.cache')
    )
  }

  _isHttpUrl (value) {
    return /^https?:\/\//i.test(value || '')
  }

  _safeSlug (value) {
    return (
      String(value || '')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'model'
    )
  }

  _countTokens (text) {
    return String(text).trim().split(/\s+/).filter(Boolean).length
  }

  _buildHfHeaders (source) {
    const tokenEnv = source.tokenEnv || 'HF_TOKEN'
    const token =
      source.token || process.env[tokenEnv] || process.env.HUGGINGFACE_TOKEN
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  _buildLlamaParams (params = {}) {
    return {
      maxTokens: params.max_tokens || params.maxTokens || 50,
      temperature: params.temperature ?? 0.8,
      topP: params.top_p ?? params.topP ?? 0.95,
      topK: params.top_k ?? params.topK ?? 40
    }
  }

  async _disposeResource (resource, methodName) {
    if (resource && typeof resource[methodName] === 'function') {
      await resource[methodName]()
    }
  }

  _hfFileUrl (repo, revision, filePath) {
    const encodedPath = String(filePath)
      .split('/')
      .map((x) => encodeURIComponent(x))
      .join('/')

    return `https://huggingface.co/${repo}/resolve/${revision}/${encodedPath}`
  }

  async _ensureFileExists (filePath) {
    try {
      await fs.access(filePath)
      return true
    } catch (e) {
      return false
    }
  }

  async _downloadToFile (url, outPath, headers = {}) {
    const response = await fetch(url, { headers })

    if (!response.ok) {
      throw new Error(`ERR_REMOTE_FETCH_FAILED:${response.status}:${url}`)
    }

    const arr = await response.arrayBuffer()
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, Buffer.from(arr))
  }

  async _materializeModelMeta (modelMeta) {
    const source = modelMeta.source || {}

    if (source.type !== 'huggingface') {
      return modelMeta
    }

    const repo = source.repo
    const files = source.files || []
    const revision = source.revision || 'main'

    if (!repo) throw new Error('ERR_HF_REPO_REQUIRED')
    if (!Array.isArray(files) || !files.length) {
      throw new Error('ERR_HF_FILES_REQUIRED')
    }

    const modelCacheDir = path.resolve(
      this._getModelCacheDir(),
      this._safeSlug(repo),
      this._safeSlug(revision),
      this._safeSlug(modelMeta.id || crypto.randomUUID())
    )

    await fs.mkdir(modelCacheDir, { recursive: true })

    const headers = this._buildHfHeaders(source)

    for (const relFile of files) {
      const outPath = path.resolve(modelCacheDir, relFile)
      const shouldSkip =
        !source.forceDownload && (await this._ensureFileExists(outPath))

      if (shouldSkip) continue

      const remoteUrl = this._hfFileUrl(repo, revision, relFile)
      this.logger.info(
        { modelId: modelMeta.id, file: relFile },
        'downloading model asset'
      )
      await this._downloadToFile(remoteUrl, outPath, headers)
    }

    const modelPath = modelMeta.path
    if (!modelPath) throw new Error('ERR_HF_MODEL_PATH_REQUIRED')

    const configuredModelPath = path.resolve(modelCacheDir, modelPath)
    if (!(await this._ensureFileExists(configuredModelPath))) {
      throw new Error(
        `ERR_HF_MODEL_PATH_NOT_FOUND:${modelMeta.path || 'undefined'}`
      )
    }

    return {
      ...modelMeta,
      path: path.resolve(modelCacheDir, modelPath)
    }
  }

  _resolveModelPath (modelPath) {
    if (!modelPath) throw new Error('ERR_MODEL_PATH_REQUIRED')

    if (modelPath.startsWith('s3://')) {
      throw new Error('ERR_REMOTE_MODEL_PATH_UNSUPPORTED')
    }

    if (this._isHttpUrl(modelPath)) {
      throw new Error('ERR_REMOTE_MODEL_PATH_UNSUPPORTED')
    }

    if (path.isAbsolute(modelPath)) return modelPath

    const baseDir = this._getModelBaseDir()
    return path.resolve(baseDir, modelPath)
  }

  async _getLlamaRuntime () {
    if (this.mem.llamaRuntime) return this.mem.llamaRuntime

    let llamaMod
    try {
      llamaMod = await import('node-llama-cpp')
    } catch (e) {
      throw new Error('ERR_NODE_LLAMA_CPP_NOT_INSTALLED')
    }

    const { getLlama, LlamaChatSession } = llamaMod
    const llama = await getLlama()

    this.mem.llamaRuntime = { llama, LlamaChatSession }
    return this.mem.llamaRuntime
  }

  // ─── Model catalogue ─────────────────────────────────────────────────────

  /**
   * Return all models declared in config, annotated with loaded state.
   * config.models should be an array of model descriptor objects:
   *   [{ id, name, path, quantization, contextLength }]
   *
   * @returns {Promise<Object[]>}
   */
  async listModels () {
    const declared = this.conf.models || []
    const models = this._ensureModelMem()

    return declared.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type || 'text-generation',
      format: m.format || null,
      quantization: m.quantization || null,
      contextLength: m.contextLength || null,
      loaded: !!models[m.id]
    }))
  }

  /**
   * Return metadata for a single model.
   * @param {Object} req
   * @param {string} req.modelId
   * @returns {Promise<Object>}
   */
  async getModelInfo (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')

    const declared = (this.conf.models || []).find((m) => m.id === req.modelId)
    if (!declared) throw new Error('ERR_MODEL_NOT_FOUND')
    const models = this._ensureModelMem()

    return {
      ...declared,
      loaded: !!models[req.modelId]
    }
  }

  // ─── Model lifecycle ─────────────────────────────────────────────────────

  /**
   * Load a model into memory.
   *
   * @param {string} modelId
   * @returns {Promise<void>}
   */
  async _loadModel (modelId) {
    const models = this._ensureModelMem()
    if (models[modelId]) return // already loaded

    const declared = (this.conf.models || []).find((m) => m.id === modelId)
    if (!declared) throw new Error('ERR_MODEL_NOT_FOUND')
    const modelMeta = await this._materializeModelMeta(declared)

    this.logger.info({ modelId }, 'loading model…')

    const provider = this._getRuntimeProvider()
    let instance

    if (provider === 'node-llama-cpp') {
      if (!modelMeta.path) throw new Error('ERR_MODEL_PATH_REQUIRED')
      const resolvedPath = this._resolveModelPath(modelMeta.path)

      const { llama } = await this._getLlamaRuntime()
      const model = await llama.loadModel({ modelPath: resolvedPath })
      const context = await model.createContext()

      instance = {
        provider,
        modelPath: resolvedPath,
        model,
        context
      }
    } else {
      instance = {
        path: modelMeta.path,
        provider: 'stub'
      }
    }

    models[modelId] = {
      meta: modelMeta,
      instance,
      loadedAt: Date.now()
    }
    this.logger.info({ modelId, provider }, 'model loaded')
  }

  /**
   * Unload a model to free memory.
   *
   * @param {Object} req
   * @param {string} req.modelId
   * @returns {Promise<1|0>}
   */
  async unloadModel (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')

    const models = this._ensureModelMem()
    if (!models[req.modelId]) return 0

    const modelEntry = models[req.modelId]
    const instance = modelEntry.instance || {}

    await Promise.all([
      this._disposeResource(instance.context, 'dispose'),
      this._disposeResource(instance.model, 'dispose'),
      this._disposeResource(instance.session, 'release'),
      this._disposeResource(instance.pipeline, 'dispose')
    ])

    delete models[req.modelId]
    this.logger.info({ modelId: req.modelId }, 'model unloaded')
    return 1
  }

  /**
   * Explicitly pre-load a model (useful for warm-up).
   * @param {Object} req
   * @param {string} req.modelId
   * @returns {Promise<1>}
   */
  async loadModel (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')
    await this._loadModel(req.modelId)
    return 1
  }

  // ─── Inference execution ─────────────────────────────────────────────────

  /**
   * Run inference for a single prompt.
   * Called by WrkInference over RPC.
   *
   * @param {Object} req
   * @param {string} req.modelId
   * @param {string} req.prompt
   * @param {Object} [req.params]      - temperature, max_tokens, top_p, etc.
   * @param {string} [req.traceId]     - Trace ID for request correlation
   * @returns {Promise<Object>} { output, tokens, latencyMs }
   */
  async runModel (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')

    const traceId = this.audit.getOrCreateTraceId(req)
    const timer = this.audit.createTimer()

    // Audit: Log incoming RPC request
    this.audit.logRequest(this.logger, traceId, 'runModel', {
      modelId: req.modelId,
      promptLength: req.prompt?.length,
      params: req.params
    })

    try {
      await this._loadModel(req.modelId) // lazy load

      const models = this._ensureModelMem()
      const entry = models[req.modelId]
      const start = Date.now()

      let output
      let tokenCount = 0
      const provider = entry.instance.provider || 'stub'

      if (provider === 'node-llama-cpp') {
        if (!req.prompt) throw new Error('ERR_PROMPT_REQUIRED')

        const { LlamaChatSession } = await this._getLlamaRuntime()
        const session = new LlamaChatSession({
          contextSequence: entry.instance.context.getSequence()
        })

        const params = req.params || {}
        const llamaParams = this._buildLlamaParams(params)

        output = await session.prompt(req.prompt, llamaParams)
        tokenCount = this._countTokens(output)
      } else {
        if (!req.prompt) throw new Error('ERR_PROMPT_REQUIRED')
        output = `[***REMOVED***${entry.meta.name}] ${req.prompt}`
        tokenCount = this._countTokens(output)
      }

      const result = {
        output,
        tokens: tokenCount,
        latencyMs: Date.now() - start
      }

      // Audit: Log successful response
      this.audit.logResponse(this.logger, traceId, 'runModel', {
        modelId: req.modelId,
        tokens: tokenCount,
        durationMs: timer(),
        provider
      })

      return result
    } catch (error) {
      // Audit: Log error
      this.audit.logError(this.logger, traceId, 'runModel', error, {
        modelId: req.modelId
      })
      throw error
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  _start (cb) {
    async.series(
      [
        (next) => {
          super._start(next)
        },
        async () => {
          const rpcServer = this.net_r0.rpcServer

          rpcServer.respond('listModels', (req) =>
            this.net_r0.handleReply('listModels', req)
          )
          rpcServer.respond('getModelInfo', (req) =>
            this.net_r0.handleReply('getModelInfo', req)
          )
          rpcServer.respond('loadModel', (req) =>
            this.net_r0.handleReply('loadModel', req)
          )
          rpcServer.respond('unloadModel', (req) =>
            this.net_r0.handleReply('unloadModel', req)
          )
          rpcServer.respond('runModel', (req) =>
            this.net_r0.handleReply('runModel', req)
          )

          this.status.rpcPublicKey = this.getRpcKey().toString('hex')
          this.saveStatus()

          this.logger.info({ rack: this.ctx.rack }, 'model worker ready')

          // Pre-warm models flagged with autoload
          const autoload = (this.conf.models || []).filter((m) => m.autoload)
          await async.eachLimit(autoload, 2, async (m) => {
            try {
              await this._loadModel(m.id)
            } catch (e) {
              this.logger.error(
                { modelId: m.id, err: e },
                'autoload model failed'
              )
            }
          })
        }
      ],
      cb
    )
  }
}

module.exports = WrkModel
