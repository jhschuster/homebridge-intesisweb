/*
 * MIT License
 *
 * Copyright 2026 Armando DiCianno
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const {IntesisCloudClient} = require("../lib/cloud-client");

/** Creates a Homebridge-shaped logger that records every level. */
function recordingLog() {
    const entries = [];
    /** Serializes one log call for redaction assertions. */
    const record = (...values) => entries.push(values.map(String).join(" "));
    record.debug = record;
    record.error = record;
    return {log: record, entries};
}

test("cloud client never logs login bodies, credentials, tokens, or failed response bodies", async () => {
    const loginBody = "<html>session-token=TOP_SECRET_TOKEN username=private-user password=private-pass</html>";
    const failedBody = "FAILED_BODY_WITH_SESSION_TOKEN";
    const transport = {
	/** Supplies a deterministic failing HTTP client. */
	extend() {
	    return {
		get: async () => loginBody,
		post: async () => {
		    const error = Error("request failed");
		    error.response = {statusCode: 500, body: failedBody};
		    throw error;
		}
	    };
	}
    };
    const {log, entries} = recordingLog();
    const client = new IntesisCloudClient(log, {
	username: "private-user",
	password: "private-pass"
    }, {CookieJar: class CookieJar {}, got: transport});

    assert.equal(await client.doLogin(), false);
    const writeError = await new Promise(resolve => {
	client.setValue("private-user-id", "device-1", 4, 2, resolve);
    });
    assert.match(writeError.message, /POST failed/);

    const output = entries.join("\n");
    for (const secret of [
	loginBody,
	failedBody,
	"TOP_SECRET_TOKEN",
	"private-user",
	"private-pass",
	"private-user-id"
    ]) {
	assert.equal(output.includes(secret), false, `log output exposed ${secret}`);
    }
    assert.match(output, /Response body length:/);
    assert.match(output, /POST \/device\/setVal Error 500/);
});

test("cloud client rejects a CSRF login form returned by POST", async () => {
    const firstToken = "FIRST_CSRF_SECRET";
    const secondToken = "SECOND_CSRF_SECRET";
    /** Builds a token-bearing login form for rejection checks. */
    const loginForm = token => `<form action="/login"><input name="signin[_csrf_token]" value="${token}"></form>`;
    const transport = {
	/** Supplies a client that returns a second login form after POST. */
	extend() {
	    return {
		get: async () => loginForm(firstToken),
		post: async () => loginForm(secondToken)
	    };
	}
    };
    const {log, entries} = recordingLog();
    const client = new IntesisCloudClient(log, {
	username: "wrong-user",
	password: "wrong-password"
    }, {CookieJar: class CookieJar {}, got: transport});

    assert.equal(await client.doLogin(), false);
    assert.equal(client.loggedIn, false);
    const output = entries.join("\n");
    assert.match(output, /returned login form/);
    assert.equal(output.includes(firstToken), false);
    assert.equal(output.includes(secondToken), false);
    assert.equal(output.includes("wrong-user"), false);
    assert.equal(output.includes("wrong-password"), false);
});

test("cloud client completes login, discovery reads, and writes with one cookie jar", async () => {
    const calls = [];
    const jar = {kind: "cookie-jar"};
    const transport = {
	/** Records successful request arguments for session-boundary assertions. */
	extend() {
	    return {
		/** Returns login, header, or device-view fixtures by request path. */
		async get(path, options) {
		    calls.push({method: "get", path, options});
		    if (path === "login") {
			return '<input name="signin[_csrf_token]" value="csrf-value">';
		    }
		    if (path === "panel/headers") return '<div id="deviceHeader_1">headers</div>';
		    return "device-view";
		},
		/** Returns successful login and device-write fixtures. */
		async post(request, options) {
		    calls.push({method: "post", request, options});
		    return request.url === "login" ? '<div id="project-main-menu">panel</div>' : "ok";
		}
	    };
	}
    };
    const {log} = recordingLog();
    const client = new IntesisCloudClient(log, {
	username: "account-name",
	password: "account-password",
	apiBaseURL: "https://example.invalid/"
    }, {CookieJar: class CookieJar { constructor() { return jar; } }, got: transport});

    assert.equal(await client.doLogin(), true);
    assert.equal(client.loggedIn, true);
    assert.equal(typeof client.lastLogin, "number");
    assert.match(await client.getHeaders(), /deviceHeader/);
    assert.equal(await client.getVista("device-1"), "device-view");
    assert.equal(await new Promise(resolve => client.setValue("user-1", "device-1", 4, 2, resolve)), undefined);
    assert.equal(calls.every(call => (call.options || call.request)?.cookieJar === jar), true);
    const loginPost = calls.find(call => call.method === "post" && call.request.url === "login");
    assert.equal(loginPost.request.form["signin[username]"], "account-name");
    const valuePost = calls.find(call => call.method === "post" && call.request.url === "device/setVal");
    assert.deepEqual(valuePost.request.searchParams, {
	id: "device-1", uid: 4, value: 2, userId: "user-1"
    });
});

