// Node.js Native Test Runner tests for Tokenizer
const test = require('node:test');
const assert = require('node:assert/strict');

const { Tokenizer } = require('../scripts/content.js');

function collectTokens(input) {
  const t = new Tokenizer();
  t.initialize(input);
  const out = [];
  while (t.hasMoreTokens()) {
    const tok = t.getNextToken();
    if (!tok) break;
    out.push(tok);
  }
  return { tokens: out, tokenizer: t };
}

test('tokenizes simple arithmetic with whitespace', () => {
  const { tokens, tokenizer } = collectTokens('1 + 2');
  assert.equal(tokens[0].tokenType, 'NUMBER');
  assert.equal(tokens[0].token, '1');
  assert.equal(tokens[1].tokenType, 'WHITESPACE');
  assert.equal(tokens[2].tokenType, 'ADDITIVE_OPERATOR');
  assert.equal(tokens[2].token, '+');
  assert.equal(tokens[3].tokenType, 'WHITESPACE');
  assert.equal(tokens[4].tokenType, 'NUMBER');
  assert.equal(tokens[4].token, '2');
  // Balanced (no error)
  assert.doesNotThrow(() => tokenizer.checkParenthesesBalance());
});

test('handles strings and numbers', () => {
  const { tokens } = collectTokens("'abc' \"xyz\" 123");
  assert.equal(tokens[0].tokenType, 'STRING');
  assert.equal(tokens[1].tokenType, 'WHITESPACE');
  assert.equal(tokens[2].tokenType, 'DOUBLE_QUOTE_STRING');
  assert.equal(tokens[3].tokenType, 'WHITESPACE');
  assert.equal(tokens[4].tokenType, 'NUMBER');
});

test('comments are recognized', () => {
  const { tokens } = collectTokens('/* multi */ // single');
  assert.equal(tokens[0].tokenType, 'MULTI_LINE_COMMENT');
  assert.equal(tokens[1].tokenType, 'WHITESPACE');
  assert.equal(tokens[2].tokenType, 'SINGLE_LINE_COMMENT');
});

test('parentheses tracking - balanced', () => {
  const { tokenizer } = collectTokens('(1 + (2))');
  assert.doesNotThrow(() => tokenizer.checkParenthesesBalance());
});

test('parentheses tracking - unexpected closing', () => {
  const t = new Tokenizer();
  t.initialize('1 + 2)');
  assert.throws(() => {
    while (t.hasMoreTokens()) t.getNextToken();
  }, /Unexpected closing parenthesis/);
});

test('parentheses tracking - missing closing', () => {
  const t = new Tokenizer();
  t.initialize('(1 + (2)');
  while (t.hasMoreTokens()) t.getNextToken();
  assert.throws(() => t.checkParenthesesBalance(), /Missing closing parenthesis/);
});

test('logical and comparison operators', () => {
  const ops = '&& || = != <> < > <= >=';
  const { tokens } = collectTokens(ops);
  const types = tokens.filter(t => t.tokenType !== 'WHITESPACE').map(t => t.tokenType);
  assert.deepEqual(types, ['AND','OR','EQUAL','NOT_EQUAL','NOT_EQUAL','LESS_THAN','GREATER_THAN','LESS_THAN_OR_EQUAL','GREATER_THAN_OR_EQUAL']);
});

test('identifiers and NULL', () => {
  const { tokens } = collectTokens('My_Field__c NULL other1');
  const filtered = tokens.filter(t => t.tokenType !== 'WHITESPACE');
  assert.equal(filtered[0].tokenType, 'IDENTIFIER');
  assert.equal(filtered[1].tokenType, 'NULL');
  assert.equal(filtered[2].tokenType, 'IDENTIFIER');
});

test('unexpected character error', () => {
  const t = new Tokenizer();
  t.initialize('@');
  assert.throws(() => t.getNextToken(), /Unexpected character/);
});

