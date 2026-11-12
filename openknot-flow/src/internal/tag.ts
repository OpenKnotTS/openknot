/** A definition's name in execution logs and spans; definitions are identified by reference, so it is optional. */
export interface TagOptions {
  readonly tag?: string;
}

export function snapshotTag(options: TagOptions): TagOptions {
  const tag = options.tag;

  if (tag === undefined) {
    return {};
  }

  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new TypeError("tag must be a non-empty string");
  }
  
  return { tag };
}

export function tagOf(reference: object): string | undefined {
  return "tag" in reference && typeof reference.tag === "string" ? reference.tag : undefined;
}
