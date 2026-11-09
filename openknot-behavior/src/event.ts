/** A domain fact. Delivery metadata belongs to the publication envelope. */
export interface Event<Type extends string = string> {
  readonly type: Type;
}
