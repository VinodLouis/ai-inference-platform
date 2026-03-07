'use strict'

const BfxWrkBase = require('bfx-wrk-base')
const async = require('async')
const pino = require('pino')

/**
 * Base worker class for the Inference Platform.
 * All microservice workers inherit from this class.
 * Provides Hyperswarm RPC server setup, structured logging,
 * and persistent key-value storage via hp-svc-facs-store.
 *
 * @extends BfxWrkBase
 */
class WrkBase extends BfxWrkBase {
  /**
   * Initialise facilities required by every worker:
   *   - s0: persistent store (Hypercore/Hyperbee)
   *   - r0: Hyperswarm RPC network layer
   */
  init () {
    super.init()

    this.loadConf('common')

    const storeDir =
      this.ctx.env === 'test' && this.ctx.tmpdir
        ? `${this.ctx.tmpdir}/store/${this.ctx.rack}`
        : `store/${this.ctx.rack}`

    this.setInitFacs([
      ['fac', 'hp-svc-facs-store', 's0', 's0', { storeDir }, 0],
      [
        'fac',
        'hp-svc-facs-net',
        'r0',
        'r0',
        () => ({ fac_store: this.store_s0 }),
        1
      ]
    ])

    this.logger = pino({
      name: `wrk:${this.ctx.wtype}:${process.pid}`,
      level: this.conf.debug || this.ctx.debug ? 'debug' : 'info'
    })
  }

  /**
   * Returns the hex-encoded public key of this worker's RPC server.
   * Other services use this key to route requests to this worker.
   * @returns {Buffer} Raw public key buffer
   */
  getRpcKey () {
    return this.net_r0.rpcServer.publicKey
  }

  /**
   * Returns the client DHT keypair public key (used for outbound connections).
   * @returns {Buffer} Raw public key buffer
   */
  getRpcClientKey () {
    return this.net_r0.rpcServer.dht.defaultKeyPair.publicKey
  }

  /** @private */
  async _startRpcServer () {
    await this.net_r0.startRpcServer()
  }

  /**
   * Starts the worker: boots facilities, starts the RPC server,
   * registers a baseline `ping` handler, and persists status.
   * @param {Function} cb - Node-style callback
   */
  _start (cb) {
    async.series(
      [
        (next) => {
          super._start(next)
        },
        async () => {
          await this._startRpcServer()

          const rpcServer = this.net_r0.rpcServer

          // Baseline liveness check – every worker responds to ping
          rpcServer.respond('ping', (x) => x)

          this.status.rpcPublicKey = this.getRpcKey().toString('hex')
          this.status.rpcClientKey = this.getRpcClientKey().toString('hex')

          this.saveStatus()
        }
      ],
      cb
    )
  }
}

module.exports = WrkBase
