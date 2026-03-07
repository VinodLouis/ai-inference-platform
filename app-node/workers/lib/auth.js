'use strict'

const crypto = require('crypto')

const signupBody = {
  type: 'object',
  required: ['email', 'password', 'signup_secret', 'roles'],
  properties: {
    email: {
      type: 'string',
      format: 'email'
    },
    password: {
      type: 'string',
      minLength: 6
    },
    signup_secret: {
      type: 'string'
    },
    roles: {
      type: 'array',
      items: {
        type: 'string'
      },
      minItems: 1
    }
  }
}

const loginBody = {
  type: 'object',
  required: ['email', 'password']
}

const userSchema = {
  signup: {
    body: signupBody
  },
  login: {
    body: loginBody
  }
}

class AuthError extends Error {
  constructor (message, statusCode) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

const authHandlers = {
  passwordAuth: (ctx, req) => {
    if (req?.body?.email && req?.body?.password) {
      return { email: req.body.email, password: req.body.password }
    }
  },

  internalToken: (ctx, req) => {
    if (req.email) {
      return { email: req.email }
    }
  }
}

function getAuthConfig (ctx) {
  const authConf = ctx.conf.auth || {}
  return {
    signupSecret:
      authConf.signupSecret || process.env.APP_SIGNUP_SECRET || null,
    tokenSecret: authConf.tokenSecret || process.env.APP_TOKEN_SECRET || null,
    tokenTtlSeconds: authConf.tokenTtlSeconds || 24 * 60 * 60,
    protectedRoutes: authConf.protectedRoutes !== false
  }
}

async function initAuthStore (ctx) {
  if (!ctx._usersDb) {
    ctx._usersDb = await ctx.store_s0.getBee(
      { name: 'users' },
      { keyEncoding: 'utf-8', valueEncoding: 'json' }
    )
    await ctx._usersDb.ready()
  }
  return ctx._usersDb
}

function getUsersStore (ctx) {
  if (!ctx._usersDb) {
    throw new Error('ERR_AUTH_STORE_NOT_INITIALIZED')
  }
  return ctx._usersDb
}

function toB64Url (value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function fromB64Url (value) {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')

  return Buffer.from(normalized, 'base64').toString('utf8')
}

function hashPassword (password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto
    .pbkdf2Sync(password, salt, 120000, 32, 'sha256')
    .toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword (password, encoded) {
  if (!encoded || !encoded.includes(':')) return false

  const [salt, hash] = encoded.split(':')
  const expected = crypto
    .pbkdf2Sync(password, salt, 120000, 32, 'sha256')
    .toString('hex')

  const hashBuffer = Buffer.from(hash, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')

  if (hashBuffer.length !== expectedBuffer.length) return false

  return crypto.timingSafeEqual(hashBuffer, expectedBuffer)
}

function signToken (payload, secret, tokenTtlSeconds) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const headerEncoded = toB64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payloadEncoded = toB64Url(
    JSON.stringify({
      ...payload,
      iat: nowSeconds,
      exp: nowSeconds + tokenTtlSeconds
    })
  )
  const data = `${headerEncoded}.${payloadEncoded}`
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return `${data}.${signature}`
}

function verifyToken (token, secret) {
  const tokenParts = token.split('.')
  if (tokenParts.length !== 3) throw new AuthError('ERR_INVALID_TOKEN', 401)

  const [headerEncoded, payloadEncoded, signature] = tokenParts
  const data = `${headerEncoded}.${payloadEncoded}`
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  const expectedBuffer = Buffer.from(expectedSignature)
  const signatureBuffer = Buffer.from(signature)

  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    throw new AuthError('ERR_INVALID_TOKEN', 401)
  }

  let payload

  try {
    payload = JSON.parse(fromB64Url(payloadEncoded))
  } catch {
    throw new AuthError('ERR_INVALID_TOKEN', 401)
  }

  const nowSeconds = Math.floor(Date.now() / 1000)

  if (!payload.exp || payload.exp <= nowSeconds) {
    throw new AuthError('ERR_TOKEN_EXPIRED', 401)
  }

  return payload
}

function parseBearerToken (req) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (!authHeader || typeof authHeader !== 'string') {
    throw new AuthError('ERR_AUTH_HEADER_MISSING', 401)
  }

  const [scheme, token] = authHeader.split(' ')
  if (scheme !== 'Bearer' || !token) {
    throw new AuthError('ERR_AUTH_HEADER_INVALID', 401)
  }

  return token
}

async function signUpRoute (ctx, req) {
  const conf = getAuthConfig(ctx)

  if (!conf.signupSecret) {
    throw new AuthError('ERR_SIGNUP_SECRET_NOT_CONFIGURED', 500)
  }

  if (req.body.signup_secret !== conf.signupSecret) {
    throw new AuthError('ERR_SIGNUP_SECRET_INVALID', 403)
  }

  const usersStore = getUsersStore(ctx)
  const email = String(req.body.email).toLowerCase()

  const existing = await usersStore.get(email)
  if (existing) {
    throw new AuthError('ERR_USER_EXISTS', 409)
  }

  const user = {
    email,
    passwordHash: hashPassword(req.body.password),
    roles: req.body.roles,
    createdAt: Date.now()
  }

  await usersStore.put(email, user)

  return {
    email,
    roles: req.body.roles
  }
}

async function loginRoute (ctx, req) {
  const conf = getAuthConfig(ctx)

  if (!conf.tokenSecret) {
    throw new AuthError('ERR_TOKEN_SECRET_NOT_CONFIGURED', 500)
  }

  const authData = authHandlers.passwordAuth(ctx, req)

  if (!authData) {
    throw new AuthError('ERR_INVALID_CREDENTIALS', 401)
  }

  const usersStore = getUsersStore(ctx)
  const email = String(authData.email).toLowerCase()
  const userEntry = await usersStore.get(email)
  const user = userEntry?.value

  if (!user || !verifyPassword(authData.password, user.passwordHash)) {
    throw new AuthError('ERR_INVALID_CREDENTIALS', 401)
  }

  const token = signToken(
    { email: user.email, roles: user.roles },
    conf.tokenSecret,
    conf.tokenTtlSeconds
  )

  return {
    token,
    token_type: 'Bearer',
    expires_in: conf.tokenTtlSeconds,
    user: {
      email: user.email,
      roles: user.roles
    }
  }
}

function requireAuth (ctx, req, rep, done) {
  try {
    const conf = getAuthConfig(ctx)

    if (!conf.protectedRoutes) {
      done()
      return
    }

    if (!conf.tokenSecret) {
      throw new AuthError('ERR_TOKEN_SECRET_NOT_CONFIGURED', 500)
    }

    const token = parseBearerToken(req)
    const payload = verifyToken(token, conf.tokenSecret)

    req.email = payload.email
    req.user = {
      email: payload.email,
      roles: payload.roles || []
    }

    done()
  } catch (err) {
    rep
      .status(err.statusCode || 401)
      .send({ error: err.message || 'ERR_UNAUTHORIZED' })
  }
}

function composePreHandler (existing, authPreHandler) {
  if (!existing) return authPreHandler
  if (Array.isArray(existing)) return [authPreHandler, ...existing]
  return [authPreHandler, existing]
}

function withProtectedRoutes (ctx, routes) {
  const publicPaths = new Set(['/auth/signup', '/auth/login'])

  return routes.map((route) => {
    if (publicPaths.has(route.url)) {
      return route
    }

    return {
      ...route,
      preHandler: composePreHandler(route.preHandler, (req, rep, done) =>
        requireAuth(ctx, req, rep, done)
      )
    }
  })
}

module.exports = {
  authHandlers,
  initAuthStore,
  loginRoute,
  requireAuth,
  signUpRoute,
  userSchema,
  withProtectedRoutes
}
