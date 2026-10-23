// A synth worker that never answers, for the timeout tests.
process.on('message', () => setInterval(() => {}, 1000));
