import { parseArgs } from 'node:util';

export interface CliArgs {
  port?: number;
  /** Seconds one synth may run before it is killed. */
  synthTimeout?: number;
  open: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      'synth-timeout': { type: 'string' },
    },
    strict: true,
  });
  const args: CliArgs = { open: !values['no-open'] };
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--port must be a number from 1 to 65535, got "${values.port}"`);
    }
    args.port = port;
  }
  if (values['synth-timeout'] !== undefined) {
    const seconds = Number(values['synth-timeout']);
    if (values['synth-timeout'].trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`--synth-timeout must be a number of seconds above 0, got "${values['synth-timeout']}"`);
    }
    args.synthTimeout = seconds;
  }
  return args;
}
