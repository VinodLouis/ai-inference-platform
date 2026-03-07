'use strict'

const auth = require('./auth')

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
function pickOrkKey (ctx) {
  const orks = Object.values(ctx.conf.orks || {})
  if (!orks.length) throw new Error('ERR_NO_ORCHESTRATOR_CONFIGURED')
  return orks[0].rpcPublicKey
}

/**
 * POST /inference
 * Submit a new inference request.
 * Body: { modelId, prompt?, inputs?, params? }
 */
async function postInference (ctx, req) {
  const orkKey = pickOrkKey(ctx)
  return ctx.net_r0.jRequest(orkKey, 'routeInference', req.body, {
    timeout: 120000
  })
}

/**
 * GET /inference/:jobId
 * Poll the status of an existing job.
 * Query params: rackId (required)
 */
async function getInferenceStatus (ctx, req) {
  const orkKey = pickOrkKey(ctx)
  return ctx.net_r0.jRequest(
    orkKey,
    'getJobStatus',
    { jobId: req.params.jobId, rackId: req.query.rackId },
    { timeout: 15000 }
  )
}

/**
 * GET /models
 * Return the full model catalogue aggregated from all model workers.
 */
async function getModels (ctx) {
  const orkKey = pickOrkKey(ctx)
  return ctx.net_r0.jRequest(orkKey, 'listModels', {}, { timeout: 15000 })
}

/**
 * GET /racks
 * List registered service racks (type filtered via query param).
 */
async function getRacks (ctx, req) {
  const orkKey = pickOrkKey(ctx)
  return ctx.net_r0.jRequest(
    orkKey,
    'listRacks',
    { type: req.query.type },
    { timeout: 10000 }
  )
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
          send200(rep, auth.signUpRoute(ctx, req))
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
          send200(rep, auth.loginRoute(ctx, req))
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
    }
  ]

  return auth.withProtectedRoutes(ctx, routeList)
}

module.exports = { routes }
