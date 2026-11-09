const RecordedWriteMarker = Symbol.for("@openknot-ts/flow/recorded-write");

function markRecorded<F extends (...args: never[]) => unknown>(fn: F): F {
  Object.defineProperty(fn, RecordedWriteMarker, { value: true, enumerable: false });
  return fn;
}

function isRecorded(fn: unknown): boolean {
  return typeof fn === "function" && RecordedWriteMarker in fn && fn[RecordedWriteMarker] === true;
}

export { RecordedWriteMarker, markRecorded, isRecorded };
