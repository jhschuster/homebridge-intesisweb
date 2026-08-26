/*
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 * Additional work Copyright 2026 Armando DiCianno
 */

/** Omits arbitrary messages/bodies; logs a bounded-format name and integer status. */
function safeRequestError(err) {
    const candidate = err && typeof err.name === "string" ? err.name : "";
    const name = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(candidate) ? candidate : "Error";
    const statusCode = err && err.response && err.response.statusCode;
    return {name, statusCode: Number.isInteger(statusCode) ? statusCode : ""};
}

/** Owns AC Cloud HTTP session, authentication, reads, and callback writes. */
class IntesisCloudClient {
    /** Creates a client, allowing transport boundaries to be injected by tests. */
    constructor(log, config, dependencies = {}) {
	this.log = log;
	this.username = config["username"];
	this.password = config["password"];
	this.loggedIn = false;
	this.lastLogin = null;
	// Resolve production dependencies only when a caller did not inject the
	// corresponding boundary. Missing runtime packages still throw their native
	// MODULE_NOT_FOUND error in production; focused tests can remain isolated.
	const CookieJar = dependencies.CookieJar || require("tough-cookie").CookieJar;
	const transport = dependencies.got || require("got");
	this.cookieJar = new CookieJar();
	this.got = transport.extend({
	    prefixUrl: config["apiBaseURL"] || "https://accloud.intesis.com/",
	    resolveBodyOnly: true,
	    headers: {
		"user-agent": undefined
	    }
	});
    }

    /** Authenticates the cookie-backed web session without logging form data. */
    async doLogin() {
	this.log.debug("IntesisCloudClient.doLogin() called.");
	let body = await this.got
	    .get("login", {cookieJar: this.cookieJar})
	    .catch(err => {
		const safe = safeRequestError(err);
		this.log("GET /login", safe.name, safe.statusCode);
		return null;
	    });
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	    return this.loggedIn;
	}
	this.log.debug("GET /login OK");
	const match = body.match(/signin\[_csrf_token\]" value="([^"]+)"/);
	if (!match) {
	    if (body.match(/<div id="project-main-menu">/)) {
		this.log.debug("Already logged in!");
		this.lastLogin = new Date().getTime();
		this.loggedIn = true;
	    }
	    else {
		// Never log the response body: login pages may contain session data.
		this.log.error("PARSE ERROR: Failed to match pattern for csrf or post-login screen");
		this.log.error(`Response body length: ${body.length} chars`);
		this.loggedIn = false;
	    }
	    return this.loggedIn;
	}

	const csrf = match[1];
	body = await this.got
	    .post({
		url: "login",
		form: {
		    "signin[username]": this.username,
		    "signin[password]": this.password,
		    "signin[_csrf_token]": csrf
		}
	    }, {cookieJar: this.cookieJar})
	    .catch(err => {
		const safe = safeRequestError(err);
		this.log("POST /login", safe.name, safe.statusCode);
		return err.response && err.response.statusCode === 302 ? err.response.body : null;
	    });
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	}
	// A successful POST may still return the login page with a fresh token;
	// treating non-empty HTML as success would cause an authentication loop.
	else if (this.isLoginForm(body)) {
	    this.log("POST /login returned login form; credentials were not accepted.");
	    this.loggedIn = false;
	}
	else {
	    this.log.debug("POST /login OK");
	    this.lastLogin = new Date().getTime();
	    this.loggedIn = true;
	}
	return this.loggedIn;
    }

    /** Identifies login-form HTML without extracting or exposing its token. */
    isLoginForm(body) {
	return typeof body === "string" && (
	    /signin\[_csrf_token\]"\s+value="[^"]+"/.test(body)
	    || /signin\[(?:username|password)\]/.test(body)
	    || /<form[^>]+(?:action=["'][^"']*login|id=["'][^"']*login)/i.test(body));
    }

    /** Fetches the device-list header page and detects session expiry. */
    async getHeaders() {
	this.log.debug("IntesisCloudClient.getHeaders() called.");
	const body = await this.got
	    .get("panel/headers", {cookieJar: this.cookieJar})
	    .catch(err => {
		const safe = safeRequestError(err);
		this.log("GET /panel/headers", safe.name, safe.statusCode);
		return null;
	    });
	if (!body) {
	    this.loggedIn = false;
	    return null;
	}
	else if (body.match(/<title>/)) {
	    this.log.debug("GET /panel/headers LOGIN");
	    this.loggedIn = false;
	    return null;
	}
	this.log.debug("GET /panel/headers OK");
	return body;
    }

    /** Fetches one raw device view, returning null on expiry or request failure. */
    async getVista(deviceID) {
	return this.got
	    .get("panel/vista?id=" + deviceID, {cookieJar: this.cookieJar})
	    .then(body => {
		if (body.match(/<title>/)) {
		    this.log.debug(`/panel/vista?id=${deviceID} returned login page; session expired`);
		    this.loggedIn = false;
		    return null;
		}
		this.log.debug(`/panel/vista?id=${deviceID}`, "OK");
		return body;
	    })
	    .catch(err => {
		const safe = safeRequestError(err);
		this.log(`/panel/vista?id=${deviceID}`, safe.name, safe.statusCode);
		return null;
	    });
    }

    /** Writes one Intesis UID while preserving the legacy callback interface. */
    async setValue(userID, deviceID, serviceID, value, callback) {
	if (!userID) {
	    callback(Error("setValue: No userID supplied."));
	    return;
	}
	if (!deviceID) {
	    callback(Error("setValue: No deviceID supplied."));
	    return;
	}
	if (!serviceID) {
	    callback(Error("setValue: No serviceID supplied."));
	    return;
	}
	// Deliberately omit credentials, user IDs, cookies, response bodies, and
	// tokens from logs. Device/service/value are sufficient for diagnostics.
	this.log.debug("setValue:", `device=${deviceID} uid=${serviceID} value=${value}`);
	const body = await this.got
	    .post({
		url: "device/setVal",
		headers: {"X-Requested-With": "XMLHttpRequest"},
		searchParams: {
		    id: deviceID,
		    uid: serviceID,
		    value,
		    userId: userID
		}
	    }, {cookieJar: this.cookieJar})
	    .catch(err => {
		const safe = safeRequestError(err);
		this.log("POST /device/setVal", safe.name, safe.statusCode);
		return null;
	    });
	this.log.debug(body ? "POST device/setVal OK" : "POST device/setVal FAILED");
	callback(body ? undefined : Error("setValue: POST failed"));
    }
}

module.exports = {IntesisCloudClient};
