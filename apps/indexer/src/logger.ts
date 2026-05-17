type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: number = LEVELS.info;

export function setLogLevel(level: string): void {
  minLevel = LEVELS[level as Level] ?? LEVELS.info;
}

function log(level: Level, fields: Fields, message: string): void {
  if (LEVELS[level] < minLevel) return;
  const entry: Record<string, unknown> = {
    ts:  new Date().toISOString(),
    lvl: level,
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (fields: Fields, message: string) => log('debug', fields, message),
  info:  (fields: Fields, message: string) => log('info',  fields, message),
  warn:  (fields: Fields, message: string) => log('warn',  fields, message),
  error: (fields: Fields, message: string) => log('error', fields, message),
};