test("cloud client recognizes an existing session and rejects unrecognized login markup", async () => {
    let loginBody = '<div id="project-main-menu">panel</div>';
    const transport = {
	/** Returns the selected login-page fixture. */
	extend() {
	    return {get: async () => loginBody, post: async () => { throw Error("unexpected post"); }};
	}
    };
    const {log} = recordingLog();
    const client = new IntesisCloudClient(log, {}, {
	CookieJar: class CookieJar {}, got: transport
    });

    assert.equal(await client.doLogin(), true);
    loginBody = "<html>unrecognized</html>";
    assert.equal(await client.doLogin(), false);
    assert.equal(client.loggedIn, false);
});

test("cloud login handles GET, POST, and redirect-response failures safely", async () => {
    const csrfPage = '<input name="signin[_csrf_token]" value="PRIVATE_CSRF">';
    let getFailure = true;
    let redirectBody = null;
    const transport = {
	/** Exercises rejected GET and POST paths without exposing error messages. */
	extend() {
	    return {
		/** Rejects or returns the configured login-page fixture. */
		async get() {
		    if (getFailure) throw Error("PRIVATE_GET_MESSAGE");
		    return csrfPage;
		},
		/** Rejects with a configured HTTP response fixture. */
		async post() {
		    const error = Error("PRIVATE_POST_MESSAGE");
		    error.response = {statusCode: redirectBody ? 302 : 500, body: redirectBody};
		    throw error;
		}
	    };
	}
    };
    const {log, entries} = recordingLog();
    const client = new IntesisCloudClient(log, {username: "PRIVATE_USER", password: "PRIVATE_PASSWORD"}, {
	CookieJar: class CookieJar {}, got: transport
    });

    assert.equal(await client.doLogin(), false);
    getFailure = false;
    assert.equal(await client.doLogin(), false);
    redirectBody = '<div id="project-main-menu">panel</div>';
    assert.equal(await client.doLogin(), true);
    const output = entries.join("\n");
    for (const marker of [
	"PRIVATE_GET_MESSAGE", "PRIVATE_POST_MESSAGE", "PRIVATE_CSRF", "PRIVATE_USER", "PRIVATE_PASSWORD"
    ]) assert.equal(output.includes(marker), false);
});

test("cloud reads expire the session on login pages and request failures", async () => {
    let response = "<title>Login</title>";
    const requestError = Object.assign(Error("PRIVATE_MESSAGE"), {
	name: "Invalid secret shaped name!",
	response: {statusCode: 503, body: "PRIVATE_BODY"}
    });
    const transport = {
	/** Switches between login-page and rejected request fixtures. */
	extend() {
	    return {get: async () => {
		if (response instanceof Error) throw response;
		return response;
	    }};
	}
    };
    const {log, entries} = recordingLog();
    const client = new IntesisCloudClient(log, {}, {
	CookieJar: class CookieJar {}, got: transport
    });
    client.loggedIn = true;

    assert.equal(await client.getHeaders(), null);
    assert.equal(client.loggedIn, false);
    client.loggedIn = true;
    assert.equal(await client.getVista("device-1"), null);
    assert.equal(client.loggedIn, false);
    response = requestError;
    assert.equal(await client.getHeaders(), null);
    assert.equal(await client.getVista("device-1"), null);
    const output = entries.join("\n");
    assert.equal(output.includes("PRIVATE_MESSAGE"), false);
    assert.equal(output.includes("PRIVATE_BODY"), false);
    assert.match(output, /Error 503/);
});

test("cloud writes validate identifiers before making a request", async () => {
    let postCalls = 0;
    const transport = {
	/** Exposes a transport that must remain unused for invalid writes. */
	extend() {
	    return {post: async () => { postCalls += 1; return "ok"; }};
	}
    };
    const {log} = recordingLog();
    const client = new IntesisCloudClient(log, {}, {
	CookieJar: class CookieJar {}, got: transport
    });
    /** Converts the callback write API into a promise. */
    const write = (...args) => new Promise(resolve => client.setValue(...args, resolve));

    assert.match((await write(null, "device", 1, 1)).message, /No userID/);
    assert.match((await write("user", null, 1, 1)).message, /No deviceID/);
    assert.match((await write("user", "device", null, 1)).message, /No serviceID/);
    assert.equal(postCalls, 0);
});
