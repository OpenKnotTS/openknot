export function managedIdentity(value: unknown): { entity: string; id: string | number | bigint } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const entity: unknown = Object.getOwnPropertyDescriptor(value, "entity")?.value;
  const id: unknown = Object.getOwnPropertyDescriptor(value, "id")?.value;

  if (typeof entity !== "string" || entity.length === 0) {
    return undefined;
  }

  if (typeof id === "string" || typeof id === "bigint" || (typeof id === "number" && Number.isFinite(id))) {
    return { entity, id };
  }
  return undefined;
}

export function isList(value: unknown): boolean {
  if (Array.isArray(value)) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "items" in value && Array.isArray(value.items);
}

export function itemsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "object" || value === null) {
    return value === undefined || value === null ? [] : [value];
  }

  if ("items" in value && Array.isArray(value.items)) {
    return value.items;
  }
  return [value];
}

export function versionOf(state: unknown): number | undefined {
  if (typeof state !== "object" || state === null) {
    return undefined;
  }

  const version = Object.getOwnPropertyDescriptor(state, "version")?.value;

  return typeof version === "number" ? version : undefined;
}
