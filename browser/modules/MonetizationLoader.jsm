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

const STREAM_SEGMENT_SIZE = 4096;
// TODO: do we need to this large response?
const PR_UINT32_MAX = 0xffffffff;
const StorageStream = Components.Constructor(
  "@mozilla.org/storagestream;1",
  "nsIStorageStream",
  "init"
);

const MM_PARSING_TIMEOUT = 100;

// TODO: should we cache response if cache-control is not specified or not?
const MAX_SPSP_EXPIRATION = 0;

const ALLOWED_MIME_TYPES = ["application/spsp4+json", "application/spsp+json", "application/json"];

class FaviconLoad {
  /**
   * @param {ReturnType<typeof makePaymentInfoFromLink>} paymentPointerInfo
   */
  constructor(paymentPointerInfo) {
    this.paymentPointerInfo = paymentPointerInfo;

    // TODO: hard-code based on spec
    let securityFlags;
    if (paymentPointerInfo.node.crossOrigin === "anonymous") {
      securityFlags = Ci.nsILoadInfo.SEC_REQUIRE_CORS_INHERITS_SEC_CONTEXT;
    } else if (paymentPointerInfo.node.crossOrigin === "use-credentials") {
      securityFlags =
        Ci.nsILoadInfo.SEC_REQUIRE_CORS_INHERITS_SEC_CONTEXT |
        Ci.nsILoadInfo.SEC_COOKIES_INCLUDE;
    } else {
      securityFlags =
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT;
    }

    this.channel = Services.io.newChannelFromURI(
      paymentPointerInfo.paymentPointerUri,
      paymentPointerInfo.node,
      paymentPointerInfo.node.nodePrincipal,
      paymentPointerInfo.node.nodePrincipal,
      // TODO: Check if security should/can be made stricter. Is there no
      // nsILoadInfo for JSON?
      securityFlags | Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT,
      // TODO: provide proper nsIContentPolicy
      Ci.nsIContentPolicy.TYPE_OTHER,
    );

    // TODO: hide referrer as per spec
    if (this.channel instanceof Ci.nsIHttpChannel) {
      this.channel.QueryInterface(Ci.nsIHttpChannel);
      let referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(
        Ci.nsIReferrerInfo
      );
      // Sometimes node is a document and sometimes it is an element. We need
      // to set the referrer info correctly either way.
      if (paymentPointerInfo.node.nodeType == paymentPointerInfo.node.DOCUMENT_NODE) {
        referrerInfo.initWithDocument(paymentPointerInfo.node);
      } else {
        referrerInfo.initWithElement(paymentPointerInfo.node);
      }
      this.channel.referrerInfo = referrerInfo;
    }

    this.channel.loadFlags |=
      Ci.nsIRequest.LOAD_BACKGROUND |
      Ci.nsIRequest.VALIDATE_NEVER |
      Ci.nsIRequest.LOAD_FROM_CACHE;
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

  load() {
    this._deferred = PromiseUtils.defer();

    // Clear the references when we succeed or fail.
    let cleanup = () => {
      this.channel = null;
      this.dataBuffer = null;
    };
    this._deferred.promise.then(cleanup, cleanup);

    this.dataBuffer = new StorageStream(STREAM_SEGMENT_SIZE, PR_UINT32_MAX);

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

  onStartRequest(request) { }

  onDataAvailable(request, inputStream, offset, count) {
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

    // By default don't store spsp responses added after "pageshow".
    let canStore = this.paymentPointerInfo.beforePageShow;
    if (canStore) {
      // Don't store spsp responses responding with Cache-Control: no-store.
      try {
        if (
          this.channel instanceof Ci.nsIHttpChannel &&
          this.channel.isNoStoreResponse()
        ) {
          canStore = false;
        }
      } catch (ex) {
        if (ex.result != Cr.NS_ERROR_NOT_AVAILABLE) {
          throw ex;
        }
      }
    }

    // Attempt to get an expiration time from the cache.  If this fails, we'll
    // use this default.
    let expiration = Date.now() + MAX_SPSP_EXPIRATION;
    // This stuff isn't available after onStopRequest returns (so don't start
    // any async operations before this!).
    if (this.channel instanceof Ci.nsICacheInfoChannel) {
      try {
        expiration = this.channel.cacheTokenExpirationTime * 1000;
      } catch (e) {
        // Ignore failures to get the expiration time.
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
        let buffer = new ArrayBuffer(this.dataBuffer.length);
        // TODO: see if there is more efficient way to do this.
        let str = String.fromCharCode.apply(null, new Uint8Array(buffer));
        // TODO: maybe we should only extract supported fields from response.
        json = JSON.parse(str);
      } catch (e) {
        throw Components.Exception(
          `Monetization response at "${this.paymentPointerInfo.paymentPointerUri.spec}" did not parse as given mimetype.`,
          Cr.NS_ERROR_FAILURE
        );
      }

      this._deferred.resolve({
        expiration,
        json,
        canStore,
      });
    } catch (e) {
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
  }

  async load(paymentPointerInfo) {
    if (this._loader) {
      this._loader.cancel();
    }

    // // Let the main process that a tab icon is possibly coming.
    // this.actor.sendAsyncMessage("Link:LoadingIcon", {
    //   originalURL: paymentPointerInfo.paymentPointerUri.spec,
    //   canUseForTab: !paymentPointerInfo.isRichIcon,
    // });

    try {
      this._loader = new FaviconLoad(paymentPointerInfo);
      let { dataURL, expiration } = await this._loader.load();

      // this.actor.sendAsyncMessage("Link:SetIcon", {
      //   pageURL: paymentPointerInfo.pageUri.spec,
      //   originalURL: paymentPointerInfo.paymentPointerUri.spec,
      //   expiration,
      //   paymentPointerURL: dataURL,
      // });
    } catch (e) {
      // if (e.result != Cr.NS_BINDING_ABORTED) {
      //   Cu.reportError(e);

      //   // Used mainly for tests currently.
      //   this.actor.sendAsyncMessage("Link:SetFailedIcon", {
      //     originalURL: paymentPointerInfo.paymentPointerUri.spec,
      //   });
      // }
    } finally {
      this._loader = null;
    }
  }

  cancel() {
    if (!this._loader) {
      return;
    }

    this._loader.cancel();
    this._loader = null;
  }
}

class MonetizationLoader {
  constructor(actor) {
    this.actor = actor;
    this.paymentPointers = [];

    // Icons added after onPageShow() are likely added by modifying <link> tags
    // through javascript; we want to avoid storing those permanently because
    // they are probably used to show badges, and many of them could be
    // randomly generated. This boolean can be used to track that case.
    this.beforePageShow = true;

    this.loader = new Monetization(actor);

    this.loadMonetizationTask = new DeferredTask(
      () => this.loadPaymentPointers(),
      MM_PARSING_TIMEOUT
    );
  }

  loadPaymentPointers() {
    // If the page is unloaded immediately after the DeferredTask's timer fires
    // we can still attempt to fetch from payment pointers URLs, which will fail
    // since the content window is no longer available. Checking if
    // paymentPointers has been cleared allows us to bail out early in this
    // case.
    if (!this.paymentPointers.length) {
      return;
    }

    let paymentPointer = getPaymentPointer(this.paymentPointers);
    this.paymentPointers = [];

    if (paymentPointer) {
      this.loader.load(paymentPointer);
    }
  }

  addPaymentInfoFromLink(aLink) {
    let paymentPointerInfo = makePaymentInfoFromLink(aLink);
    if (paymentPointerInfo) {
      paymentPointerInfo.beforePageShow = this.beforePageShow;
      this.paymentPointers.push(paymentPointerInfo);
      this.loadMonetizationTask.arm();
      return true;
    }
    return false;
  }

  addDefaultIcon(pageUri) {
    // this.loadMonetizationTask.arm();
  }

  onPageShow() {
    // We're likely done with icon parsing so load the pending icons now.
    if (this.loadMonetizationTask.isArmed) {
      this.loadMonetizationTask.disarm();
      this.loadPaymentPointers();
    }
    this.beforePageShow = false;
  }

  onPageHide() {
    this.loader.cancel();
    this.loadMonetizationTask.disarm();
    this.paymentPointers = [];
  }
}

/**
 * Gets the first payment pointer URL from a list of PaymentPointer objects.
 *
 * @param {Array} paymentPointers A list of PaymentPointer objects.
 */
function getPaymentPointer(paymentPointers) {
  if (!paymentPointers.length) {
    return null;
  }
  console.log(">>>>$$$$$$$$$$$", paymentPointers.map(p => p.paymentPointerUri.spec).join(", "));
  return paymentPointers[0];
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
