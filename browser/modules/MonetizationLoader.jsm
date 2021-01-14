/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["MonetizationLoader"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  Services: "resource://gre/modules/Services.jsm",
  DeferredTask: "resource://gre/modules/DeferredTask.jsm",
  MonetizationFetcher: "resource:///modules/MonetizationFetcher.jsm",
});
XPCOMUtils.defineLazyServiceGetters(this, {
  gUUIDGenerator: ["@mozilla.org/uuid-generator;1", "nsIUUIDGenerator"],
});

const DEFER_TASK_TIMEOUT = 100;

class Monetization {
  constructor(actor) {
    this.actor = actor;
    // Avoid race condition when a start was initiated and a stop/pause is
    // requested (the user navigates away from the page or some reason). We do
    // not emit a start event in such cases.
    this.state = null;
  }

  /**
   * @param {ReturnType<typeof makePaymentInfoFromLink>} paymentPointerInfo
   */
  async start(sessionId, paymentPointerInfo) {
    this.state = "starting";
    if (this._fetcher) {
      this._fetcher.cancel();
    }

    try {
      this._fetcher = new MonetizationFetcher(paymentPointerInfo);
      let response = await this._fetcher.fetch();
      if (this.state !== "starting") {
        return;
      }
      this.actor.sendAsyncMessage("Link:SetMonetization", {
        sessionId,
        pageURL: paymentPointerInfo.pageUri.spec,
        originalURL: paymentPointerInfo.paymentPointerUri.spec,
        spspResponse: response,
      });
    } catch (e) {
      if (e.result != Cr.NS_BINDING_ABORTED) {
        Cu.reportError(e);
        this.actor.sendAsyncMessage("Link:SetFailedMonetization", {
          pageURL: paymentPointerInfo.pageUri.spec,
          originalURL: paymentPointerInfo.paymentPointerUri.spec,
        });
      }
    } finally {
      this.state = null;
      this._fetcher = null;
    }
  }

  stop(sessionId) {
    this.state = "stopped";
    this.cancel();
    if (this.actor.docShell.isBeingDestroyed()) {
      return;
    }
    this.actor.sendAsyncMessage("Link:UnsetMonetization", { sessionId });
  }

  pause(sessionId) {
    this.state = "paused";
    this.actor.sendAsyncMessage("Link:PauseMonetization", { sessionId });
  }

  resume(sessionId) {
    this.state = null;
    this.actor.sendAsyncMessage("Link:ResumeMonetization", { sessionId });
  }

  cancel() {
    if (!this._fetcher) {
      return;
    }

    this._fetcher.cancel();
    this._fetcher = null;
  }
}

class MonetizationLoader {
  constructor(actor) {
    this.actor = actor;
    this.document = null;
    this.currentPaymentInfo = null;
    this.sessionId = null;

    this.fetchPaymentInfoTask = new DeferredTask(
      () => this.fetchPaymentInfo(),
      DEFER_TASK_TIMEOUT
    );
  }

  get loader() {
    if (!this._loader) {
      this._loader = new Monetization(this.actor);
    }
    return this._loader;
  }

  onLinkEvent(aDocument) {
    if (aDocument.visibilityState === "visible") {
      this.doUpdateMonetization(aDocument);
    }
  }

  onVisbilityChange(aDocument) {
    if (aDocument.visibilityState === "hidden") {
      if (this.currentPaymentInfo /** && monetization is active */) {
        this.pauseMonetization();
      } else {
        // Do nothing.
      }
    } else if (this.currentPaymentInfo) {
      this.resumeMonetization();
    } else {
      this.doUpdateMonetization(aDocument, true);
    }
  }

  onPageShow(aDocument) {
    if (this.fetchPaymentInfoTask.isArmed) {
      this.fetchPaymentInfoTask.disarm();
      this.fetchPaymentInfo();
    } else if (
      aDocument.visibilityState === "visible" &&
      !this.currentPaymentInfo
    ) {
      this.doUpdateMonetization(aDocument);
    }
  }

  onPageHide(aDocument) {
    this.document = null;
    this.stopMonetization(aDocument);
  }

  // TODO: we should probably defer/throttle this
  doUpdateMonetization(aDocument, forceUpdate = false) {
    this.document = aDocument;

    const paymentInfo = getPaymentInfo(aDocument);
    if (!paymentInfo) {
      if (this.currentPaymentInfo) {
        // all link tags have been removed, or the first such link tag is not valid anymore.
        this.stopMonetization(aDocument);
      } else {
        // Nothing to do
      }
      return;
    }

    if (!this.currentPaymentInfo && !forceUpdate) {
      this.startMonetization(paymentInfo);
    } else if (forceUpdate || !isSame(this.currentPaymentInfo, paymentInfo)) {
      this.updateMonetization(paymentInfo, aDocument);
    }
  }

  startMonetization(aPaymentInfo) {
    this.sessionId = generateSessionId();
    this.currentPaymentInfo = aPaymentInfo;
    this.fetchPaymentInfo();
  }

  stopMonetization(aDocument) {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.currentPaymentInfo = null;
    this.loader.stop(sessionId);
    this.fetchPaymentInfoTask.disarm();
  }

  pauseMonetization() {
    this.loader.pause(this.sessionId);
  }

  resumeMonetization() {
    this.loader.resume(this.sessionId);
  }

  updateMonetization(aPaymentInfo, aDocument) {
    this.stopMonetization(aDocument);
    this.startMonetization(aPaymentInfo);
  }

  fetchPaymentInfo() {
    // If the page is unloaded immediately after the DeferredTask's timer fires
    // we can still attempt to fetch from payment pointers URLs, which will fail
    // since the content window is no longer available. This check allows us to
    // bail out early in this case.
    if (!this.document) {
      return;
    }

    if (this.currentPaymentInfo && this.sessionId) {
      this.loader.start(this.sessionId, this.currentPaymentInfo);
    }
  }
}

/**
 * Gets the payment pointer URL and other details from the first valid
 * `link[rel=monetization]` in the document.
 *
 * @param {Document} aDocument
 */
function getPaymentInfo(aDocument) {
  if (!aDocument) {
    return null;
  }
  const link = aDocument.head.querySelector("link[rel~=monetization][href]");
  if (!link) {
    return null;
  }
  const paymentInfo = makePaymentInfoFromLink(link);
  return paymentInfo;
}

function makePaymentInfoFromLink(aLink) {
  let paymentPointerUri = getLinkURI(aLink);
  if (!paymentPointerUri) {
    return null;
  }

  return {
    pageUri: aLink.ownerDocument.documentURIObject,
    paymentPointerUri,
    node: aLink,
  };
}

/**
 * Get link URI from a link dom node.
 *
 * @param {DOMNode} aLink A link dom node.
 * @return {nsIURI} A uri for the link node.
 */
function getLinkURI(aLink) {
  let targetDoc = aLink.ownerDocument;
  let uri = Services.io.newURI(aLink.href, targetDoc.characterSet);
  try {
    uri = uri
      .mutate()
      .setUserPass("")
      .finalize();
  } catch (e) {
    // some URIs are immutable
  }
  return uri;
}

function isSame(aInfoA, aInfoB) {
  return (
    aInfoA &&
    aInfoB &&
    aInfoB.paymentPointerUri.equals(aInfoA.paymentPointerUri) &&
    aInfoB.node === aInfoA.node
  );
}

function generateSessionId() {
  return gUUIDGenerator
    .generateUUID()
    .toString()
    .slice(1, -1); // Discard surrounding braces
}
