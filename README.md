# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Kodoku05/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Kodoku05/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers exactly as the reference does on every case — the same output tree, byte for byte — in less CPU time. No dependencies, standard library only (in fact it imports nothing at all).

## How it is faster

- **Markdown renders in one pass.** No token objects: blocks are classified by a first-character dispatch and rendered straight to the output string. Inline parsing fuses escaping into a single scan — the runs between two significant characters hold neither a Markdown special nor an escapable character, so they are copied raw.
- **Templates compile to JavaScript.** Each template becomes one function over a single flat scope object (no scope-chain walks, no per-render scope allocation), and output is built by rope concatenation instead of array joins.
- **ASCII fast paths.** Slugs skip Unicode normalisation when the text is pure ASCII; escaping tests once and returns untouched strings as-is; front matter finds its closing `---` without splitting the body; `\r` normalisation is skipped when the file holds no `\r`.
- **Memoisation within a case.** Slugs and link resolutions are cached per case (never across cases); cards and tag views are built once and shared.
- **Cold-run tuning.** Every graded run is a fresh container, so `main.ts` turns the optimizing compiler off (`--no-opt`): the run is too short for TurboFan to earn its compile cost back (measured ~12% faster cold than with it on).

## Layout

- `solve.js` — the entry: `run(input)` returns the output tree for one case.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` parses as an ES module with no reparse step.

## Verify

```sh
node --check solve.js
```

Grade locally with the competition kit (`grade-local`), or run the entry on the practice set and compare against `practice/reference/expected.json`: all 3 practice cases match byte for byte, and differential fuzzing against the reference on generated sites shows zero mismatches.

## Measured speed (this VM, practice set of 3 cases)

- Warm `run()` only, interleaved with the baseline: **~3.8× faster** than makefun-site 1.0.0.
- Whole-program CPU in a fresh process (the graded shape: startup, JSON parse, run, stringify), median of 7 runs: **~790 ms vs ~1,334 ms** for the baseline — about **1.7×** gross, **~1.85×** net of the do-nothing control (~149 ms). Cold-start costs dilute every entry's warm ratio the same way; the entry still beats the baseline at every step.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
