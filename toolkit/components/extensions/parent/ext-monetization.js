/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.monetization = class extends ExtensionAPI {
  getAPI(context) {
    const getEventManager = (eventName, apiName) => {
      return new EventManager({
        context,
        name: apiName,
        register(fire) {
          const callback = (subject, topic, data) => {
            fire.async(data);
          };
          Services.obs.addObserver(callback, eventName);
          return () => {
            Services.obs.removeObserver(callback, eventName);
          };
        },
      }).api();
    };

    return {
      monetization: {
        onStart: new EventManager({
          context,
          name: "monetization.onStart",
          register(fire) {
            const callback = (subject, topic, data) => {
              const parsedData = JSON.parse(data);
              const { sessionId, spspResponse } = parsedData;
              fire.async(sessionId, spspResponse);
            };
            Services.obs.addObserver(callback, "monetization:start");
            return () => {
              Services.obs.removeObserver(callback, "monetization:start");
            };
          },
        }).api(),
        onStop: getEventManager("monetization:stop", "monetization.onStop"),
        onPause: getEventManager("monetization:pause", "monetization.onPause"),
        onResume: getEventManager(
          "monetization:resume",
          "monetization.onResume"
        ),
        async refresh(sessionId) {
          Services.obs.notifyObservers(null, "monetization:refresh", sessionId);
          const { data } = await ExtensionUtils.promiseObserved(
            "monetization:refresh:response",
            (subject, data) => JSON.parse(data).oldSessionId === sessionId
          );
          return JSON.parse(data).newSessionId;
        },
        completePayment(sessionId, amount, receipt) {
          const data = { sessionId, amount, receipt };
          Services.obs.notifyObservers(
            null,
            "monetization:complete",
            JSON.stringify(data)
          );
        },
      },
    };
  }
};
