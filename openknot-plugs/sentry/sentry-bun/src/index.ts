import { sentryModule } from "@openknot-ts/sentry";
import * as Sentry from "@sentry/bun";
import type { BunOptions } from "@sentry/bun";

export type { SentryModule, SentryModuleOptions } from "@openknot-ts/sentry";

/** Reports the application's failures to Sentry through the Bun SDK. */
export const provideSentry = sentryModule<BunOptions>(Sentry);
