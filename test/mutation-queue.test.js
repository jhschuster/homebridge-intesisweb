/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const {MutationQueue} = require("../lib/device/mutation-queue");

test("MutationQueue runs actions FIFO and completes each callback once", async () => {
    const queue = new MutationQueue();
    const events = [];
    const first = new Promise(resolve => {
	queue.enqueue(finish => {
	    events.push("first:start");
	    queueMicrotask(() => {
		events.push("first:end");
		finish();
		finish(Error("ignored"));
	    });
	}, error => resolve(error));
    });
    const second = new Promise(resolve => {
	queue.enqueue(finish => {
	    events.push("second");
	    finish();
	}, error => resolve(error));
    });
    assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
    assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("MutationQueue continues after synchronous exceptions", async () => {
    const queue = new MutationQueue();
    const failure = new Promise(resolve => {
	queue.enqueue(() => { throw Error("boom"); }, resolve);
    });
    const success = new Promise(resolve => {
	queue.enqueue(finish => finish(), resolve);
    });
    assert.match((await failure).message, /boom/);
    assert.equal(await success, undefined);
});
