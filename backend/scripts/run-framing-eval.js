import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { normalizeFraming } from '../routes/coverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../tests/fixtures/framing-eval.json');
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
let failures = 0;

function shuffled(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

for (const fixture of fixtures) {
  const baseline = normalizeFraming(fixture.model_output, fixture.transcript, fixture.articles);
  if (fixture.expected.abstain) {
    if (baseline === null) console.log(`PASS ${fixture.name}`);
    else {
      failures += 1;
      console.error(`FAIL ${fixture.name}`);
    }
    continue;
  }
  const checks = [
    baseline.direction === fixture.expected.direction,
    baseline.evidence.length === fixture.expected.evidence_count,
    fixture.expected.framing_intensity == null || baseline.framing_intensity === fixture.expected.framing_intensity,
    fixture.expected.reliability == null || baseline.reliability === fixture.expected.reliability,
  ];

  for (let run = 0; run < 10; run += 1) {
    const reordered = normalizeFraming(fixture.model_output, fixture.transcript, shuffled(fixture.articles));
    checks.push(JSON.stringify(reordered.dimensions) === JSON.stringify(baseline.dimensions));
    checks.push(reordered.direction === baseline.direction);
  }

  if (checks.every(Boolean)) {
    console.log(`PASS ${fixture.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${fixture.name}`);
  }
}

console.log(`${fixtures.length - failures}/${fixtures.length} framing fixtures passed`);
process.exitCode = failures ? 1 : 0;
