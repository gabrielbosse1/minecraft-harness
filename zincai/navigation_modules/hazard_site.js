'use strict'

/** Opt-in example: publish an operator-configured temporary exclusion. No bot handle or LLM. */
function hazardSite ({ id, x, y, z, dim, radius, durationMs = 2000 }) {
  let expiresAt
  return {
    id,
    purpose: 'Treat a known temporary hazard site as a route restriction',
    inputs: ['position', 'dimension', 'time'],
    outputs: ['danger'],
    capabilities: ['route-cost'],
    start () { return () => { expiresAt = undefined } },
    observe (frame, navigation) {
      if (frame.dim !== dim || expiresAt !== undefined) return
      expiresAt = frame.at + durationMs
      navigation.publishDanger('site', { x, y, z, dim, radius, expiresAt, hard: true })
    }
  }
}

module.exports = { hazardSite }
