export interface AppActor {
  readonly userId: string;
}

declare module "@openknot-ts/flow" {
  interface ExecutionTypes {
    readonly actor: AppActor;
  }
}
