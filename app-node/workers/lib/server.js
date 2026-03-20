'use strict'

const auth = require('./auth')

const MAX_INFLIGHT_INFERENCE = Number(
  process.env.APP_MAX_INFLIGHT_INFERENCE || 5
)
const MAX_INFERENCE_MAX_TOKENS = Number(
  process.env.APP_MAX_INFERENCE_MAX_TOKENS || 128
)
const DEFAULT_INFERENCE_MAX_TOKENS = Number(
  process.env.APP_DEFAULT_INFERENCE_MAX_TOKENS || 64
)
let inflightInference = 0

function toPositiveInt (value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  return i > 0 ? i : fallback
}

function normalizeInferenceParams (params = {}) {
  const maxCap = toPositiveInt(MAX_INFERENCE_MAX_TOKENS, 128)
  const defaultMax = toPositiveInt(DEFAULT_INFERENCE_MAX_TOKENS, 64)

  const requestedMax = params.max_tokens ?? params.maxTokens
  const normalizedMax =
    requestedMax == null ? defaultMax : toPositiveInt(requestedMax, defaultMax)

  return {
    ...params,
    max_tokens: Math.min(normalizedMax, maxCap)
  }
}

function inferenceConcurrencyPreHandler (ctx, req, rep, done) {
  if (inflightInference >= MAX_INFLIGHT_INFERENCE) {
    const traceId = ctx.audit.generateTraceId()
    ctx.audit.logError(
      ctx.logger,
      traceId,
      'POST /inference',
      new Error('ERR_TOO_MANY_INFERENCE_REQUESTS'),
      {
        event: 'inference_backpressure_reject',
        method: req.method,
        url: req.url,
        ip: req.ip,
        userId: req.user?.id,
        inflightInference,
        maxInFlight: MAX_INFLIGHT_INFERENCE
      }
    )

    rep.status(429).header('Retry-After', '1').send({
      error: 'ERR_TOO_MANY_INFERENCE_REQUESTS',
      maxInFlight: MAX_INFLIGHT_INFERENCE
    })
    return
  }

  inflightInference++
  req._inferenceSlotAcquired = true
  done()
}

function releaseInferenceSlot (req) {
  if (!req._inferenceSlotAcquired) return
  req._inferenceSlotAcquired = false
  inflightInference = Math.max(0, inflightInference - 1)
}

/**
 * Shared 200 response helper.
 * @param {Object} rep   - Fastify reply
 * @param {*}      data
 */
function send200 (rep, data) {
  rep.status(200).send(data)
}

/**
 * Resolve the RPC public key for the orchestrator cluster.
 * Supports multiple clusters in config.orks for redundancy.
 * @param {Object} ctx - Worker context
 * @returns {string} RPC public key
 */
function pickOrkKeys (ctx) {
  const orks = Object.values(ctx.conf.orks || {})
  if (!orks.length) throw new Error('ERR_NO_ORCHESTRATOR_CONFIGURED')

  const keys = orks.map((ork) => ork.rpcPublicKey).filter(Boolean)
  if (!keys.length) throw new Error('ERR_NO_ORCHESTRATOR_CONFIGURED')

  return keys
}

/**
 * Send an RPC request to available orchestrator keys with failover.
 * Tries each configured ork key once, starting from a rotating cursor.
 * @param {Object} ctx - Worker context with network client and logger.
 * @param {string} method - RPC method name to invoke on ork.
 * @param {Object} payload - RPC request payload.
 * @param {Object} [options] - RPC request options (for example timeout).
 * @returns {Promise<Object>} RPC response payload from the first successful ork.
 */
async function requestOrchestrator (ctx, method, payload, options) {
  const orkKeys = pickOrkKeys(ctx)
  const start = ctx._orkCursor || 0

  ctx._orkCursor = (start + 1) % orkKeys.length

  let lastErr = null

  for (let i = 0; i < orkKeys.length; i++) {
    const key = orkKeys[(start + i) % orkKeys.length]

    try {
      return await ctx.net_r0.jRequest(key, method, payload, options)
    } catch (err) {
      lastErr = err
      ctx.logger.warn(
        {
          method,
          ork: key.substring(0, 16),
          error: err.message
        },
        'orchestrator request failed, trying next'
      )
    }
  }

  throw lastErr || new Error('ERR_ORCHESTRATOR_UNAVAILABLE')
}

/**
 * POST /inference
 * Submit a new inference request.
 * Body: { modelId, prompt?, inputs?, params? }
 */
