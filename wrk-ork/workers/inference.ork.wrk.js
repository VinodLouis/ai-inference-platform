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
  async _pickRack (modelId) {
    const racks = await this.listRacks({ type: 'inference', keys: true })

    if (!racks.length) throw new Error('ERR_NO_INFERENCE_WORKERS')

    const rack = racks[this._rrIndex % racks.length]
    this._rrIndex++
    return rack
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

      const rack = await this._pickRack(req.modelId)

      // Audit: RPC call to inference worker
      this.audit.logRpcCall(this.logger, traceId, rack.id, 'runInference', {
        modelId: req.modelId
      })

      const result = await this.net_r0.jRequest(
        rack.info.rpcPublicKey,
        'runInference',
        req,
        { timeout: 120000 }
      )

      // Audit: Successful routing and response
      this.audit.logRpcResponse(this.logger, traceId, rack.id, 'runInference', {
        jobId: result.jobId,
        status: result.status
      })

      this.audit.logResponse(this.logger, traceId, 'routeInference', {
        jobId: result.jobId,
        rackId: rack.id,
        modelId: req.modelId
      })

      return { ...result, rackId: rack.id }
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

      const racks = await this.listRacks({ type: 'inference', keys: true })
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
