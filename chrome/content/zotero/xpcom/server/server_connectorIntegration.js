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
		var timeoutMs = (data && data.timeoutMs) || 30000;
		try {
			var result = await Zotero.Promise.race([
				req.resultDeferred.promise,
				Zotero.Promise.delay(timeoutMs).then(() => {
					throw new Error('Headless request timed out after ' + timeoutMs + 'ms');
				})
			]);
			sendResponse(200, 'application/json', JSON.stringify({ result }));
		}
		catch (e) {
			sendResponse(500, 'application/json', JSON.stringify({ error: e.message }));
		}
		finally {
			if (Zotero.Integration.pendingHeadlessRequest === req) {
				Zotero.Integration.pendingHeadlessRequest = null;
			}
		}
	}
};
