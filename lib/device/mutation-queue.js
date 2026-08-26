/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

/** Serializes per-device HomeKit mutations without stalling after failures. */
class MutationQueue {
    /** Initializes an already-resolved FIFO tail. */
    constructor() {
	this.tail = Promise.resolve();
    }

    /** Queues one callback-style mutation and completes its callback at most once. */
    enqueue(action, callback) {
	let callbackCompleted = false;
	/** Forwards only the first completion result to HomeKit. */
	const completeCallback = err => {
	    if (callbackCompleted) return;
	    callbackCompleted = true;
	    callback(err);
	};
	/** Runs one queued callback-style action as a settled promise. */
	const run = () => new Promise(resolve => {
	    let actionCompleted = false;
	    /** Settles this queue entry once, even if its action finishes twice. */
	    const finish = err => {
		if (actionCompleted) return;
		actionCompleted = true;
		try {
		    completeCallback(err);
		}
		finally {
		    resolve();
		}
	    };
	    try {
		action(finish);
	    }
	    catch (err) {
		finish(err);
	    }
	});
	// Use the same continuation after resolve or reject so one bad mutation
	// cannot strand subsequent commands.
	this.tail = this.tail.then(run, run);
    }
}

module.exports = {MutationQueue};
