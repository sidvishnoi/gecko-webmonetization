/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["MonetizationLoader"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.defineModuleGetter(
  this,
  "DeferredTask",
  "resource://gre/modules/DeferredTask.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "PromiseUtils",
  "resource://gre/modules/PromiseUtils.jsm"
);

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "gUUIDGenerator",
  "@mozilla.org/uuid-generator;1",
  "nsIUUIDGenerator"
);

const StorageStream = Components.Constructor(
  "@mozilla.org/storagestream;1",
  "nsIStorageStream",
  "init"
);
const BufferedOutputStream = Components.Constructor(
  "@mozilla.org/network/buffered-output-stream;1",
  "nsIBufferedOutputStream",
  "init"
);
const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream"
);
const ReferrerInfo = Components.Constructor(
  "@mozilla.org/referrer-info;1",
  "nsIReferrerInfo",
  "init"
);

// For fetching the monetization response.
// TODO: how large this should be? spsp response are generally around 100-200 chars.
const STREAM_SEGMENT_SIZE = 4096;
const PR_UINT32_MAX = 0xffffffff;

const DEFER_TASK_TIMEOUT = 100;

const ALLOWED_MIME_TYPES = [
  "application/spsp4+json",
  "application/spsp+json",
  "application/json",
];

class MonetizationFetcher {
  /**
   * @param {ReturnType<typeof makePaymentInfoFromLink>} paymentPointerInfo
   */
  constructor(paymentPointerInfo) {
    this.paymentPointerInfo = paymentPointerInfo;

    // TODO: Check if security should/can be made stricter. Is there no
    // nsILoadInfo for JSON?
    const securityFlags =
      Ci.nsILoadInfo.SEC_REQUIRE_CORS_INHERITS_SEC_CONTEXT |
      Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT;

    this.channel = Services.io.newChannelFromURI(
      paymentPointerInfo.paymentPointerUri,
      paymentPointerInfo.node,
      paymentPointerInfo.node.nodePrincipal,
      paymentPointerInfo.node.nodePrincipal,
      securityFlags,
      Ci.nsIContentPolicy.TYPE_MONETIZATION
    );

    if (this.channel instanceof Ci.nsIHttpChannel) {
      this.channel.setRequestHeader(
        "Accept",
        "application/spsp4+json, application/spsp+json",
        false
      );
      this.channel.referrerInfo = new ReferrerInfo(
        Ci.nsIReferrerInfo.NO_REFERRER
      );
    }

    this.channel.loadFlags |= Ci.nsIRequest.LOAD_BACKGROUND;
    // Sometimes node is a document and sometimes it is an element. This is
    // the easiest single way to get to the load group in both those cases.
    this.channel.loadGroup =
      paymentPointerInfo.node.ownerGlobal.document.documentLoadGroup;
    this.channel.notificationCallbacks = this;

    if (this.channel instanceof Ci.nsIHttpChannelInternal) {
      this.channel.blockAuthPrompt = true;
    }

    if (
      Services.prefs.getBoolPref("network.http.tailing.enabled", true) &&
      this.channel instanceof Ci.nsIClassOfService
    ) {
      this.channel.addClassFlags(
        Ci.nsIClassOfService.Tail | Ci.nsIClassOfService.Throttleable
      );
    }
  }

  fetch() {
    this._deferred = PromiseUtils.defer();

    // Clear the references when we succeed or fail.
    let cleanup = () => {
      this.channel = null;
      this.dataBuffer = null;
      this.stream = null;
    };
    this._deferred.promise.then(cleanup, cleanup);

    this.dataBuffer = new StorageStream(STREAM_SEGMENT_SIZE, PR_UINT32_MAX);
    // StorageStream does not implement writeFrom so wrap it with a buffered stream.
    this.stream = new BufferedOutputStream(
      this.dataBuffer.getOutputStream(0),
      STREAM_SEGMENT_SIZE * 2
    );

    try {
      this.channel.asyncOpen(this);
    } catch (e) {
      this._deferred.reject(e);
    }

    return this._deferred.promise;
  }

  cancel() {
    if (!this.channel) {
      return;
    }

    this.channel.cancel(Cr.NS_BINDING_ABORTED);
  }

  onStartRequest(request) {}

  onDataAvailable(request, inputStream, offset, count) {
    this.stream.writeFrom(inputStream, count);
  }

  asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
    if (oldChannel == this.channel) {
      this.channel = newChannel;
    }

