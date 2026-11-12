import type { ErrorKind, ErrorReporter } from "@openknot-ts/error-reporting";
import { isReported } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type {
  ManagedResource,
  NoRequirements,
  ProvidedPlugs,
  Provider,
  Requirements,
  RequirementsOptions,
  ResolvedReferences,
} from "@openknot-ts/wire";
import { providePlugs, resource, unit } from "@openknot-ts/wire";

/** What OpenKnot calls on a runtime's Sentry SDK, such as `@sentry/node` or `@sentry/bun`. */
export interface SentrySdk<Options> {
  init(options: Options): unknown;
  isInitialized(): boolean;
  getClient(): SentryClient | undefined;
  close(timeout?: number): Promise<boolean>;
  withScope<T>(callback: (scope: SentryScope) => T): T;
  captureException(exception: unknown, hint?: { readonly mechanism?: SentryMechanism }): string;
}

export interface SentryScope {
  setTag(key: string, value: string): unknown;
  setContext(name: string, context: Readonly<Record<string, string | number | boolean>>): unknown;
}

/** How a failure reached Sentry: unexpected ones were handled by no application code. */
export interface SentryMechanism {
  readonly type: string;
  readonly handled: boolean;
}

export interface SentryClient {
  getOptions(): object;
  close(timeout?: number): PromiseLike<boolean>;
}

/**
 * The module's compile-time graph: it implements the error reporter. Its requirements are checked when the application
 * starts, so a missing setting fails startup instead of silently disabling reporting.
 */
export type SentryModule = ProvidedPlugs<never, typeof errorReporter>;

export type SentryModuleOptions<Options, R extends Requirements = NoRequirements> = RequirementsOptions<R> & {
  /**
   * The SDK's options: the module initializes Sentry with them at startup and closes it at shutdown, after the
   * application's work has drained.
   */
  readonly options: (dependencies: ResolvedReferences<R>) => Options;
  /** Expected failures to report as well, such as authored business errors; unexpected ones are always reported. */
  readonly errors?: readonly ErrorKind[] | ((dependencies: ResolvedReferences<R>) => readonly ErrorKind[]) | undefined;
};

/** Sentry's own wait for pending events at shutdown when `shutdownTimeout` is not a positive number. */
const defaultShutdownTimeout = 2000;

/** The client's own `shutdownTimeout`, a native option of the runtime SDKs, as they read it themselves. */
function shutdownTimeout(client: SentryClient | undefined): number {
  const options = client?.getOptions() ?? {};
  const timeout = "shutdownTimeout" in options ? options.shutdownTimeout : undefined;
  return typeof timeout === "number" && timeout > 0 ? timeout : defaultShutdownTimeout;
}

/**
 * Captures each reported failure as a Sentry issue, tagged with where it failed. Its attributes are the issue's
 * `openknot` context: tags limit their names and suit few distinct values, which attributes such as message ids are not.
 */
function sentryReporter<Options>(sdk: SentrySdk<Options>, errors: readonly ErrorKind[] = []): ErrorReporter {
  const selected = [...errors];
  return (report) => {
    if (isReported(report, selected)) {
      sdk.withScope((scope) => {
        scope.setTag("openknot.source", report.source);
        if (report.attributes !== undefined) {
          scope.setContext("openknot", report.attributes);
        }
        sdk.captureException(report.error, { mechanism: { type: "openknot", handled: report.expected } });
      });
    }
  };
}

/** The `provideSentry` of one runtime's SDK. */
export function sentryModule<Options>(sdk: SentrySdk<Options>) {
  function provideSentry<const R extends Requirements = NoRequirements>(
    declaration: SentryModuleOptions<Options, R>,
  ): SentryModule;

  function provideSentry<const R extends Requirements>(declaration: SentryModuleOptions<Options, R>): ProvidedPlugs {
    const { options, errors = [] } = declaration;
    const requirements = declaration.requirements ?? ({} as R);

    if (typeof options !== "function") {
      throw new TypeError("provideSentry() requires options as a function of its requirements.");
    }

    // The SDK keeps one client per process, so one application owns it from startup to shutdown.
    const sentry: Provider<ManagedResource<SentryClient | undefined>, never, "resource"> = resource({
      requirements,
      initialize: async (dependencies: ResolvedReferences<R>) => {
        if (sdk.isInitialized()) {
          throw new Error(
            "Sentry is already initialized in this process: provideSentry() owns its client, so remove the other Sentry.init() or provideSentry() module.",
          );
        }
        sdk.init(options(dependencies));
        const client = sdk.getClient();
        return {
          value: client,
          async release() {
            const timeout = shutdownTimeout(client);
            // Closing through the SDK also detaches the client, so the process can own Sentry again; a client that
            // something else has since replaced is closed on its own, leaving the replacement untouched.
            if (sdk.getClient() === client) {
              await sdk.close(timeout);
            } else {
              await client?.close(timeout);
            }
          },
        };
      },
    });

    const reporter: Provider<ErrorReporter, never, "unit"> = unit({
      provides: errorReporter,
      requirements: { ...requirements, __sentry: sentry },
      factory: ({ __sentry, ...dependencies }: ResolvedReferences<R> & { readonly __sentry: unknown }) =>
        sentryReporter(sdk, typeof errors === "function" ? errors(dependencies as ResolvedReferences<R>) : errors),
    });

    return providePlugs([sentry, reporter]);
  }

  return provideSentry;
}
