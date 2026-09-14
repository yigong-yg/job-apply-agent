'use strict';

// Each legacy test file owns its process lifecycle (several call process.exit).
// Run them in deterministic, isolated child processes so one file cannot hide
// the rest of the suite from either local runs or CI.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = __dirname;
const testFiles = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

let failures = 0;
for (const testFile of testFiles) {
  console.log(`\n=== ${testFile} ===`);
  const result = spawnSync(process.execPath, [path.join(testDir, testFile)], {
    cwd: path.join(testDir, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    failures++;
    console.error(`${testFile}: ${result.error.message}`);
  } else if (result.status !== 0) {
    failures++;
    console.error(`${testFile}: exited with ${result.status ?? result.signal}`);
  }
}

console.log(`\n=== ${testFiles.length} test files; ${failures} failed ===`);
process.exitCode = failures === 0 ? 0 : 1;
