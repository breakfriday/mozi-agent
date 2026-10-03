const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../dual-electron.config.cjs");

test("renderer configuration has a project directory and an HTTP development URL", () => {
  assert.equal(typeof config.rendererDir, "string");
  assert.ok(config.rendererDir.length > 0);
  assert.match(config.rendererDevUrl, /^https?:\/\//);
  assert.equal(typeof config.rendererHash, "string");
});
