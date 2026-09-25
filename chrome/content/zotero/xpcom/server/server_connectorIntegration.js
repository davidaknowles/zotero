/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2017 Center for History and New Media
					George Mason University, Fairfax, Virginia, USA
					http://zotero.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

/**
 * Adds integration endpoints related to doc integration via HTTP/connector.
 * 
 * document/execCommand initiates an integration command and responds with the
 * next request for the http client (e.g. 'Application.getDocument').
 * The client should respond to document/respond with the payload and expect
 * another response with the next request, until it receives 'Document.complete'
 * at which point the integration transaction is considered complete.
 */
Zotero.Server.Endpoints['/connector/document/execCommand'] = function() {};
Zotero.Server.Endpoints['/connector/document/execCommand'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	init: function(data, sendResponse) {
		if (Zotero.HTTPIntegrationClient.inProgress) {
			// This will focus the last integration window if present
			Zotero.Integration.execCommand('http', data.command, data.docId);
			sendResponse(503, 'text/plain', 'Integration transaction is already in progress')
			return;
		}
		Zotero.HTTPIntegrationClient.inProgress = true;
		Zotero.HTTPIntegrationClient.sendResponse = sendResponse;
		Zotero.Integration.execCommand('http', data.command, data.docId);
	},
};

Zotero.Server.Endpoints['/connector/document/respond'] = function() {};
Zotero.Server.Endpoints['/connector/document/respond'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	
	init: function (data, sendResponse) {
		// Earlier version of the gdocs plugin used to double-encode the JSON data
		try {
			data = JSON.parse(data);
		}
		catch (e) {}
		if (data && data.error) {
			// Apps Script stack is a JSON object
			let error = new Error("HTTP Integration Error");
			if (typeof data.stack != "string") {
				data.stack = JSON.stringify(data.stack);
			}
			if (data.error == 'Alert') {
				error = new Zotero.Exception.Alert(data.message);
				error.stack = data.stack;
			}
			else if (data.error == 'Tab Not Available Error') {
				let client = Zotero.Integration.currentDoc.processorName || 'Google Docs';
				error = new Zotero.Exception.Alert(Zotero.getString('integration.error.tabUnavailable', client));
				error.stack = data.stack;
			}
			Zotero.HTTPIntegrationClient.deferredResponse.reject(error);
		} else {
			Zotero.HTTPIntegrationClient.deferredResponse.resolve(data);
		}
		Zotero.HTTPIntegrationClient.sendResponse = sendResponse;
	}
};

