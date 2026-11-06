'use strict';

// State source registry. Add a new state here ONLY after its terms are read and
// recorded in the actor README ("Source terms"). A source whose terms prohibit
// this use must not be listed.

const ny = require('./ny');
const co = require('./co');
const ct = require('./ct');

const SOURCES = { NY: ny, CO: co, CT: ct };

function getSource(state) {
  return SOURCES[String(state || '').toUpperCase()] || null;
}

function listStates() {
  return Object.keys(SOURCES);
}

module.exports = { SOURCES, getSource, listStates };