async function postInference (ctx, req) {
  const traceId = ctx.audit.generateTraceId()

  // Audit: Log HTTP request
  ctx.audit.logRequest(ctx.logger, traceId, 'POST /inference', {
    modelId: req.body.modelId,
    userId: req.user?.id,
    ip: req.ip
  })

  const timer = ctx.audit.createTimer()
  const orkKeys = pickOrkKeys(ctx)
  const primaryOrk = orkKeys[0]
  const roles = req.user?.roles || []
  const isPremium = roles.includes('premium') || roles.includes('enterprise')

  // Debug: Log tier routing decision
  ctx.logger.info(
    {
      traceId,
      userId: req.user?.id,
      roles,
      isPremium,
      tier: isPremium ? 'premium' : 'standard'
    },
    'Routing tier decision'
  )

  // Attach traceId to propagate through the system
  const requestBody = {
    ...req.body,
    params: normalizeInferenceParams(req.body?.params),
    traceId,
    userEmail: req.user?.email,
    userRoles: req.user?.roles || [],
    routing: {
      tier: isPremium ? 'premium' : 'standard',
      allowSharedFallback: true
    }
  }

  // Audit: Log RPC call to orchestrator
  ctx.audit.logRpcCall(
    ctx.logger,
    traceId,
    primaryOrk.substring(0, 16),
    'routeInference',
    {
      modelId: req.body.modelId
    }
  )

  try {
    const result = await requestOrchestrator(
      ctx,
      'routeInference',
      requestBody,
      {
        timeout: 60000
      }
    )

    // Audit: Log response
    ctx.audit.logResponse(ctx.logger, traceId, 'POST /inference', {
      durationMs: timer(),
      jobId: result.jobId,
      status: result.status
    })

    return result
  } finally {
    releaseInferenceSlot(req)
  }
}

/**
 * GET /inference/:jobId
 * Poll the status of an existing job.
 * Query params: rackId (optional)
 */
async function getInferenceStatus (ctx, req) {
  const traceId = ctx.audit.generateTraceId()

  const rackId = req.query?.rackId

  // Audit: Log HTTP request
  ctx.audit.logRequest(ctx.logger, traceId, 'GET /inference/:jobId', {
    jobId: req.params.jobId,
    rackId,
    userId: req.user?.id,
    ip: req.ip
  })

  const result = await requestOrchestrator(
    ctx,
    'getJobStatus',
    { jobId: req.params.jobId, rackId, userEmail: req.user?.email },
    { timeout: 15000 }
  )

  // Audit: Log response
  ctx.audit.logResponse(ctx.logger, traceId, 'GET /inference/:jobId', {
    status: result.status
  })

  return result
}

/**
 * GET /models
 * Return the full model catalogue aggregated from all model workers.
 */
async function getModels (ctx) {
  return requestOrchestrator(ctx, 'listModels', {}, { timeout: 15000 })
}

/**
 * POST /models
 * Register a new model into the system at runtime.
 */
async function postRegisterModel (ctx, req) {
  const roles = req.user?.roles || []
  if (!roles.includes('admin')) {
    const err = new Error('ERR_ADMIN_REQUIRED')
    err.statusCode = 403
    throw err
  }

  const result = await requestOrchestrator(ctx, 'registerModel', req.body, {
    timeout: 15000
  })

  return result
}

/**
 * DELETE /models/:modelId
 * Deregister a runtime model across model workers.
 */
async function deleteRegisterModel (ctx, req) {
  const modelId = req.params.modelId
  if (!modelId) {
    const err = new Error('ERR_MODEL_ID_REQUIRED')
    err.statusCode = 400
    throw err
  }

  const roles = req.user?.roles || []
  if (!roles.includes('admin')) {
    const err = new Error('ERR_ADMIN_REQUIRED')
    err.statusCode = 403
    throw err
  }

  return requestOrchestrator(
    ctx,
    'deregisterModel',
    { modelId },
    { timeout: 15000 }
  )
}

/**
 * GET /racks
 * List registered service racks (type filtered via query param).
 */
async function getRacks (ctx, req) {
  return requestOrchestrator(
    ctx,
    'listRacks',
    { type: req.query.type },
    { timeout: 10000 }
  )
}

/**
 * DELETE /inference/:jobId
 * Cancel a queued or running job.
 * Query params: rackId (optional)
 */
