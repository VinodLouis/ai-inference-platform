'use strict'

const async = require('async')
const WrkOrkBase = require('./base.ork.wrk')

/**
 * Inference Orchestrator worker.
 *
 * Extends WrkOrkBase with inference-specific routing logic:
 *
 *  - `routeInference`  – forwards a user inference request to the best
 *                        available inference worker for the requested model.
 *  - `listModels`      – aggregates the model catalogue from all model workers.
 *  - `getJobStatus`    – queries a specific inference worker for job state.
 *  - `cancelJob`       – proxies a cancel request to the owning inference worker.
 *  - `listJobs`        – proxies a list-jobs request to a specific inference worker.
 *
 * Uses round-robin load balancing over registered racks of type "inference".
 *
 * @extends WrkOrkBase
 */
class WrkOrkInference extends WrkOrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)
    this._rrIndex = 0
    this.init()
    this.start()
  }

  /**
   * Pick the next inference rack using round-robin.
   * @param {string} modelId - Model identifier requested by the client
   * @returns {Promise<Object>} Rack entry from registry
   * @throws {Error} ERR_NO_INFERENCE_WORKERS if no racks are available
   */
  _isDedicatedRack (rack) {
    return rack?.info?.dedicated === true || rack?.info?.tier === 'premium'
  }

  _pickByRoundRobin (racks) {
    if (!racks.length) return []

    const start = this._rrIndex % racks.length
    this._rrIndex++

    const ordered = []
    for (let i = 0; i < racks.length; i++) {
      ordered.push(racks[(start + i) % racks.length])
    }

    return ordered
  }

  async _rememberJobOwnership ({ jobId, rackId, modelId }) {
    if (!jobId || !rackId || !this.jobOwnership) return

    await this.jobOwnership.put(jobId, {
      jobId,
      rackId,
      modelId,
      createdAt: Date.now()
    })
  }

  async _resolveRackForJob (req) {
    if (req.rackId) {
      return req.rackId
    }

    if (!this.jobOwnership) {
      return null
    }

    const row = await this.jobOwnership.get(req.jobId)
    return row?.value?.rackId || null
  }

  async _pickRack (modelId, routing = {}) {
    const racks = await this.listRacks({ type: 'inference', keys: true })

    if (!racks.length) throw new Error('ERR_NO_INFERENCE_WORKERS')

    const tier = routing.tier || 'standard'
    const allowSharedFallback = routing.allowSharedFallback !== false

    const dedicated = racks.filter((rack) => this._isDedicatedRack(rack))
    const shared = racks.filter((rack) => !this._isDedicatedRack(rack))

    // Debug: Log rack selection details
    this.logger.info(
      {
        tier,
        allowSharedFallback,
        totalRacks: racks.length,
        dedicatedRacks: dedicated.map((r) => r.id),
        sharedRacks: shared.map((r) => r.id)
      },
      'Rack selection filtering'
    )

    let candidates = []
    if (tier === 'premium') {
      candidates = allowSharedFallback
        ? dedicated.concat(shared)
        : dedicated.slice()
    } else {
      candidates = shared.length ? shared : racks
    }

    if (!candidates.length) {
      throw new Error('ERR_NO_RACKS_FOR_TIER')
    }

    const ordered = this._pickByRoundRobin(candidates)

    // Debug: Log selected rack order
    this.logger.info(
      {
        tier,
        candidates: ordered.map((r) => ({
          id: r.id,
          dedicated: this._isDedicatedRack(r)
        }))
      },
      'Rack selection result'
    )

    return ordered
  }

  async _markRackFailureSafe (rack, error) {
    try {
      await this.markRackFailure({
        id: rack.id,
        error: error?.message,
        threshold: 3
      })
    } catch (e) {
      this.debugError(`markRackFailure rack=${rack.id}`, e)
    }
  }

  /**
   * Route an inference request to an available inference worker.
   *
   * @param {Object} req
   * @param {string} req.modelId   - The model to use (e.g. "llama3-8b")
   * @param {string} req.prompt    - Input prompt / payload
   * @param {Object} [req.params]  - Optional model parameters (temp, max_tokens…)
   * @returns {Promise<Object>} Job acknowledgment: { jobId, rackId, status }
   */
  async routeInference (req) {
    const traceId = this.audit.generateTraceId()

    // Audit: Request received
    this.audit.logRequest(this.logger, traceId, 'routeInference', {
      modelId: req.modelId,
      hasPrompt: !!req.prompt,
      hasInputs: !!req.inputs
    })

    try {
      if (!req.modelId) throw new Error('ERR_MODEL_ID_REQUIRED')
      if (!req.prompt && !req.inputs) throw new Error('ERR_INPUT_REQUIRED')

      const racks = await this._pickRack(req.modelId, req.routing || {})
      let lastError = null

      for (const rack of racks) {
        try {
          // Audit: RPC call to inference worker
          this.audit.logRpcCall(this.logger, traceId, rack.id, 'runInference', {
            modelId: req.modelId
          })

          const result = await this.net_r0.jRequest(
            rack.info.rpcPublicKey,
            'runInference',
            req,
            { timeout: 60000 }
          )

          await this.heartbeatRack({ id: rack.id })

          // Audit: Successful routing and response
          this.audit.logRpcResponse(
            this.logger,
            traceId,
            rack.id,
            'runInference',
            {
              jobId: result.jobId,
              status: result.status
            }
          )

          this.audit.logResponse(this.logger, traceId, 'routeInference', {
            jobId: result.jobId,
            rackId: rack.id,
            modelId: req.modelId
          })

          await this._rememberJobOwnership({
            jobId: result.jobId,
            rackId: rack.id,
            modelId: req.modelId
          })

          return { ...result, rackId: rack.id }
        } catch (err) {
          lastError = err
          await this._markRackFailureSafe(rack, err)
        }
      }

      if (lastError) throw lastError
      throw new Error('ERR_INFERENCE_RACKS_UNAVAILABLE')
    } catch (err) {
      // Audit: Routing failed
      this.audit.logError(this.logger, traceId, 'routeInference', err, {
        modelId: req.modelId
      })
      throw err
    }
  }

  /**
   * Aggregate the model catalogue from all registered model workers.
   * @returns {Promise<Object[]>} Flat list of available models
   */
  async listModels () {
    const traceId = this.audit.generateTraceId()

    // Audit: Request received
    this.audit.logRequest(this.logger, traceId, 'listModels', {})

    try {
      const racks = await this.listRacks({ type: 'model', keys: true })

      this.audit.logResponse(this.logger, traceId, 'listModels', {
        rackCount: racks.length
      })

      const results = await async.mapLimit(racks, 5, async (rack) => {
        try {
          // Audit: RPC call to model worker
          this.audit.logRpcCall(
            this.logger,
            traceId,
            rack.id,
            'listModels',
            {}
          )

          const models = await this.net_r0.jRequest(
            rack.info.rpcPublicKey,
            'listModels',
            {},
            { timeout: 10000 }
          )

          // Audit: Successful response from model worker
          this.audit.logRpcResponse(
            this.logger,
            traceId,
            rack.id,
            'listModels',
            {
              modelCount: models.length
            }
          )

          return models
        } catch (e) {
          this.debugError(`listModels rack=${rack.id}`, e, true)
          // Audit: Failed to get models from this rack
          this.audit.logError(
            this.logger,
            traceId,
            `listModels[${rack.id}]`,
            e,
            {
              rackId: rack.id
            }
          )
          return []
        }
      })

      return results.flat()
    } catch (err) {
      // Audit: Overall listModels failed
      this.audit.logError(this.logger, traceId, 'listModels', err, {})
      throw err
    }
  }

  /**
   * Query the status of a specific inference job.
   * @param {Object} req
   * @param {string} req.jobId  - Job identifier returned by routeInference
   * @param {string} req.rackId - Rack that owns the job
   * @returns {Promise<Object>} Job status object
   */
  async getJobStatus (req) {
    const traceId = this.audit.generateTraceId()

    // Audit: Request received
    this.audit.logRequest(this.logger, traceId, 'getJobStatus', {
      jobId: req.jobId,
      rackId: req.rackId
    })

    try {
      if (!req.jobId) throw new Error('ERR_JOB_ID_REQUIRED')

      const resolvedRackId = await this._resolveRackForJob(req)
      if (!resolvedRackId) throw new Error('ERR_RACK_ID_REQUIRED')

      const racks = await this.listRacks({
        type: 'inference',
        keys: true,
        liveOnly: false
      })
      const rack = racks.find((r) => r.id === resolvedRackId)

      if (!rack) throw new Error('ERR_RACK_NOT_FOUND')

      // Audit: RPC call to inference worker for status
      this.audit.logRpcCall(this.logger, traceId, rack.id, 'getJobStatus', {
        jobId: req.jobId
      })

      const status = await this.net_r0.jRequest(
        rack.info.rpcPublicKey,
        'getJobStatus',
        { jobId: req.jobId, userEmail: req.userEmail },
        { timeout: 10000 }
      )

      // Audit: Successful status retrieval
      this.audit.logRpcResponse(this.logger, traceId, rack.id, 'getJobStatus', {
        jobStatus: status.status
      })

      this.audit.logResponse(this.logger, traceId, 'getJobStatus', {
        jobId: req.jobId,
        rackId: resolvedRackId,
        status: status.status
      })

      return {
        ...status,
        rackId: resolvedRackId
      }
    } catch (err) {
      // Audit: Status query failed
      this.audit.logError(this.logger, traceId, 'getJobStatus', err, {
        jobId: req.jobId,
        rackId: req.rackId
      })
      throw err
    }
  }

  /**
   * Cancel a job on a specific inference worker.
   * @param {Object} req
   * @param {string} req.jobId  - Job identifier
   * @param {string} req.rackId - Rack that owns the job
   * @returns {Promise<Object>} { cancelled: 1|0 }
   */
  async cancelJob (req) {
    const traceId = this.audit.generateTraceId()

    this.audit.logRequest(this.logger, traceId, 'cancelJob', {
      jobId: req.jobId,
      rackId: req.rackId
    })

    try {
      if (!req.jobId) throw new Error('ERR_JOB_ID_REQUIRED')

      const resolvedRackId = await this._resolveRackForJob(req)
      if (!resolvedRackId) throw new Error('ERR_RACK_ID_REQUIRED')

      const racks = await this.listRacks({
        type: 'inference',
        keys: true,
        liveOnly: false
      })
      const rack = racks.find((r) => r.id === resolvedRackId)

      if (!rack) throw new Error('ERR_RACK_NOT_FOUND')

      this.audit.logRpcCall(this.logger, traceId, rack.id, 'cancelJob', {
        jobId: req.jobId
      })

      const result = await this.net_r0.jRequest(
        rack.info.rpcPublicKey,
        'cancelJob',
        { jobId: req.jobId, userEmail: req.userEmail },
        { timeout: 10000 }
      )

      this.audit.logRpcResponse(this.logger, traceId, rack.id, 'cancelJob', {
        cancelled: result
      })

      this.audit.logResponse(this.logger, traceId, 'cancelJob', {
        jobId: req.jobId,
        rackId: resolvedRackId,
        cancelled: result
      })

      return { cancelled: result, rackId: resolvedRackId }
    } catch (err) {
      this.audit.logError(this.logger, traceId, 'cancelJob', err, {
        jobId: req.jobId,
        rackId: req.rackId
      })
      throw err
    }
  }

  /**
   * List jobs from a specific inference worker.
   * @param {Object} req
   * @param {string} req.rackId        - Rack to query
   * @param {string} [req.status]      - Optional status filter
   * @param {number} [req.limit=50]    - Max results
   * @returns {Promise<Object[]>} Array of job records
   */
  async listJobs (req) {
    const traceId = this.audit.generateTraceId()

    this.audit.logRequest(this.logger, traceId, 'listJobs', {
      rackId: req.rackId,
      status: req.status,
      limit: req.limit
    })

    try {
      if (!req.rackId) throw new Error('ERR_RACK_ID_REQUIRED')

      const racks = await this.listRacks({
        type: 'inference',
        keys: true,
        liveOnly: false
      })
      const rack = racks.find((r) => r.id === req.rackId)

      if (!rack) throw new Error('ERR_RACK_NOT_FOUND')

      this.audit.logRpcCall(this.logger, traceId, rack.id, 'listJobs', {
        status: req.status,
        limit: req.limit
      })

      const jobs = await this.net_r0.jRequest(
        rack.info.rpcPublicKey,
        'listJobs',
        { status: req.status, limit: req.limit, userEmail: req.userEmail },
        { timeout: 10000 }
      )

      this.audit.logRpcResponse(this.logger, traceId, rack.id, 'listJobs', {
        count: jobs.length
      })

      this.audit.logResponse(this.logger, traceId, 'listJobs', {
        rackId: req.rackId,
        count: jobs.length
      })

      return jobs
    } catch (err) {
      this.audit.logError(this.logger, traceId, 'listJobs', err, {
        rackId: req.rackId
      })
      throw err
    }
  }

  _start (cb) {
    async.series(
      [
        (next) => {
          super._start(next)
        },
        async () => {
          const rpcServer = this.net_r0.rpcServer

          this.jobOwnership = await this.store_s0.getBee(
            { name: 'job-ownership' },
            { keyEncoding: 'utf-8', valueEncoding: 'json' }
          )
          await this.jobOwnership.ready()

          rpcServer.respond('routeInference', (req) =>
            this.net_r0.handleReply('routeInference', req)
          )
          rpcServer.respond('listModels', (req) =>
            this.net_r0.handleReply('listModels', req)
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

          this.logger.info(
            { cluster: this.ctx.cluster },
            'inference orchestrator ready'
          )
        }
      ],
      cb
    )
  }
}

module.exports = WrkOrkInference
