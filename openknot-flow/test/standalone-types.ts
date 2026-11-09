import { standalone, writer } from "../src/index.ts";
import type {} from "../src/wire.ts";
import { plug } from "@openknot-ts/wire";

const write = writer<(id: string) => Promise<number>>();
// @ts-expect-error A writer definition is not an operation.
standalone(write);
// @ts-expect-error A binding's implementation is already the function to call.
standalone(plug({ port: write, bind: () => (id) => Promise.resolve(id.length) }));