async function cancelJob (ctx, req) {
  const rackId = req.query?.rackId

  const traceId = ctx.audit.generateTraceId()

  ctx.audit.logRequest(ctx.logger, traceId, 'DELETE /inference/:jobId', {
    jobId: req.params.jobId,
    rackId,
    userId: req.user?.id,
    ip: req.ip
  })

  const result = await requestOrchestrator(
    ctx,
    'cancelJob',
    { jobId: req.params.jobId, rackId, userEmail: req.user?.email },
    { timeout: 15000 }
  )

  ctx.audit.logResponse(ctx.logger, traceId, 'DELETE /inference/:jobId', {
    cancelled: result.cancelled
  })

  return result
}

/**
 * GET /inference
 * List jobs from a specific inference rack.
 * Query params: rackId (required), status (optional), limit (optional, default 50)
 */
async function listJobs (ctx, req) {
  if (!req.query.rackId) {
    const err = new Error('ERR_RACK_ID_REQUIRED')
    err.statusCode = 400
    throw err
  }

  const traceId = ctx.audit.generateTraceId()

  ctx.audit.logRequest(ctx.logger, traceId, 'GET /inference', {
    rackId: req.query.rackId,
    status: req.query.status,
    limit: req.query.limit,
    userId: req.user?.id,
    ip: req.ip
  })

  const result = await requestOrchestrator(
    ctx,
    'listJobs',
    {
      rackId: req.query.rackId,
      status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      userEmail: req.user?.email
    },
    { timeout: 15000 }
  )

  ctx.audit.logResponse(ctx.logger, traceId, 'GET /inference', {
    count: result.length
  })

  return result
}

/**
 * Build the Fastify route array for the HTTP gateway.
 * @param {Object} ctx - Worker context (this inside WrkNodeHttp)
 * @returns {Object[]}
 */
function routes (ctx) {
  const routeList = [
    {
      method: 'POST',
      url: '/auth/signup',
      schema: auth.userSchema.signup,
      handler: async (req, rep) => {
        try {
          const result = await auth.signUpRoute(ctx, req)
          send200(rep, result)
        } catch (err) {
          rep
            .status(err.statusCode || 500)
            .send({ error: err.message || 'ERR_SIGNUP_FAILED' })
        }
      }
    },
    {
      method: 'POST',
      url: '/auth/login',
      schema: auth.userSchema.login,
      handler: async (req, rep) => {
        try {
          const result = await auth.loginRoute(ctx, req)
          send200(rep, result)
        } catch (err) {
          rep
            .status(err.statusCode || 500)
            .send({ error: err.message || 'ERR_LOGIN_FAILED' })
        }
      }
    },
    {
      method: 'POST',
      url: '/inference',
      preHandler: (req, rep, done) =>
        inferenceConcurrencyPreHandler(ctx, req, rep, done),
      schema: {
        body: {
          type: 'object',
          required: ['modelId'],
          anyOf: [{ required: ['prompt'] }, { required: ['inputs'] }],
          properties: {
            modelId: { type: 'string' },
            prompt: { type: 'string' },
            inputs: { type: 'object' },
            params: { type: 'object' }
          }
        }
      },
      handler: async (req, rep) => {
        send200(rep, await postInference(ctx, req))
      }
    },
    {
      method: 'GET',
      url: '/inference/:jobId',
      handler: async (req, rep) => {
        send200(rep, await getInferenceStatus(ctx, req))
      }
    },
    {
      method: 'DELETE',
      url: '/inference/:jobId',
      handler: async (req, rep) => {
        send200(rep, await cancelJob(ctx, req))
      }
    },
    {
      method: 'GET',
      url: '/inference',
      handler: async (req, rep) => {
        send200(rep, await listJobs(ctx, req))
      }
    },
    {
      method: 'GET',
      url: '/models',
      handler: async (req, rep) => {
        send200(rep, await getModels(ctx))
      }
    },
    {
      method: 'GET',
      url: '/racks',
      handler: async (req, rep) => {
        send200(rep, await getRacks(ctx, req))
      }
    },
    {
      method: 'DELETE',
      url: '/models/:modelId',
      handler: async (req, rep) => {
        send200(rep, await deleteRegisterModel(ctx, req))
      }
    },
    {
      method: 'POST',
      url: '/models',
      handler: async (req, rep) => {
        send200(rep, await postRegisterModel(ctx, req))
      }
    }
  ]

  return auth.withProtectedRoutes(ctx, routeList)
}

module.exports = { routes }
