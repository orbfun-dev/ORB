/**
 * Structured logging: pino JSON on stdout by default (journald captures it
 * under systemd), optionally mirrored to a file. Levels tune via
 * CRANK_LOG_LEVEL; `silent` keeps the test suite quiet.
 */

import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string, file?: string): Logger {
  if (file === undefined) {
    return pino({ level, base: { svc: "orbit-crank" } });
  }
  return pino({ level, base: { svc: "orbit-crank" } }, pino.destination({ dest: file, mkdir: true }));
}
