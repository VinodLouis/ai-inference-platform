'use strict'

const async = require('async')
const WrkBase = require('wrk-base/workers/base.wrk')
const libServer = require('./lib/server')
const auth = require('./lib/auth')

/**
 * HTTP Gateway Worker.
 *
 * The external-facing entry point for client applications.
 * Bridges HTTP/REST requests to the internal Hyperswarm RPC network.
 * All business logic lives in the orchestrator and downstream workers;
 * this service only translates protocols and enforces HTTP-level concerns
 * (authentication, rate limiting, schema validation).
 *
 * @extends WrkBase
 */
class WrkNodeHttp extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)

    if (!ctx.port) throw new Error('ERR_HTTP_PORT_INVALID')

    this.prefix = `wrk-node-http-${ctx.port}`

    this.init()
    this.start()
  }

  init () {
    super.init()

    this.setInitFacs([
      ['fac', 'bfx-facs-lru', '15m', '15m', { max: 5000, maxAge: 60000 * 15 }],
      [
        'fac',
        'svc-facs-httpd',
        'h0',
        'h0',
        {
          port: this.ctx.port,
          host: '0.0.0.0',
          logger: true,
          addDefaultRoutes: true,
          trustProxy: true
        },
        1
      ]
    ])
  }

  _start (cb) {
    async.series(
      [
        (next) => {
          super._start(next)
        },
        async () => {
          // Initialize persistent auth store
          await auth.initAuthStore(this)
          // Ensure initial admin exists when configured (safe bootstrap)
          await auth.ensureInitialAdmin(this)

          const httpd = this.httpd_h0

          libServer.routes(this).forEach((r) => httpd.addRoute(r))

          await httpd.startServer()

          this.logger.info({ port: this.ctx.port }, 'HTTP gateway ready')
        }
      ],
      cb
    )
  }

  _stop (cb) {
    async.series(
      [
        async () => {
          await auth.closeAuthStore(this)
        },
        (next) => {
          super._stop(next)
        }
      ],
      cb
    )
  }
}

module.exports = WrkNodeHttp
