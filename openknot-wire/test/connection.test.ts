import { connectionWatch } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

test("a connection watch reports each outage once to every watcher and listens only while watched", () => {
  const client = new EventEmitter();
  const watched = connectionWatch(({ lost, restored }) => {
    client.on("down", lost);
    client.on("up", restored);
    return () => {
      client.off("down", lost);
      client.off("up", restored);
    };
  });
  assert.equal(client.listenerCount("down"), 0);
  const seen: string[] = [];
  const stopFirst = watched.watch({ lost: () => seen.push("first lost"), restored: () => seen.push("first restored") });
  const stopSecond = watched.watch({
    lost: () => seen.push("second lost"),
    restored: () => seen.push("second restored"),
  });
  assert.deepEqual([client.listenerCount("down"), client.listenerCount("up")], [1, 1]);

  client.emit("up");
  client.emit("down");
  client.emit("down");
  client.emit("up");
  client.emit("up");
  assert.deepEqual(seen, ["first lost", "second lost", "first restored", "second restored"]);

  stopFirst();
  stopFirst();
  assert.deepEqual([client.listenerCount("down"), client.listenerCount("up")], [1, 1]);
  stopSecond();
  assert.deepEqual([client.listenerCount("down"), client.listenerCount("up")], [0, 0]);
});

test("a watcher that attaches after the last one left during an outage sees the next outage", () => {
  const client = new EventEmitter();
  const watched = connectionWatch(({ lost, restored }) => {
    client.on("down", lost);
    client.on("up", restored);
    return () => {
      client.off("down", lost);
      client.off("up", restored);
    };
  });
  const stop = watched.watch({ lost: () => undefined, restored: () => undefined });
  client.emit("down");
  stop();
  // The connection came back while nothing watched it.
  client.emit("up");
  const seen: string[] = [];
  watched.watch({ lost: () => seen.push("lost"), restored: () => seen.push("restored") });
  assert.equal(client.listenerCount("down"), 1);
  client.emit("down");
  client.emit("up");
  assert.deepEqual(seen, ["lost", "restored"]);
});
