#!/usr/bin/env node

/**
 * Fail-closed tombstone for the retired synthetic custom benchmark.
 *
 * The previous script exercised constructed Playwright pages and in-memory
 * arrays, then labelled every operation as a successful LHIC capability. Those
 * operations were not measurements of the product and must not be emitted as
 * benchmark evidence.
 */

const guidance = [
  "scripts/custom-benchmark.ts is retired because it simulated LHIC capabilities",
  "and emitted hard-coded successes rather than observed product outcomes.",
  "",
  "Run the controlled, executable regression benchmark instead:",
  "  npm run bench:internal",
  "",
  "For external benchmark evidence, use the pinned runners documented in:",
  "  benchmarks/README.md",
  "No report was written.",
].join("\n");

console.error(guidance);
process.exitCode = 2;
