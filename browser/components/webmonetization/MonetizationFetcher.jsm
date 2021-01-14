/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["MonetizationFetcher"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  Services: "resource://gre/modules/Services.jsm",
  PromiseUtils: "resource://gre/modules/PromiseUtils.jsm",
});

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

const ALLOWED_MIME_TYPES = [
  "application/spsp4+json",
  "application/spsp+json",
  "application/json",
];

class MonetizationFetcher {
  /**
   * @param {object} paymentPointerInfo
   * @param {DOMNode} paymentPointerInfo.node
   * @param {nsIURI} paymentPointerInfo.paymentPointerUri
   * @param {nsIURI} paymentPointerInfo.pageUri
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