    callback.onRedirectVerifyCallback(Cr.NS_OK);
  }

  async onStopRequest(request, statusCode) {
    if (request != this.channel) {
      // Indicates that a redirect has occurred. We don't care about the result
      // of the original channel.
      return;
    }

    this.stream.close();
    this.stream = null;

    if (!Components.isSuccessCode(statusCode)) {
      if (statusCode == Cr.NS_BINDING_ABORTED) {
        this._deferred.reject(
          Components.Exception(
            `Monetization load from ${this.paymentPointerInfo.paymentPointerUri.spec} was cancelled.`,
            statusCode
          )
        );
      } else {
        this._deferred.reject(
          Components.Exception(
            `Monetization at "${this.paymentPointerInfo.paymentPointerUri.spec}" failed to load.`,
            statusCode
          )
        );
      }
      return;
    }

    if (this.channel instanceof Ci.nsIHttpChannel) {
      if (!this.channel.requestSucceeded) {
        this._deferred.reject(
          Components.Exception(
            `Monetization at "${this.paymentPointerInfo.paymentPointerUri.spec}" failed to load: ${this.channel.responseStatusText}.`,
            Cr.NS_ERROR_FAILURE
          )
        );
        return;
      }
    }

    try {
      let type = this.channel.contentType;
      if (!ALLOWED_MIME_TYPES.includes(type)) {
        throw Components.Exception(
          `Monetization response at "${this.paymentPointerInfo.paymentPointerUri.spec}" did not match a valid mimetype.`,
          Cr.NS_ERROR_FAILURE
        );
      }

      let json;
      try {
        // TODO: see if there is more efficient way to do this.
        const stream = new BinaryInputStream(this.dataBuffer.newInputStream(0));
        const buffer = new ArrayBuffer(this.dataBuffer.length);
        stream.readArrayBuffer(buffer.byteLength, buffer);
        let str = String.fromCharCode.apply(null, new Uint8Array(buffer));

        // TODO: maybe we should only extract supported fields from response.
        json = JSON.parse(str);
      } catch (e) {
        throw Components.Exception(
          `Monetization response at "${this.paymentPointerInfo.paymentPointerUri.spec}" did not parse as given mimetype.`,
          Cr.NS_ERROR_FAILURE
        );
      }

      if (!json.destination_account || !json.shared_secret) {
        throw Components.Exception(
          `Monetization response at "${this.paymentPointerInfo.paymentPointerUri.spec}" does not have required fields.`,
          Cr.NS_ERROR_FAILURE
        );
      }

      this._deferred.resolve({
        destinationAccount: json.destination_account,
        sharedSecret: json.shared_secret,
        receiptsEnabled: json.receipts_enabled,
      });
    } catch (e) {
      Cu.reportError(e);
      this._deferred.reject(e);
    }
  }

  getInterface(iid) {
    if (iid.equals(Ci.nsIChannelEventSink)) {
      return this;
    }
    throw Components.Exception("", Cr.NS_ERROR_NO_INTERFACE);
  }
}

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

    this.loader = new Monetization(actor);

    this.fetchPaymentInfoTask = new DeferredTask(
      () => this.fetchPaymentInfo(),
      DEFER_TASK_TIMEOUT
    );
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
    } else {
      console.log("🤑 (Re)start monetization", aDocument.location.href);
      this.resumeMonetization();
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
      console.log("onPageShow()");
      this.doUpdateMonetization(aDocument);
    }
  }

  onPageHide(aDocument) {
    console.log("🤑☠ Stop monetization onPageHide()");
    this.document = null;
    this.stopMonetization(aDocument);
  }

  // TODO: we should probably defer/throttle this
  doUpdateMonetization(aDocument) {
    this.document = aDocument;

    const paymentInfo = getPaymentInfo(aDocument);
    if (!paymentInfo) {
      console.log("💔 no paymentInfo");
      if (this.currentPaymentInfo) {
        // all link tags have been removed, or the first such link tag is not valid anymore.
        this.stopMonetization(aDocument);
      } else {
        // Nothing to do
      }
      return;
    }

    if (!this.currentPaymentInfo) {
      this.startMonetization(paymentInfo);
    } else if (!isSame(this.currentPaymentInfo, paymentInfo)) {
      this.updateMonetization(paymentInfo, aDocument);
    }
  }

  startMonetization(aPaymentInfo) {
    console.info(
      "🤑 Start monetization",
      aPaymentInfo.pageUri.spec,
      aPaymentInfo.paymentPointerUri.spec
    );
    this.sessionId = generateSessionId();
    this.currentPaymentInfo = aPaymentInfo;
    this.fetchPaymentInfo();
  }

  stopMonetization(aDocument) {
    console.info("🤑 Stop monetization", aDocument?.location.href);
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.currentPaymentInfo = null;
    this.loader.stop(sessionId);
    this.fetchPaymentInfoTask.disarm();
  }

  pauseMonetization() {
    console.log("🤑 Pause", this.document?.location?.href);
    this.loader.pause(this.sessionId);
  }

  resumeMonetization() {
    console.log("🤑 Resume", this.document?.location?.href);
    this.loader.resume(this.sessionId);
  }

  updateMonetization(aPaymentInfo, aDocument) {
    console.info("🤑 Update monetization", aDocument?.location.href);
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
      this.document = null;
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
    console.trace("no aDocument");
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
