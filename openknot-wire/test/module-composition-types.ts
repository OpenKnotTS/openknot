import type { Activation, DeferredModule, ModuleInput, ModuleSelection } from "../src/index.ts";
import { composeModule, defineApplication, isProvider, requiredBy, unit } from "../src/index.ts";

const provider = unit({ factory: () => 42 });
const plain = composeModule({ providers: { provider } });
const deferred = composeModule({ sources: [provider], accepts: isProvider, label: "types" });
const immediate: ModuleSelection = plain.includeOnly([provider]).exclude([provider]).when(true);
const pending: DeferredModule = deferred.includeOnly([provider]).exclude([plain]).when(true);
const mixed: ModuleInput = plain.exclude([deferred]);
const activation: Activation = plain.requiredBy(deferred);
const normalized: Activation = defineApplication({ modules: [plain] }).options.modules;
const roots: readonly ModuleInput[] = normalized.rootSelections;
void immediate;
void pending;
void mixed;
void activation;
void roots;
// @ts-expect-error Activation always declares its root module selections.
const incomplete: Activation = { selections: [plain] };
void incomplete;
const selected = requiredBy(plain);
// @ts-expect-error Activation metadata is immutable.
selected.rootSelections.push(deferred);
