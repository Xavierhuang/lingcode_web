'use strict';
// Gate 1 — hello-world. Proves a container job runs, sees its injected env, and
// exits 0 with its stdout captured into compute_runs.logs.
console.log('hello from compute backend=' + process.env.LINGCODE_BACKEND_ID + ' run=' + process.env.LINGCODE_RUN_ID);
if (process.env.LINGCODE_INPUT) console.log('input=' + process.env.LINGCODE_INPUT);
console.log('GATE1_PASS');
