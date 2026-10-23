import { parseArgs } from 'node:util';

export interface CliArgs {
  port?: number;
  open: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
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
  return args;
}
