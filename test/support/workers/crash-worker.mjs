// A synth worker that dies on its first request, for the crash tests.
process.on('message', () => {
  console.error('worker went down');
  process.exit(7);
});
