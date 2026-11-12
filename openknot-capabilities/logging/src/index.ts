/** Marks the `/wire` logger reference, so layers recognize it without loading Wire. */
export const LoggerMarker = Symbol.for("@openknot-ts/logging/logger");

export function isLoggerReference(value: unknown): boolean {
  return typeof value === "object" && value !== null && LoggerMarker in value;
}

/** The levels pino and OpenTelemetry share, lowest first. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogAttributes = Readonly<Record<string, unknown>>;

/** One record as the caller wrote it; time, format and destination belong to the implementation. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly attributes: LogAttributes;
}

/** OpenKnot's logging contract: callers describe records, implementations write them. */
export interface Logging {
  write(record: LogRecord): void;
}

/** What operations, handlers and plugs log through. */
export interface Logger {
  trace(message: string, attributes?: LogAttributes): void;
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
  fatal(message: string, attributes?: LogAttributes): void;
  /** A logger that adds these attributes to every record it writes. */
  child(attributes: LogAttributes): Logger;
}

export interface LoggerOptions {
  /** The lowest level written; `info` by default. */
  readonly level?: LogLevel | undefined;
  readonly attributes?: LogAttributes | undefined;
  /** Read for each record written, such as the active trace's ids; its attributes win over the caller's. */
  readonly correlation?: (() => LogAttributes | undefined) | undefined;
}

const levels: readonly LogLevel[] = Object.freeze(["trace", "debug", "info", "warn", "error", "fatal"]);

export function isLogLevel(value: unknown): value is LogLevel {
  return levels.includes(value as LogLevel);
}

/** Reads a level from configuration, such as `LOG_LEVEL`; a missing value is `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const level = value?.trim().toLowerCase() || "info";
  if (!isLogLevel(level)) {
    throw new TypeError(`Expected one of ${levels.join(", ")}.`);
  }
  return level;
}

function merge(inherited: LogAttributes, ...sources: readonly (LogAttributes | undefined)[]): LogAttributes {
  const added = sources.filter((source) => source !== undefined);
  return added.length === 0 ? inherited : Object.freeze(Object.assign({}, inherited, ...added));
}

/**
 * Logging never fails the work that logs: a record that cannot be built or written is reported to the console
 * together with the error.
 */
export function createLogger(logging: Logging, options: LoggerOptions = {}): Logger {
  const correlation = options.correlation;
  const minimum = levels.indexOf(options.level ?? "info");

  if (minimum === -1) {
    throw new TypeError(`Unknown log level: ${String(options.level)}`);
  }

  function create(inherited: LogAttributes): Logger {
    const write = (level: LogLevel, message: string, attributes: LogAttributes | undefined) => {
      if (levels.indexOf(level) < minimum) {
        return;
      }
      try {
        logging.write(Object.freeze({ level, message, attributes: merge(inherited, attributes, correlation?.()) }));
      } catch (error) {
        console.error("A log record could not be written.", { level, message, error });
      }
    };

    return Object.freeze({
      trace: (message: string, attributes?: LogAttributes) => write("trace", message, attributes),
      debug: (message: string, attributes?: LogAttributes) => write("debug", message, attributes),
      info: (message: string, attributes?: LogAttributes) => write("info", message, attributes),
      warn: (message: string, attributes?: LogAttributes) => write("warn", message, attributes),
      error: (message: string, attributes?: LogAttributes) => write("error", message, attributes),
      fatal: (message: string, attributes?: LogAttributes) => write("fatal", message, attributes),
      child: (attributes: LogAttributes) => create(Object.freeze({ ...inherited, ...attributes })),
    });
  }

  return create(Object.freeze({ ...options.attributes }));
}

/** `console.trace` would print a stack, and the console has no fatal method. */
const consoleMethods = Object.freeze({
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  fatal: "error",
} as const satisfies Record<LogLevel, keyof Console>);

/** The default implementation: one line per record on the console, warnings and above on stderr. */
export const consoleLogging: Logging = Object.freeze({
  write({ level, message, attributes }: LogRecord): void {
    const method = consoleMethods[level];
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    if (Object.keys(attributes).length === 0) {
      console[method](line);
    } else {
      console[method](line, attributes);
    }
  },
});
