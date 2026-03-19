'use strict'

const async = require('async')
const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const fsSync = require('fs')
const { Readable } = require('stream')
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
      models: {}, // modelId → { meta, instance, loadedAt }
      providers: {} // providerType → { config, Provider }
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

  _ensureProviderMem () {
    if (!this.mem || typeof this.mem !== 'object') this.mem = {}
    if (!this.mem.providers || typeof this.mem.providers !== 'object') {
      this.mem.providers = {}
    }
    return this.mem.providers
  }

  /**
   * Get loaded provider instance by type.
   * @param {string} providerType - e.g., 'llama-cpp', 'ollama'
   * @returns {Object} { Provider, config }
   * @throws if provider not initialized
   */
  _getProvider (providerType) {
    const providers = this._ensureProviderMem()
    if (!providers[providerType]) {
      throw new Error(`ERR_PROVIDER_NOT_CONFIGURED:${providerType}`)
    }
    return providers[providerType]
  }

  _getModelBaseDir () {
    const runtimeBaseDir = this.conf.runtime?.modelBaseDir
    if (runtimeBaseDir) return runtimeBaseDir

    const llamaProvider = (this.conf.runtime?.providers || []).find(
      (provider) => provider?.type === 'llama-cpp'
    )

    return llamaProvider?.settings?.modelBaseDir || process.cwd()
  }

  _getModelCacheDir () {
    const runtimeCacheDir = this.conf.runtime?.modelCacheDir
    if (runtimeCacheDir) return runtimeCacheDir

    const llamaProvider = (this.conf.runtime?.providers || []).find(
      (provider) => provider?.type === 'llama-cpp'
    )

    return (
      llamaProvider?.settings?.modelCacheDir ||
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

  _buildHfHeaders (source) {
    const tokenEnv = source.tokenEnv || 'HF_TOKEN'
    const token =
      source.token || process.env[tokenEnv] || process.env.HUGGINGFACE_TOKEN
    return token ? { Authorization: `Bearer ${token}` } : {}
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
    const response = await fetch(url, { headers, timeout: 300000 })

    if (!response.ok) {
      throw new Error(`ERR_REMOTE_FETCH_FAILED:${response.status}:${url}`)
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true })

    // Stream large files directly to disk
    const readStream = Readable.fromWeb(response.body)
    const writeStream = fsSync.createWriteStream(outPath)
    return new Promise((resolve, reject) => {
      readStream.pipe(writeStream)
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
      readStream.on('error', reject)
    })
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

  /**
   * Initialize all configured inference providers at startup.
   * @returns {Promise<void>}
   */
  async _initProviders () {
    const providerConfigs = this.conf.runtime?.providers || []
    const providers = this._ensureProviderMem()

    for (const providerConfig of providerConfigs) {
      if (!providerConfig.enabled) continue

      const providerType = providerConfig.type
      if (!providerType) {
        this.logger.warn({ providerConfig }, 'provider missing type')
        continue
      }

      try {
        const ProviderClass = require(`../providers/${providerType}-provider`)
        const instance = await ProviderClass.initialize(providerConfig)

        providers[providerType] = {
          Provider: ProviderClass,
          config: providerConfig,
          instance
        }

        this.logger.info({ provider: providerType }, 'provider initialized')

        // Auto-populate Ollama models if enabled
        if (
          providerType === 'ollama' &&
          providerConfig.enabled &&
          providerConfig.endpoint
        ) {
          try {
            const res = await fetch(`${providerConfig.endpoint}/api/tags`, {
              timeout: 5000
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            if (Array.isArray(data.models)) {
              for (const model of data.models) {
                const modelId = model.name || model.id
                if (!modelId) continue
                // Check if already registered (config or runtime)
                const already =
                  (this.conf.models || []).find((m) => m.id === modelId) ||
                  (await this.runtimeModels.get(modelId))
                if (already) continue
                await this.registerModel({
                  id: modelId,
                  name: model.name || modelId,
                  provider: 'ollama',
                  modelName: modelId,
                  autoload: false
                })
                this.logger.info({ modelId }, 'auto-registered Ollama model')
              }
            }
          } catch (err) {
            this.logger.warn({ err }, 'failed to auto-populate Ollama models')
          }
        }
      } catch (err) {
        this.logger.error(
          { provider: providerType, err },
          'provider initialization failed'
        )
        // Keep worker alive when an optional provider is unavailable.
        continue
      }
    }
  }

  // ─── Model catalogue ─────────────────────────────────────────────────────

  /**
   * Return all models: config + runtime registered, annotated with loaded state.
   *
   * @returns {Promise<Object[]>}
   */
  async listModels () {
    const declared = this.conf.models || []
    const models = this._ensureModelMem()

    // Fetch runtime-registered models
    const runtimeModels = []
    for await (const { value } of this.runtimeModels.createReadStream()) {
      runtimeModels.push(value)
    }

    const allModels = [...declared, ...runtimeModels]

    return allModels.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type || 'text-generation',
      provider: m.provider || 'unknown',
      format: m.format || null,
      quantization: m.quantization || null,
      contextLength: m.contextLength || null,
      loaded: !!models[m.id],
      source: m.registeredAt ? 'runtime' : 'config'
    }))
  }

  /**
   * Return metadata for a single model (config or runtime).
   * @param {Object} req
   * @param {string} req.modelId
   * @returns {Promise<Object>}
   */
  async getModelInfo (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')

    // Check config first
    let declared = (this.conf.models || []).find((m) => m.id === req.modelId)

    // Then check runtime registry
    if (!declared) {
      const runtimeEntry = await this.runtimeModels.get(req.modelId)
      declared = runtimeEntry?.value
    }

    if (!declared) throw new Error('ERR_MODEL_NOT_FOUND')

    const models = this._ensureModelMem()

    return {
      ...declared,
      loaded: !!models[req.modelId],
      source: declared.registeredAt ? 'runtime' : 'config'
    }
  }

  /**
   * Register a model at runtime (no config restart needed).
   * @param {Object} req
   * @param {string} req.id - unique model id
   * @param {string} req.name - display name
   * @param {string} req.provider - 'llama-cpp' | 'ollama'
   * @param {string} req.modelPath - local path or model identifier
   * @param {Object} [req.source] - optional remote source metadata (e.g. Hugging Face)
   * @param {boolean} [req.autoload] - if true, load immediately after registration
   * @param {Object} [req.config] - optional metadata
   * @returns {Promise<{success: true, modelId}>}
   */
  async registerModel (req) {
    if (!req.id || !req.provider) {
      throw new Error('ERR_MISSING_REQUIRED_FIELDS:id and provider')
    }

    // Validate provider is configured
    try {
      this._getProvider(req.provider)
    } catch (err) {
      throw new Error(`ERR_PROVIDER_NOT_AVAILABLE:${req.provider}`)
    }

    const modelMeta = {
      id: req.id,
      name: req.name || req.id,
      type: 'text-generation',
      provider: req.provider,
      path: req.modelPath || req.modelName,
      modelName: req.modelName,
      source: req.source,
      autoload: !!req.autoload,
      contextLength: req.config?.contextLength,
      quantization: req.config?.quantization,
      format: req.config?.format,
      registeredAt: Date.now()
    }

    // Persist in Hyperbee
    await this.runtimeModels.put(req.id, modelMeta)
    this.logger.info(
      { modelId: req.id, provider: req.provider },
      'model registered'
    )

    if (modelMeta.autoload) {
      await this._loadModel(req.id)
    }

    return { success: true, modelId: req.id }
  }

  /**
   * Deregister a runtime model. Removes runtime registry entry and unloads instance.
   * @param {Object} req
   * @param {string} req.modelId
   * @returns {Promise<{success: true, modelId: string}>}
   */
  async deregisterModel (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')

    // Attempt to unload if loaded; don't fail deregister on unload errors
    try {
      await this.unloadModel({ modelId: req.modelId })
    } catch (e) {
      this.logger.warn(
        { modelId: req.modelId, err: e },
        'unload during deregister failed'
      )
    }

    const runtimeEntry = await this.runtimeModels.get(req.modelId)
    if (!runtimeEntry || !runtimeEntry.value) { throw new Error('ERR_MODEL_NOT_FOUND') }

    await this.runtimeModels.del(req.modelId)
    this.logger.info({ modelId: req.modelId }, 'model deregistered')

    return { success: true, modelId: req.modelId }
  }

  // ─── Model lifecycle ─────────────────────────────────────────────────────

  /**
   * Load a model into memory.
   * Supports both config-defined and runtime-registered models.
   *
   * @param {string} modelId
   * @returns {Promise<void>}
   */
  async _loadModel (modelId) {
    const models = this._ensureModelMem()
    if (models[modelId]) return // already loaded

    // Find model in config or runtime registry
    let declared = (this.conf.models || []).find((m) => m.id === modelId)

    if (!declared) {
      const runtimeEntry = await this.runtimeModels.get(modelId)
      declared = runtimeEntry?.value
    }

    if (!declared) throw new Error('ERR_MODEL_NOT_FOUND')

    // Materialize model metadata (handle HF downloads, etc)
    const modelMeta = await this._materializeModelMeta(declared)

    // Get provider for this model
    const providerEntry = this._getProvider(modelMeta.provider)
    const ProviderClass = providerEntry.Provider

    this.logger.info(
      { modelId, provider: modelMeta.provider },
      'loading model…'
    )

    try {
      // Inject provider endpoint if needed (for Ollama)
      if (modelMeta.provider === 'ollama' && providerEntry.instance.endpoint) {
        modelMeta._ollamaEndpoint = providerEntry.instance.endpoint
      }

      // Provide provider-level settings to provider implementations for runtime tuning.
      modelMeta._providerSettings = providerEntry.config?.settings || {}

      // Load model using provider
      let providerModelPath = modelMeta.path || modelMeta.modelName
      if (modelMeta.provider === 'llama-cpp') {
        providerModelPath = this._resolveModelPath(providerModelPath)
      }

      const instance = await ProviderClass.loadModel(
        providerModelPath,
        modelMeta
      )

      models[modelId] = {
        meta: modelMeta,
        instance,
        provider: ProviderClass,
        loadedAt: Date.now()
      }

      this.logger.info(
        { modelId, provider: modelMeta.provider },
        'model loaded'
      )
    } catch (err) {
      this.logger.error({ modelId, err }, 'model load failed')
      throw err
    }
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
    const ProviderClass = modelEntry.provider

    try {
      // Use provider's unload method if available
      if (ProviderClass && typeof ProviderClass.unload === 'function') {
        await ProviderClass.unload(instance)
      } else {
        // Fallback: try generic disposal
        await Promise.all([
          this._disposeResource(instance.context, 'dispose'),
          this._disposeResource(instance.model, 'dispose'),
          this._disposeResource(instance.session, 'release'),
          this._disposeResource(instance.pipeline, 'dispose')
        ])
      }

      delete models[req.modelId]
      this.logger.info({ modelId: req.modelId }, 'model unloaded')
      return 1
    } catch (err) {
      this.logger.error({ modelId: req.modelId, err }, 'model unload failed')
      throw err
    }
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
   * Run inference for a single prompt using the appropriate provider.
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
      if (!req.prompt) throw new Error('ERR_PROMPT_REQUIRED')

      // Auto-load if not loaded
      await this._loadModel(req.modelId)

      const models = this._ensureModelMem()
      const entry = models[req.modelId]

      if (!entry) throw new Error('ERR_MODEL_LOAD_FAILED')

      const ProviderClass = entry.provider

      // Normalize params using provider
      const params = ProviderClass.normalizeParams(req.params || {})

      // Execute inference
      const result = await ProviderClass.generate(
        entry.instance,
        req.prompt,
        params
      )

      // Audit: Log successful response
      this.audit.logResponse(this.logger, traceId, 'runModel', {
        modelId: req.modelId,
        tokens: result.tokens,
        durationMs: timer(),
        provider: entry.meta.provider
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
          // Initialize Hyperbee for runtime model registry
          this.runtimeModels = await this.store_s0.getBee(
            { name: 'runtime-models' },
            { keyEncoding: 'utf-8', valueEncoding: 'json' }
          )
          await this.runtimeModels.ready()

          // Initialize all configured providers
          await this._initProviders()

          const rpcServer = this.net_r0.rpcServer

          rpcServer.respond('listModels', (req) =>
            this.net_r0.handleReply('listModels', req)
          )
          rpcServer.respond('getModelInfo', (req) =>
            this.net_r0.handleReply('getModelInfo', req)
          )
          rpcServer.respond('registerModel', (req) =>
            this.net_r0.handleReply('registerModel', req)
          )
          rpcServer.respond('deregisterModel', (req) =>
            this.net_r0.handleReply('deregisterModel', req)
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
          const runtimeAutoload = []
          for await (const { value } of this.runtimeModels.createReadStream()) {
            if (value?.autoload) runtimeAutoload.push(value)
          }

          const autoload = [
            ...(this.conf.models || []),
            ...runtimeAutoload
          ].filter((m) => m.autoload)
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
