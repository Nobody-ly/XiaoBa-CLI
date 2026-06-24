const assert = require('node:assert/strict');
const { add } = require('./calculator');

assert.equal(add(2, 3), 5);
assert.equal(add(-2, 5), 3);
console.log('ok');
