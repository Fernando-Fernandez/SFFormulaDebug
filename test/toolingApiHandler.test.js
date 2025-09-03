const test = require('node:test');
const assert = require('node:assert/strict');

const { ToolingAPIHandler } = require('../scripts/content.js');

function withPatchedSetTimeout(fn) {
  const orig = global.setTimeout;
  global.setTimeout = (cb/*, ms*/) => { try { cb(); } catch(e) {} return 0; };
  return fn().finally(() => { global.setTimeout = orig; });
}

test('ToolingAPIHandler.executeAnonymous success path updates doc from SFDBG markers', async () => {
  const updates = {};
  const doc = { getElementById: (id) => (updates[id] ||= { textContent: '' }) };

  const runId = 'testrun';
  const mockFetch = async (url, req) => {
    if (url.includes('/executeAnonymous/')) {
      return { json: async () => ({ success: true }) };
    }
    if (url.includes('/tooling/query/')) {
      return { json: async () => ({ records: [{ Id: '07Lxx0000000001' }] }) };
    }
    if (url.includes('/sobjects/ApexLog/')) {
      const log = '45.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO\n' +
                  '12:00:00.000 (0)|USER_DEBUG|[1]|DEBUG|SFDBG&#124;' + runId + '&#124;1&#124;42';
      return { text: async () => log };
    }
    throw new Error('Unexpected URL ' + url);
  };

  const origFetch = global.fetch;
  global.fetch = mockFetch;

  try {
    const handler = new ToolingAPIHandler('example.my.salesforce.com', '00Dxx!session');
    const result = await withPatchedSetTimeout(() => handler.executeAnonymous('System.debug(\'X\');', runId, doc));
    assert.equal(result, true);
    assert.equal(updates[`step-result-${runId}-1`].textContent, '= 42');
  } finally {
    global.fetch = origFetch;
  }
});

test('ToolingAPIHandler.executeAnonymous returns fallback first USER_DEBUG when no markers', async () => {
  const runId = 'norun';
  const mockFetch = async (url, req) => {
    if (url.includes('/executeAnonymous/')) {
      return { json: async () => ({ success: true }) };
    }
    if (url.includes('/tooling/query/')) {
      return { json: async () => ({ records: [{ Id: '07Lxx0000000002' }] }) };
    }
    if (url.includes('/sobjects/ApexLog/')) {
      const log = '12:00:00.000 (0)|USER_DEBUG|[1]|DEBUG|hello world';
      return { text: async () => log };
    }
    throw new Error('Unexpected URL ' + url);
  };
  const origFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    const handler = new ToolingAPIHandler('example.my.salesforce.com', '00Dxx!session');
    const result = await withPatchedSetTimeout(() => handler.executeAnonymous('System.debug(\'X\');', runId));
    assert.equal(result, 'hello world');
  } finally {
    global.fetch = origFetch;
  }
});

test('ToolingAPIHandler.executeAnonymous handles execution error response', async () => {
  const mockFetch = async (url, req) => {
    if (url.includes('/executeAnonymous/')) {
      return { json: async () => ([{ errorCode: 'INVALID_SESSION_ID', message: 'Nope' }]) };
    }
    throw new Error('Should not be called further');
  };
  const origFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    const handler = new ToolingAPIHandler('example.my.salesforce.com', 'bad');
    const result = await withPatchedSetTimeout(() => handler.executeAnonymous('System.debug(\'X\');'));
    assert.equal(result, null);
  } finally {
    global.fetch = origFetch;
  }
});

