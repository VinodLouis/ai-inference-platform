'use strict'

const crypto = require('crypto')

/**
 * Audit Logger Module
 *
 * Provides structured, traceable logging across all services
 * for audit trail and debugging purposes.
 *
 * Features:
 *   - Auto-generated trace IDs for request correlation
 *   - Consistent audit event structure
 *   - Support for event types (REQUEST, RESPONSE, ERROR, LIFECYCLE, etc.)
 *   - Easy integration into existing workers
 *
 * Usage:
 *   const audit = require('./lib/audit')
 *   const traceId = audit.generateTraceId()
 *   audit.log(logger, 'REQUEST', { traceId, method: 'runInference', userId: 'user123' })
 */

/**
 * Event types for audit logging
 */
const AuditEventType = {
  REQUEST: 'REQUEST', // Incoming request/RPC call
  RESPONSE: 'RESPONSE', // Outgoing response
  ERROR: 'ERROR', // Error condition
  LIFECYCLE: 'LIFECYCLE', // Service start/stop/ready
  RPC_CALL: 'RPC_CALL', // Outgoing RPC call to another service
  RPC_RESPONSE: 'RPC_RESPONSE', // Response from another service
  DATA_ACCESS: 'DATA_ACCESS', // Database/store read/write
  AUTH: 'AUTH', // Authentication/authorization events
  JOB_STATUS: 'JOB_STATUS' // Job state changes
}

/**
 * Generate a unique trace ID for request correlation.
 * Use this at the entry point of every request and pass it through
 * all downstream calls.
 *
 * @returns {string} UUID v4 trace ID
 */
function generateTraceId () {
  return crypto.randomUUID()
}

/**
 * Extract trace ID from request or generate a new one.
 * @param {Object} req - Request object (may contain traceId)
 * @returns {string} trace ID
 */
function getOrCreateTraceId (req = {}) {
  return req.traceId || generateTraceId()
}

/**
 * Log an audit event with structured data.
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} eventType - One of AuditEventType
 * @param {Object} data - Event-specific data (must include traceId)
 * @param {string} [level='info'] - Log level (info, warn, error)
 */
function log (logger, eventType, data, level = 'info') {
  if (!logger || typeof logger[level] !== 'function') {
    console.error('[AUDIT] Invalid logger provided')
    return
  }

  if (!data.traceId) {
    console.warn('[AUDIT] Event logged without traceId:', eventType)
  }

  const auditEvent = {
    audit: true,
    eventType,
    timestamp: new Date().toISOString(),
    ...data
  }

  logger[level](auditEvent)
}

/**
 * Log a REQUEST event.
 * Call this at the entry point of every RPC method or API endpoint.
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID for this request
 * @param {string} method - RPC method or HTTP route name
 * @param {Object} data - Additional context (userId, params, etc.)
 */
function logRequest (logger, traceId, method, data = {}) {
  log(logger, AuditEventType.REQUEST, {
    traceId,
    method,
    ...data
  })
}

/**
 * Log a RESPONSE event.
 * Call this before returning from an RPC method or API endpoint.
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID for this request
 * @param {string} method - RPC method or HTTP route name
 * @param {Object} data - Response metadata (status, duration, etc.)
 */
function logResponse (logger, traceId, method, data = {}) {
  log(logger, AuditEventType.RESPONSE, {
    traceId,
    method,
    ...data
  })
}

/**
 * Log an ERROR event.
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID for this request
 * @param {string} method - RPC method or HTTP route name
 * @param {Error|Object} error - Error object or error details
 * @param {Object} data - Additional context
 */
function logError (logger, traceId, method, error, data = {}) {
  log(
    logger,
    AuditEventType.ERROR,
    {
      traceId,
      method,
      error: error.message || error,
      stack: error.stack,
      ...data
    },
    'error'
  )
}

/**
 * Log an RPC_CALL event (outgoing call to another service).
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID to propagate
 * @param {string} targetService - Target service name or RPC key
 * @param {string} method - RPC method being called
 * @param {Object} data - Additional context
 */
function logRpcCall (logger, traceId, targetService, method, data = {}) {
  log(logger, AuditEventType.RPC_CALL, {
    traceId,
    targetService,
    method,
    ...data
  })
}

/**
 * Log an RPC_RESPONSE event (response from another service).
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID
 * @param {string} targetService - Target service name or RPC key
 * @param {string} method - RPC method that was called
 * @param {Object} data - Response metadata (duration, status, etc.)
 */
function logRpcResponse (logger, traceId, targetService, method, data = {}) {
  log(logger, AuditEventType.RPC_RESPONSE, {
    traceId,
    targetService,
    method,
    ...data
  })
}

/**
 * Log a DATA_ACCESS event.
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID
 * @param {string} operation - Operation type (get, put, delete, list)
 * @param {string} key - Data key or identifier
 * @param {Object} data - Additional context
 */
function logDataAccess (logger, traceId, operation, key, data = {}) {
  log(logger, AuditEventType.DATA_ACCESS, {
    traceId,
    operation,
    key,
    ...data
  })
}

/**
 * Log a LIFECYCLE event (service start, stop, ready).
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} event - Lifecycle event (starting, ready, stopping, stopped)
 * @param {Object} data - Additional context (port, version, etc.)
 */
function logLifecycle (logger, event, data = {}) {
  log(logger, AuditEventType.LIFECYCLE, {
    traceId: generateTraceId(), // Generate unique ID for lifecycle events
    event,
    ...data
  })
}

/**
 * Log a JOB_STATUS event (for tracking job state changes).
 *
 * @param {Object} logger - Pino logger instance
 * @param {string} traceId - Trace ID
 * @param {string} jobId - Job identifier
 * @param {string} status - New job status
 * @param {Object} data - Additional context
 */
function logJobStatus (logger, traceId, jobId, status, data = {}) {
  log(logger, AuditEventType.JOB_STATUS, {
    traceId,
    jobId,
    status,
    ...data
  })
}

/**
 * Create a timer to measure operation duration.
 * Returns a function that when called returns elapsed time in milliseconds.
 *
 * @returns {Function} Timer function that returns elapsed ms
 */
function createTimer () {
  const start = process.hrtime.bigint()
  return () => {
    const end = process.hrtime.bigint()
    return Number(end - start) / 1000000 // Convert nanoseconds to milliseconds
  }
}

module.exports = {
  AuditEventType,
  generateTraceId,
  getOrCreateTraceId,
  log,
  logRequest,
  logResponse,
  logError,
  logRpcCall,
  logRpcResponse,
  logDataAccess,
  logLifecycle,
  logJobStatus,
  createTimer
}
