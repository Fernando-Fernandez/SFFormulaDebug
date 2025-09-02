// Node.js Native Test Runner tests for Parser
const test = require('node:test');
const assert = require('node:assert/strict');

const { Parser } = require('../scripts/content.js');

function parse(input) {
  const p = new Parser();
  return p.parse(input);
}

test('parses numeric literal', () => {
  const ast = parse('123');
  assert.equal(ast.type, 'Literal');
  assert.equal(ast.value, 123);
});

test('parses string literals (single and double quotes)', () => {
  let ast = parse("'abc'");
  assert.equal(ast.type, 'Literal');
  assert.equal(ast.value, 'abc');
  ast = parse('"xyz"');
  assert.equal(ast.type, 'Literal');
  assert.equal(ast.value, 'xyz');
});

test('parses NULL as Literal null', () => {
  const ast = parse('NULL');
  assert.equal(ast.type, 'Literal');
  assert.equal(ast.value, null);
});

test('parses field reference', () => {
  const ast = parse('My_Field__c');
  assert.equal(ast.type, 'Field');
  assert.equal(ast.name, 'My_Field__c');
});

test('operator precedence: 1 + 2 * 3', () => {
  const ast = parse('1 + 2 * 3');
  assert.equal(ast.type, 'Operator');
  assert.equal(ast.operator, '+');
  assert.equal(ast.left.type, 'Literal');
  assert.equal(ast.left.value, 1);
  assert.equal(ast.right.type, 'Operator');
  assert.equal(ast.right.operator, '*');
  assert.equal(ast.right.left.value, 2);
  assert.equal(ast.right.right.value, 3);
});

test('parentheses alter precedence: (1 + 2) * 3', () => {
  const ast = parse('(1 + 2) * 3');
  assert.equal(ast.type, 'Operator');
  assert.equal(ast.operator, '*');
  assert.equal(ast.left.type, 'Operator');
  assert.equal(ast.left.operator, '+');
  assert.equal(ast.left.left.value, 1);
  assert.equal(ast.left.right.value, 2);
  assert.equal(ast.right.value, 3);
});

test('comparisons and logical operators', () => {
  const ast = parse('1 = 1 && 2 < 3 || 4 >= 5');
  // ( (1=1 && 2<3) || 4>=5 )
  assert.equal(ast.type, 'Operator');
  assert.equal(ast.operator, '||');
  assert.equal(ast.left.type, 'Operator');
  assert.equal(ast.left.operator, '&&');
  assert.equal(ast.left.left.operator, '=');
  assert.equal(ast.left.right.operator, '<');
  assert.equal(ast.right.operator, '>=');
});

test('function call with arguments: IF(1=1, "a", "b")', () => {
  const ast = parse('IF(1=1, "a", "b")');
  assert.equal(ast.type, 'Function');
  assert.equal(ast.name, 'IF');
  assert.equal(ast.arguments.length, 3);
  assert.equal(ast.arguments[0].type, 'Operator');
  assert.equal(ast.arguments[0].operator, '=');
  assert.equal(ast.arguments[1].type, 'Literal');
  assert.equal(ast.arguments[1].value, 'a');
  assert.equal(ast.arguments[2].value, 'b');
});

test('nested function and arithmetic', () => {
  const ast = parse('FLOOR( (1 + 2) / 3 )');
  assert.equal(ast.type, 'Function');
  assert.equal(ast.name, 'FLOOR');
  assert.equal(ast.arguments.length, 1);
  const div = ast.arguments[0];
  assert.equal(div.type, 'Operator');
  assert.equal(div.operator, '/');
  assert.equal(div.left.operator, '+');
  assert.equal(div.right.value, 3);
});

test('unexpected closing parenthesis triggers error during parse', () => {
  const p = new Parser();
  assert.throws(() => p.parse('1 + )'), /Unexpected closing parenthesis/);
});

test('unexpected end of input', () => {
  const p = new Parser();
  assert.throws(() => p.parse('1 +'), /Unexpected end of input/);
});

