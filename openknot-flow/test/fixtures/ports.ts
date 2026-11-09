import { listener } from "../../src/index.ts";
import { success } from "@openknot-ts/behavior";

export const onNumber = listener<number>()({ requirements: {}, run: (input) => success(input) });
