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
      if (!req.rackId) throw new Error('ERR_RACK_ID_REQUIRED')

      const racks = await this.listRacks({
        type: 'inference',
        keys: true,
        liveOnly: false
      })
      const rack = racks.find((r) => r.id === req.rackId)

      if (!rack) throw new Error('ERR_RACK_NOT_FOUND')

      // Audit: RPC call to inference worker for status
      this.audit.logRpcCall(this.logger, traceId, rack.id, 'getJobStatus', {
        jobId: req.jobId
      })

      const status = await this.net_r0.jRequest(
        rack.info.rpcPublicKey,
        'getJobStatus',
        { jobId: req.jobId },
        { timeout: 10000 }
      )

      // Audit: Successful status retrieval
      this.audit.logRpcResponse(this.logger, traceId, rack.id, 'getJobStatus', {
        jobStatus: status.status
      })

      this.audit.logResponse(this.logger, traceId, 'getJobStatus', {
        jobId: req.jobId,
        rackId: req.rackId,
        status: status.status
      })

      return status
    } catch (err) {
      // Audit: Status query failed
      this.audit.logError(this.logger, traceId, 'getJobStatus', err, {
        jobId: req.jobId,
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

          rpcServer.respond('routeInference', (req) =>
            this.net_r0.handleReply('routeInference', req)
          )
          rpcServer.respond('listModels', (req) =>
            this.net_r0.handleReply('listModels', req)
          )
          rpcServer.respond('getJobStatus', (req) =>
            this.net_r0.handleReply('getJobStatus', req)
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
