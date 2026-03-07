'use strict'

const async = require('async')
const WrkBase = require('wrk-base/workers/base.wrk')

/**
 * Orchestrator base class.
 *
 * Maintains a Hyperbee `racks` registry that maps rack IDs to their
 * RPC public keys. Child workers (inference workers, model workers)
 * register themselves here on start-up so other services can discover
 * them by type rather than by hard-coded address.
 *
 * Discovery flow:
 *   1. Worker boots → reads its own RPC public key from status file
 *   2. Worker calls `registerRack` on the orchestrator with its key
 *   3. Consumers call `listRacks` / `routeRequest` to find a worker
 *
 * @extends WrkBase
 */
class WrkOrkBase extends WrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)

    if (!ctx.cluster) {
      throw new Error('ERR_CLUSTER_UNDEFINED')
    }

    this.prefix = `${this.wtype}-${ctx.cluster}`
  }

  init () {
    super.init()
  }

  /**
   * Centralised debug / alert helper used across orchestrator methods.
   * @param {*} data
   * @param {Error} e
   * @param {boolean} [alert=false] - when true, logs at error level
   */
  debugError (data, e, alert = false) {
    if (alert) {
      return this.logger.error({ data }, e)
    }
    this.logger.debug({ data }, e)
  }

  /**
   * Register a worker rack in the orchestrator's store.
   * Called by each worker after boot.
   *
   * @param {Object} req
   * @param {string} req.id            - Unique rack ID (UUID)
   * @param {string} req.type          - Worker type, e.g. "inference" | "model"
   * @param {Object} req.info
   * @param {string} req.info.rpcPublicKey - Hex-encoded RPC key
   * @returns {Promise<1>}
   */
  async registerRack (req) {
    if (!req.id) throw new Error('ERR_RACK_ID_INVALID')
    if (!req.type) throw new Error('ERR_RACK_TYPE_INVALID')
    if (!req.info || !req.info.rpcPublicKey) { throw new Error('ERR_RACK_RPC_KEY_INVALID') }

    await this.racks.put(req.id, req)
    this.logger.info({ rackId: req.id, type: req.type }, 'rack registered')
    return 1
  }

  /**
   * Remove one or more racks from the registry.
   * @param {Object} req
   * @param {string[]} [req.ids] - Specific rack IDs to remove
   * @param {boolean}  [req.all] - Remove all racks
   * @returns {Promise<number>} Count of removed racks
   */
  async forgetRacks (req) {
    const stream = this.racks.createReadStream()
    let cnt = 0

    for await (const data of stream) {
      const entry = data.value
      const shouldRemove =
        req.all || (Array.isArray(req.ids) && req.ids.includes(entry.id))

      if (shouldRemove) {
        await this.racks.del(entry.id)
        cnt++
      }
    }

    return cnt
  }

  /**
   * List registered racks, optionally filtered by type prefix.
   * RPC public keys are stripped from results unless `req.keys` is set.
   *
   * @param {Object}  req
   * @param {string}  [req.type]  - Filter by rack type prefix
   * @param {boolean} [req.keys]  - Include RPC public keys in response
   * @returns {Promise<Object[]>}
   */
  async listRacks (req) {
    if (req.type && typeof req.type !== 'string') { throw new Error('ERR_TYPE_INVALID') }

    const stream = this.racks.createReadStream()
    const res = []

    for await (const data of stream) {
      const entry = data.value
      if (!req.type || entry.type.startsWith(req.type)) {
        res.push(entry)
      }
    }

    if (!req.keys) {
      return res.map((entry) => {
        const safe = { ...entry, info: { ...entry.info } }
        delete safe.info.rpcPublicKey
        return safe
      })
    }

    return res
  }

  _start (cb) {
    async.series(
      [
        (next) => {
          super._start(next)
        },
        async () => {
          const rpcServer = this.net_r0.rpcServer

          this.racks = await this.store_s0.getBee(
            { name: 'racks' },
            { keyEncoding: 'utf-8', valueEncoding: 'json' }
          )
          await this.racks.ready()

          rpcServer.respond('registerRack', (req) =>
            this.net_r0.handleReply('registerRack', req)
          )
          rpcServer.respond('forgetRacks', (req) =>
            this.net_r0.handleReply('forgetRacks', req)
          )
          rpcServer.respond('listRacks', (req) =>
            this.net_r0.handleReply('listRacks', req)
          )
        }
      ],
      cb
    )
  }
}

module.exports = WrkOrkBase
