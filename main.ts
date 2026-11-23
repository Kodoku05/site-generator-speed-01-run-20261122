// main.ts — the driver the harness runs (`node /bot/main.ts`). It reads every
// case from /input/cases.json, answers each one alone with run() from
// solve.js, and writes /output/answers.json: one answer per case, in order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the house baseline is timed with the same tuning, and
// the rules let an entry tune V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

const solve = await import(new URL('./solve.js', import.meta.url).href);
const run = solve.run as (input: unknown) => unknown;

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers = cases.map((c) => run(c.input));
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
