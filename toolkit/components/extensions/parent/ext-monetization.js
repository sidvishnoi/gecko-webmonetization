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
      },
    };
  }
};
