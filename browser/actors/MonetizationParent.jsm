/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["MonetizationParent"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const gMonetization = new (class MonetizationService {
  constructor() {
    /** @type {Map<string, { state: "active" | "paused" }>} sessionId => info */
    this.activeSessions = new Map();
  }

  start({ sessionId, spspResponse }) {
    this.activeSessions.set(sessionId, { state: "active" });
    const data = { sessionId, spspResponse };
    Services.obs.notifyObservers(
      null,
      "monetization:start",
      JSON.stringify(data)
    );
  }

  stop({ sessionId }) {
    if (this.activeSessions.has(sessionId)) {
      this.activeSessions.delete(sessionId);
      Services.obs.notifyObservers(null, "monetization:stop", sessionId);
    }
  }

  pause({ sessionId }) {
    if (this.activeSessions.get(sessionId)?.state === "active") {
      this.activeSessions.get(sessionId).state = "paused";
      Services.obs.notifyObservers(null, "monetization:pause", sessionId);
    }
  }

  resume({ sessionId }) {
    if (this.activeSessions.get(sessionId)?.state === "paused") {
      this.activeSessions.get(sessionId).state = "active";
      Services.obs.notifyObservers(null, "monetization:resume", sessionId);
    }
  }
})();

class MonetizationParent extends JSWindowActorParent {
  actorCreated() {
    this.monetizationSessionId = null;
    this._monetizationRefreshCallback = async (subject, topic, sessionId) => {
      const res = await this.sendQuery(
        "monetization:refresh:request",
        sessionId
      );
      if (res && res.oldSessionId === sessionId) {
        Services.obs.notifyObservers(
          null,
          "monetization:refresh:response",
          JSON.stringify(res)
        );
      }
    };
    Services.obs.addObserver(
      this._monetizationRefreshCallback,
      "monetization:refresh"
    );

    this._monetizationCompleteCallback = (subject, topic, data) => {
      const res = JSON.parse(data);
      if (res.sessionId === this.monetizationSessionId) {
        this.sendAsyncMessage("monetization:complete:request", res);
      }
    };
    Services.obs.addObserver(
      this._monetizationCompleteCallback,
      "monetization:complete"
    );
  }

  didDestroy() {
    if (this.monetizationSessionId) {
      gMonetization.stop({ sessionId: this.monetizationSessionId });
    }
    Services.obs.removeObserver(
      this._monetizationRefreshCallback,
      "monetization:refresh"
    );
    Services.obs.removeObserver(
      this._monetizationCompleteCallback,
      "monetization:complete"
    );
  }

  receiveMessage(aMsg) {
    switch (aMsg.name) {
      case "Link:SetMonetization":
        this.monetizationSessionId = aMsg.data.sessionId;
        gMonetization.start(aMsg.data);
        break;

      case "Link:UnsetMonetization":
        this.monetizationSessionId = null;
        gMonetization.stop(aMsg.data);
        break;

      case "Link:PauseMonetization":
        gMonetization.pause(aMsg.data);
        break;

      case "Link:ResumeMonetization":
        gMonetization.resume(aMsg.data);
        break;
    }
  }
}
