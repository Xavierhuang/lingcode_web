'use strict';

// Tests for the Domainee adapter's account-free pieces: the status/cname
// summarizer and the inert-until-configured guard. (Network calls are exercised
// separately via a live smoke check, not in the unit suite.)

const test = require('node:test');
const assert = require('node:assert');
const dm = require('../cloud-domainee');

test('summarize: pending until Domainee reports the edge live', () => {
  const s = dm.summarize({ status: 'pending', pointsToEdge: false, dnsRecords: [{ name: 'x.com', value: 'edge.domainee.dev', type: 'CNAME' }] });
  assert.equal(s.status, 'pending');
  assert.equal(s.cname, 'edge.domainee.dev');
});

test('summarize: active once pointsToEdge (or an active/verified status)', () => {
  assert.equal(dm.summarize({ pointsToEdge: true, dnsRecords: [] }).status, 'active');
  assert.equal(dm.summarize({ status: 'verified', dnsRecords: [] }).status, 'active');
  assert.equal(dm.summarize({ status: 'active', dnsRecords: [] }).status, 'active');
});

test('summarize: falls back to the default edge cname when no record present', () => {
  assert.equal(dm.summarize({ status: 'pending' }).cname, 'edge.domainee.dev');
});

test('Domainee is inert (not configured) without LINGCODE_DOMAINEE_KEY', () => {
  assert.equal(dm.isConfigured(), false);
});
