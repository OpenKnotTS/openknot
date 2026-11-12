import { sentryModule } from "@openknot-ts/sentry";
import * as Sentry from "@sentry/node";
import type { NodeOptions } from "@sentry/node";

export type { SentryModule, SentryModuleOptions } from "@openknot-ts/sentry";

/** Reports the application's failures to Sentry through the Node SDK. */
export const provideSentry = sentryModule<NodeOptions>(Sentry);
