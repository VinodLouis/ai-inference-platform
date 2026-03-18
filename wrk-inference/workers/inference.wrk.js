'use strict'

const async = require('async')
const crypto = require('crypto')
const WrkBase = require('wrk-base/workers/base.wrk')

/**
 * Inference Worker.
 *
 * Responsible for executing AI inference jobs locally.
 * Each instance manages a job queue, communicates with a local Model Worker
 * to run the actual model, and stores job history in Hyperbee.
 *
 * Supported RPC methods:
 *   - runInference   – enqueue and execute a new job
 *   - getJobStatus   – poll job state by ID
 *   - cancelJob      – request cancellation of a running job
 *   - listJobs       – list recent jobs (with optional status filter)
 *
 * @extends WrkBase
 */
class WrkInference extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)

    if (!ctx.rack) throw new Error('ERR_RACK_UNDEFINED')

    this.prefix = `wrk-inference-${ctx.rack}`

    this.mem = {
      jobs: {} // jobId → job object (in-flight or recently completed)
    }

    this.init()
    this.start()
  }

  init () {
    super.init()

    this.setInitFacs([['fac', 'bfx-facs-interval', '0', '0', {}, 0]])
  }

  _ensureJobsMem () {
    if (!this.mem || typeof this.mem !== 'object') this.mem = {}
    if (!this.mem.jobs || typeof this.mem.jobs !== 'object') {
      this.mem.jobs = {}
    }
    return this.mem.jobs
  }

  // ─── Job helpers ─────────────────────────────────────────────────────────

  /**
   * Create a job object.
   * @param {Object} req  - Original inference request
   * @returns {Object} job
   */
  _createJob (req) {
    return {
      id: crypto.randomUUID(),
      modelId: req.modelId,
      prompt: req.prompt,
      userEmail: req.userEmail || null,
      userRoles: req.userRoles || [],
      params: req.params || {},
      status: 'queued', // queued | running | completed | failed | cancelled
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }

  /**
   * Persist a job to Hyperbee and keep a reference in memory.
   * @param {Object} job
   */
  async _saveJob (job) {
    job.updatedAt = Date.now()
    const jobs = this._ensureJobsMem()
    jobs[job.id] = job
    await this.jobs.put(job.id, job)
  }

  /**
   * Execute model inference via RPC call to Model Worker.
   * Routes request to configured model worker via its RPC key.
   *
   * @param {Object} job
   * @returns {Promise<Object>} { output, tokens, latencyMs }
   */
  async _execModel (job) {
    const start = Date.now()

    const modelRpcKey = this.conf.modelWorkerRpcKey

    if (!modelRpcKey) {
      throw new Error('ERR_MODEL_WORKER_RPC_KEY_MISSING')
    }

    // Audit: Log outgoing RPC call to model worker
    const timer = this.audit.createTimer()
    this.audit.logRpcCall(
      this.logger,
      job.traceId || job.id,
      modelRpcKey.substring(0, 16),
      'runModel',
      { jobId: job.id, modelId: job.modelId }
    )

    // Call model worker's runModel method
    const result = await this.net_r0.jRequest(
      modelRpcKey,
      'runModel',
      {
        modelId: job.modelId,
        prompt: job.prompt,
        params: job.params,
        traceId: job.traceId || job.id // Propagate trace ID
      },
      { timeout: 60000 }
    )

    // Audit: Log RPC response
    this.audit.logRpcResponse(
      this.logger,
      job.traceId || job.id,
      modelRpcKey.substring(0, 16),
      'runModel',
      { jobId: job.id, durationMs: timer(), tokens: result.tokens }
    )

    return {
      output: result.output,
      tokens: result.tokens,
      latencyMs: Date.now() - start
    }
  }

  /**
   * Execute a job asynchronously with error handling and persistence.
   * @param {Object} job
   */
  async _executeJob (job) {
    try {
      job.status = 'running'
      await this._saveJob(job)

      // Audit: Log job status change
      this.audit.logJobStatus(
        this.logger,
        job.traceId || job.id,
        job.id,
        'running',
        { modelId: job.modelId }
      )

      job.result = await this._execModel(job)
      job.status = 'completed'

      // Audit: Log job completion
      this.audit.logJobStatus(
        this.logger,
        job.traceId || job.id,
        job.id,
        'completed',
        { modelId: job.modelId, tokens: job.result.tokens }
      )
    } catch (e) {
      job.error = e.message
      job.status = 'failed'
      this.logger.error({ jobId: job.id }, e)

      // Audit: Log job failure
      this.audit.logError(this.logger, job.traceId || job.id, 'executeJob', e, {
        jobId: job.id,
        modelId: job.modelId
      })
    }

    await this._saveJob(job)
  }

  // ─── Public RPC handlers ─────────────────────────────────────────────────

  /**
   * Enqueue and immediately execute an inference job.
   *
   * @param {Object} req
   * @param {string} req.modelId
   * @param {string} req.prompt
   * @param {Object} [req.params]
   * @param {string} [req.traceId] - Optional trace ID for request correlation
   * @returns {Promise<Object>} { jobId, status, result } on success
   */
  async runInference (req) {
    if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')
    if (!req.prompt) throw new Error('ERR_PROMPT_REQUIRED')

    const traceId = this.audit.getOrCreateTraceId(req)

    // Audit: Log incoming request
    this.audit.logRequest(this.logger, traceId, 'runInference', {
      modelId: req.modelId,
      promptLength: req.prompt.length,
      userId: req.userId
    })

    const job = this._createJob(req)
    job.traceId = traceId // Attach trace ID to job for correlation
    await this._saveJob(job)

    // Audit: Log job created
    this.audit.logJobStatus(this.logger, traceId, job.id, 'queued', {
      modelId: req.modelId
    })

    // Run asynchronously so the RPC caller gets an immediate jobId ack.
    // For synchronous (blocking) inference remove the setImmediate wrapper.
    setImmediate(() =>
      this._executeJob(job).catch((e) => {
        this.logger.error({ jobId: job.id }, 'unhandled executeJob error', e)
      })
    )

    // Audit: Log response
    this.audit.logResponse(this.logger, traceId, 'runInference', {
      jobId: job.id,
      status: job.status
    })

    return { jobId: job.id, status: job.status }
  }

  /**
   * Return the current state of a job.
   * @param {Object} req
   * @param {string} req.jobId
   * @returns {Promise<Object>} job object
   */
  async getJobStatus (req) {
    if (!req.jobId) throw new Error('ERR_JOB_ID_REQUIRED')

    const jobs = this._ensureJobsMem()
    const job = jobs[req.jobId] || (await this.jobs.get(req.jobId))?.value

    if (!job) throw new Error('ERR_JOB_NOT_FOUND')
    if (req.userEmail && req.userEmail !== job.userEmail) {
      throw new Error('ERR_JOB_FORBIDDEN')
    }

    return job
  }

  /**
   * Request cancellation of a running job.
   * @param {Object} req
   * @param {string} req.jobId
   * @returns {Promise<1|0>}
   */
  async cancelJob (req) {
    if (!req.jobId) throw new Error('ERR_JOB_ID_REQUIRED')

    const jobs = this._ensureJobsMem()
    const job = jobs[req.jobId] || (await this.jobs.get(req.jobId))?.value

    if (!job) return 0
    if (req.userEmail && req.userEmail !== job.userEmail) {
      throw new Error('ERR_JOB_FORBIDDEN')
    }
    if (job.status !== 'running' && job.status !== 'queued') return 0

    job.status = 'cancelled'
    await this._saveJob(job)
    return 1
  }

  /**
   * List recent jobs, optionally filtered by status.
   * @param {Object} req
   * @param {string} [req.status]  - Filter by status string
   * @param {number} [req.limit=50]
   * @returns {Promise<Object[]>}
   */
  async listJobs (req) {
    const limit = req.limit || 50
    const stream = this.jobs.createReadStream({ reverse: true, limit })
    const res = []

    for await (const data of stream) {
      const job = data.value
      const userMatches = !req.userEmail || job.userEmail === req.userEmail
      const statusMatches = !req.status || job.status === req.status

      if (userMatches && statusMatches) {
        res.push(job)
      }
    }

    return res
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

          this.jobs = await this.store_s0.getBee(
            { name: 'jobs' },
            { keyEncoding: 'utf-8', valueEncoding: 'json' }
          )
          await this.jobs.ready()

          rpcServer.respond('runInference', (req) =>
            this.net_r0.handleReply('runInference', req)
          )
          rpcServer.respond('getJobStatus', (req) =>
            this.net_r0.handleReply('getJobStatus', req)
          )
          rpcServer.respond('cancelJob', (req) =>
            this.net_r0.handleReply('cancelJob', req)
          )
          rpcServer.respond('listJobs', (req) =>
            this.net_r0.handleReply('listJobs', req)
          )

          this.status.rpcPublicKey = this.getRpcKey().toString('hex')
          this.saveStatus()

          this.logger.info({ rack: this.ctx.rack }, 'inference worker ready')
        }
      ],
      cb
    )
  }
}

module.exports = WrkInference
