/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["LinkHandlerParent"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.defineModuleGetter(
  this,
  "PlacesUIUtils",
  "resource:///modules/PlacesUIUtils.jsm"
);

let gTestListeners = new Set();

const monetization = new (class MonetizationService {
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

class LinkHandlerParent extends JSWindowActorParent {
  actorCreated() {
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
  }

  didDestroy() {
    Services.obs.removeObserver(
      this._monetizationRefreshCallback,
      "monetization:refresh"
    );
  }

  static addListenerForTests(listener) {
    gTestListeners.add(listener);
  }

  static removeListenerForTests(listener) {
    gTestListeners.delete(listener);
  }

  receiveMessage(aMsg) {
    let browser = this.browsingContext.top.embedderElement;
    if (!browser) {
      return;
    }

    let win = browser.ownerGlobal;

    let gBrowser = win.gBrowser;

    switch (aMsg.name) {
      case "Link:LoadingIcon":
        if (!gBrowser) {
          return;
        }

        if (aMsg.data.canUseForTab) {
          let tab = gBrowser.getTabForBrowser(browser);
          if (tab.hasAttribute("busy")) {
            tab.setAttribute("pendingicon", "true");
          }
        }

        this.notifyTestListeners("LoadingIcon", aMsg.data);
        break;

      case "Link:SetIcon":
        // Cache the most recent icon and rich icon locally.
        if (aMsg.data.canUseForTab) {
          this.icon = aMsg.data;
        } else {
          this.richIcon = aMsg.data;
        }

        if (!gBrowser) {
          return;
        }

        this.setIconFromLink(gBrowser, browser, aMsg.data);

        this.notifyTestListeners("SetIcon", aMsg.data);
        break;

      case "Link:SetFailedIcon":
        if (!gBrowser) {
          return;
        }

        if (aMsg.data.canUseForTab) {
          this.clearPendingIcon(gBrowser, browser);
        }

        this.notifyTestListeners("SetFailedIcon", aMsg.data);
        break;

      case "Link:AddSearch":
        if (!gBrowser) {
          return;
        }

        let tab = gBrowser.getTabForBrowser(browser);
        if (!tab) {
          break;
        }

        if (win.BrowserSearch) {
          win.BrowserSearch.addEngine(
            browser,
            aMsg.data.engine,
            Services.io.newURI(aMsg.data.url)
          );
        }
        break;

      case "Link:SetMonetization":
        monetization.start(aMsg.data);
        break;

      case "Link:SetFailedMonetization":
        break;

      case "Link:UnsetMonetization":
        monetization.stop(aMsg.data);
        break;

      case "Link:PauseMonetization":
        monetization.pause(aMsg.data);
        break;

      case "Link:ResumeMonetization":
        monetization.resume(aMsg.data);
        break;
    }
  }

  notifyTestListeners(name, data) {
    for (let listener of gTestListeners) {
      listener(name, data);
    }
  }

  clearPendingIcon(gBrowser, aBrowser) {
    let tab = gBrowser.getTabForBrowser(aBrowser);
    tab.removeAttribute("pendingicon");
  }

  setIconFromLink(
    gBrowser,
    browser,
    { pageURL, originalURL, canUseForTab, expiration, iconURL, canStoreIcon }
  ) {
    let tab = gBrowser.getTabForBrowser(browser);
    if (!tab) {
      return;
    }

    if (canUseForTab) {
      this.clearPendingIcon(gBrowser, browser);
    }

    let iconURI;
    try {
      iconURI = Services.io.newURI(iconURL);
    } catch (ex) {
      Cu.reportError(ex);
      return;
    }
    if (iconURI.scheme != "data") {
      try {
        Services.scriptSecurityManager.checkLoadURIWithPrincipal(
          browser.contentPrincipal,
          iconURI,
          Services.scriptSecurityManager.ALLOW_CHROME
        );
      } catch (ex) {
        return;
      }
    }
    if (canStoreIcon) {
      try {
        PlacesUIUtils.loadFavicon(
          browser,
          Services.scriptSecurityManager.getSystemPrincipal(),
          Services.io.newURI(pageURL),
          Services.io.newURI(originalURL),
          expiration,
          iconURI
        );
      } catch (ex) {
        Cu.reportError(ex);
      }
    }

    if (canUseForTab) {
      gBrowser.setIcon(tab, iconURL, originalURL);
    }
  }
}