// For managing macOS integration and progress window focus
Zotero.Server.Endpoints['/connector/sendToBack'] = function() {};
Zotero.Server.Endpoints['/connector/sendToBack'].prototype = {
	supportedMethods: ["POST", "GET"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	init: function (requestData) {
		Zotero.Utilities.Internal.sendToBack();
		return 200;
	},
};

/**
 * ---- zotero.ai headless citation extension ----
 *
 * Exposes Zotero's LOCAL library ID for the user's personal library (Zotero.Libraries.
 * userLibraryID -- an internal SQLite auto-increment id, essentially always 1, but not a value
 * a browser extension can otherwise know or safely hardcode).
 *
 * This exists because of a real, reproduced bug: items synced via the Zotero Web API report
 * their `library.id` as the user's actual numeric Zotero.org account id (e.g. 1234567) -- a
 * completely different number from the LOCAL libraryID Zotero desktop uses to look items up.
 * Passing THAT web-API id as addCitationHeadless's citationItems[].libraryID inserted a citation
 * field (visibly stuck as the placeholder "{Updating}", its field code left empty -- confirmed
 * via Document.getFields returning `"code":""` right after insert) that Zotero then couldn't
 * resolve, surfacing as "An item in this document is missing from your Zotero library." The
 * companion extension now fetches this once and substitutes it for the web API's library id
 * before calling addCitationHeadless -- see zotero-local-server.js's getUserLibraryID().
 */
Zotero.Server.Endpoints['/connector/getUserLibraryID'] = function() {};
Zotero.Server.Endpoints['/connector/getUserLibraryID'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	allowRequestsFromUnsafeWebContent: true,
	init: function (data, sendResponse) {
		sendResponse(200, 'application/json', JSON.stringify({ libraryID: Zotero.Libraries.userLibraryID }));
	}
};

/**
 * ---- zotero.ai headless citation extension ----
 *
 * These two endpoints let a third-party browser extension drive
 * Zotero.Integration.Interface#addCitationHeadless / #getFieldsHeadless (see integration.js)
 * without opening the interactive citation dialog. The existing document/execCommand
 * protocol has no room for a structured payload or a return value (it only carries a
 * document-edit RPC handshake), so headless callers stash their request here first, then
 * trigger the command by dispatching the same 'Zotero.Integration.execCommand' window event
 * the official Google Docs plugin uses (see zotero-google-docs-integration's googleDocs.js),
 * then poll/await this endpoint for the result.
 *
 * Only one headless request is tracked at a time, mirroring the existing single-flight
 * constraint on HTTP integration commands (Zotero.HTTPIntegrationClient.inProgress).
 */
Zotero.Server.Endpoints['/connector/document/setHeadlessRequest'] = function() {};
Zotero.Server.Endpoints['/connector/document/setHeadlessRequest'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	// Called directly (fetch, not via zotero-connectors) by the zotero.ai companion extension's
	// background service worker, which has a plain browser User-Agent -- opt in explicitly.
	// See the security note at the top of this section: without also getting our content
	// script to fire the matching execCommand event in a real docs.google.com tab (which no
	// unrelated page can do), stashed data here has no effect, so this is no more sensitive
	// than the existing browser-reachable endpoints in this file/server_connector.js.
	allowRequestsFromUnsafeWebContent: true,
	init: function (data, sendResponse) {
		Zotero.Integration.pendingHeadlessRequest = {
			data: data || {},
			resultDeferred: Zotero.Promise.defer()
		};
		sendResponse(200, 'application/json', JSON.stringify({ ok: true }));
	}
};

/**
 * ---- zotero.ai headless citation extension ----
 *
 * IMPORTANT: this used to hold the HTTP response open for up to `timeoutMs` (previously
 * 15-30s) via Promise.race, on the assumption that Zotero's HTTP server (see server.js -- "a
 * very rudimentary web server" built on Mozilla's httpd.sys.mjs) could still service other
 * connector requests concurrently while this one was pending. That assumption was wrong:
 * confirmed in practice that even the official Zotero Connector's own unrelated
 * /connector/ping requests (nothing to do with document integration) timed out for the exact
 * duration a headless getHeadlessResult call was held open. That's a deadlock -- the
 * addCitationHeadless/getFieldsHeadless round trip itself depends on Zotero's server being able
 * to receive the official connector's execCommand/respond traffic, which our own long-held
 * connection was blocking.
 *
 * Fixed by making this endpoint itself short-poll: wait at most a couple seconds server-side,
 * then respond either with the real result or {pending: true}, and let the CLIENT (zotero.ai's
 * background service worker, see zotero-local-server.js) do the long-waiting by calling this
 * repeatedly. Each individual HTTP round trip is now short, so Zotero's server always has room
 * to interleave other connector traffic between our polls.
 */
Zotero.Server.Endpoints['/connector/document/getHeadlessResult'] = function() {};
Zotero.Server.Endpoints['/connector/document/getHeadlessResult'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	allowRequestsFromUnsafeWebContent: true,
	init: async function (data, sendResponse) {
		var req = Zotero.Integration.pendingHeadlessRequest;
		if (!req) {
			sendResponse(404, 'application/json', JSON.stringify({ error: 'No pending headless request' }));
			return;
		}
		// Capped well below the old 15-30s -- this is now just "how long to wait before telling
		// the client to come back and ask again", not the overall deadline (the client tracks
		// that itself across repeated calls).
		var pollMs = Math.min((data && data.pollMs) || 1500, 2000);
		var settled = false;
		try {
			var outcome = await Zotero.Promise.race([
				req.resultDeferred.promise.then(result => ({ done: true, result })),
				Zotero.Promise.delay(pollMs).then(() => ({ done: false }))
			]);
			settled = outcome.done;
			if (!outcome.done) {
				sendResponse(200, 'application/json', JSON.stringify({ pending: true }));
				return;
			}
			sendResponse(200, 'application/json', JSON.stringify({ result: outcome.result }));
		}
		catch (e) {
			settled = true; // an actual error (not a mere "still pending") -- don't leave it stuck
			sendResponse(500, 'application/json', JSON.stringify({ error: e.message }));
		}
		finally {
			// Only clear the pending request once it's actually settled -- for a still-pending
			// outcome we deliberately leave it in place, since the underlying command is still
			// running and the client's next poll needs to find the same request again.
			if (settled && Zotero.Integration.pendingHeadlessRequest === req) {
				Zotero.Integration.pendingHeadlessRequest = null;
			}
		}
	}
};

/**
 * ---- zotero.ai headless citation extension ----
 *
 * Escape hatch for Zotero's own Integration single-flight guard (Zotero.Integration.
 * currentDoc), which has no timeout of its own: if a headless command's browser-side round
 * trip never completes (the multi-step execCommand/respond handshake can, in practice,
 * occasionally not make it all the way back -- see the zotero.ai companion extension's
 * zotero-local-server.js for the full explanation), currentDoc is left permanently true and
 * every subsequent integration command -- ours or a normal interactive one -- hits the "A
 * word processor integration command is already running" alert forever, until Zotero is
 * restarted. The companion extension calls this after ITS OWN getHeadlessResult call times
 * out, on the assumption that a timeout on our side means our own command is what's stuck.
 *
 * This is blunt (it does not try to distinguish "our command hung" from "a real interactive
 * dialog is legitimately still open"), so it is only ever called automatically after our own
 * timeout, never speculatively.
 */
Zotero.Server.Endpoints['/connector/document/forceResetIntegration'] = function() {};
Zotero.Server.Endpoints['/connector/document/forceResetIntegration'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	allowRequestsFromUnsafeWebContent: true,
	init: function (data, sendResponse) {
		// If the official connector's own execCommand/respond HTTP request is still open and
		// waiting on us (Zotero.HTTPIntegrationClient.sendResponse is how that pending
		// connection eventually gets completed -- see httpIntegrationClient.js's sendCommand),
		// resolve it with an error rather than just resetting our state out from under it and
		// leaving that request to hang forever from the connector's side too.
		if (Zotero.HTTPIntegrationClient.inProgress && Zotero.HTTPIntegrationClient.sendResponse) {
			try {
				Zotero.HTTPIntegrationClient.sendResponse(500, 'application/json',
					JSON.stringify({ error: 'Integration was force-reset (see forceResetIntegration)' }));
			}
			catch (e) {
				Zotero.debug('[zotero.ai] forceResetIntegration: failed to complete dangling sendResponse: ' + e.message);
			}
		}
		Zotero.Integration.currentDoc = false;
		Zotero.Integration.currentWindow = false;
		Zotero.Integration.currentSession = false;
		Zotero.Integration.currentIsHeadless = false;
		Zotero.HTTPIntegrationClient.inProgress = false;
		Zotero.Integration.pendingHeadlessRequest = null;
		// ---- zotero.ai headless citation extension ----
		// Root-caused a wedge that survived every other reset here, a browser page reload, and
		// even toggling the official connector extension off/on -- only a full Zotero restart
		// cleared it, which was the tell that the stuck state lived in Zotero's own process
		// memory, not the browser side at all. httpIntegrationClient.js's sendCommand() chains
		// EVERY call (across ALL documents/tabs -- it's a single module-level variable, not
		// per-session) onto this one promise: `sendCommandPromise = sendCommandPromise.then(...)`.
		// If a single sendCommand's response never lands (the multi-step execCommand/respond
		// handshake not making it all the way back -- see the note above), that promise never
		// settles, and every future Application.getActiveDocument() (the first sendCommand of
		// any execCommand, ours or interactive) queues behind the dead one forever -- with zero
		// Document.*/Application.* traffic ever appearing, since sendCommand() never even gets
		// far enough to call sendResponse() for the new request. None of the flags above touch
		// this, so resetting them alone never actually cleared it.
		if (Zotero.HTTPIntegrationClient.sendCommandPromise) {
			Zotero.HTTPIntegrationClient.sendCommandPromise = Promise.resolve();
		}
		sendResponse(200, 'application/json', JSON.stringify({ ok: true }));
	}
};

/**
 * ---- zotero.ai headless citation extension ----
 *
 * The preview popover's "View in Zotero" button used to open a zotero://select/... URL, which
 * goes through the OS's own custom-URL-scheme handler -- and on a dev machine with both a
 * normal Zotero install and this patched fork present, that handler is registered to whichever
 * one the OS picked (confirmed: not reliably the one actually running). Since the companion
 * extension already has a direct HTTP connection to exactly the running instance we want, this
 * sidesteps the OS entirely and asks that instance to select the item itself.
 */
Zotero.Server.Endpoints['/connector/selectItem'] = function() {};
Zotero.Server.Endpoints['/connector/selectItem'].prototype = {
	supportedMethods: ["POST"],
	supportedDataTypes: ["application/json"],
	permitBookmarklet: true,
	allowRequestsFromUnsafeWebContent: true,
	init: async function (data, sendResponse) {
		try {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(data.libraryID, data.key);
			if (!item) {
				sendResponse(404, 'application/json', JSON.stringify({ error: 'Item not found' }));
				return;
			}
			let win = Zotero.getMainWindow();
			if (!win) {
				sendResponse(500, 'application/json', JSON.stringify({ error: 'No open Zotero window' }));
				return;
			}
			Zotero.Utilities.Internal.activate(win);
			await win.ZoteroPane.selectItem(item.id);
			sendResponse(200, 'application/json', JSON.stringify({ ok: true }));
		}
		catch (e) {
			sendResponse(500, 'application/json', JSON.stringify({ error: e.message }));
		}
	}
};
