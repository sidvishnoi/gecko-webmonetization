/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React from "react";
import { actionCreators as ac } from "common/Actions.jsm";

export class ContentSection extends React.PureComponent {
  constructor(props) {
    super(props);
    this.onPreferenceSelect = this.onPreferenceSelect.bind(this);
  }

  inputUserEvent(eventSource, status) {
    this.props.dispatch(
      ac.UserEvent({
        event: "PREF_CHANGED",
        source: eventSource,
        value: { status, menu_source: "CUSTOMIZE_MENU" },
      })
    );
  }

  onPreferenceSelect(e) {
    let prefName = e.target.getAttribute("preference");
    const eventSource = e.target.getAttribute("eventSource");
    let value;
    if (e.target.nodeName === "SELECT") {
      value = parseInt(e.target.value, 10);
    } else if (e.target.nodeName === "INPUT") {
      value = e.target.checked;
      if (eventSource) {
        this.inputUserEvent(eventSource, value);
      }
    }
    this.props.setPref(prefName, value);
  }

  render() {
    const {
      topSitesEnabled,
      pocketEnabled,
      highlightsEnabled,
      snippetsEnabled,
      showSponsoredTopSitesEnabled,
      showSponsoredPocketEnabled,
      topSitesRowsCount,
    } = this.props.enabledSections;

    return (
      <div className="home-section">
        <div id="shortcuts-section" className="section">
          <label className="switch">
            <input
              checked={topSitesEnabled}
              type="checkbox"
              onChange={this.onPreferenceSelect}
              preference="feeds.topsites"
              aria-labelledby="custom-shortcuts-title"
              aria-describedby="custom-shortcuts-subtitle"
            />
            <span className="slider" role="presentation"></span>
          </label>
          <div>
            <h2
              id="custom-shortcuts-title"
              className="title"
              data-l10n-id="newtab-custom-shortcuts-title"
            />
            <p
              id="custom-shortcuts-subtitle"
              className="subtitle"
              data-l10n-id="newtab-custom-shortcuts-subtitle"
            ></p>
            <div
              className={`more-info-top-wrapper ${
                topSitesEnabled ? "" : "shrink"
              }`}
            >
              <div
                className={`more-information ${
                  topSitesEnabled ? "expand" : "shrink"
                }`}
              >
                <select
                  id="row-selector"
                  className="selector"
                  name="row-count"
                  preference="topSitesRows"
                  value={topSitesRowsCount}
                  onChange={this.onPreferenceSelect}
                  disabled={!topSitesEnabled}
                  aria-labelledby="custom-shortcuts-title"
                >
                  <option
                    value="1"
                    data-l10n-id="newtab-custom-row-selector"
                    data-l10n-args='{"num": 1}'
                  />
                  <option
                    value="2"
                    data-l10n-id="newtab-custom-row-selector"
                    data-l10n-args='{"num": 2}'
                  />
                  <option
                    value="3"
                    data-l10n-id="newtab-custom-row-selector"
                    data-l10n-args='{"num": 3}'
                  />
                  <option
                    value="4"
                    data-l10n-id="newtab-custom-row-selector"
                    data-l10n-args='{"num": 4}'
                  />
                </select>
                {this.props.mayHaveSponsoredTopSites && (
                  <div className="check-wrapper" role="presentation">
                    <input
                      id="sponsored-shortcuts"
                      className="sponsored-checkbox"
                      disabled={!topSitesEnabled}
                      checked={showSponsoredTopSitesEnabled}
                      type="checkbox"
                      onChange={this.onPreferenceSelect}
                      preference="showSponsoredTopSites"
                    />
                    <label
                      className="sponsored"
                      htmlFor="sponsored-shortcuts"
                      data-l10n-id="newtab-custom-sponsored-sites"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {this.props.pocketRegion && (
          <div id="pocket-section" className="section">
            <label className="switch">
              <input
                checked={pocketEnabled}
                type="checkbox"
                onChange={this.onPreferenceSelect}
                preference="feeds.section.topstories"
                aria-labelledby="custom-pocket-title"
                aria-describedby="custom-pocket-subtitle"
              />
              <span className="slider" role="presentation"></span>
            </label>
            <div>
              <h2
                id="custom-pocket-title"
                className="title"
                data-l10n-id="newtab-custom-pocket-title"
              />
              <p
                id="custom-pocket-subtitle"
                className="subtitle"
                data-l10n-id="newtab-custom-pocket-subtitle"
              />
              {this.props.mayHaveSponsoredStories && (
                <div
                  className={`more-info-pocket-wrapper ${
                    pocketEnabled ? "" : "shrink"
                  }`}
                >
                  <div
                    className={`more-information ${
                      pocketEnabled ? "expand" : "shrink"
                    }`}
                  >
                    <div className="check-wrapper" role="presentation">
                      <input
                        id="sponsored-pocket"
                        className="sponsored-checkbox"
                        disabled={!pocketEnabled}
                        checked={showSponsoredPocketEnabled}
                        type="checkbox"
                        onChange={this.onPreferenceSelect}
                        preference="showSponsored"
                        eventSource="POCKET_SPOCS"
                      />
                      <label
                        className="sponsored"
                        htmlFor="sponsored-pocket"
                        data-l10n-id="newtab-custom-pocket-sponsored"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div id="recent-section" className="section">
          <label className="switch">
            <input
              checked={highlightsEnabled}
              type="checkbox"
              onChange={this.onPreferenceSelect}
              preference="feeds.section.highlights"
              eventSource="HIGHLIGHTS"
              aria-labelledby="custom-recent-title"
              aria-describedby="custom-recent-subtitle"
            />
            <span className="slider" role="presentation"></span>
          </label>
          <div>
            <h2
              id="custom-recent-title"
              className="title"
              data-l10n-id="newtab-custom-recent-title"
            />
            <p
              id="custom-recent-subtitle"
              className="subtitle"
              data-l10n-id="newtab-custom-recent-subtitle"
            />
          </div>
        </div>

        <div id="snippets-section" className="section">
          <label className="switch">
            <input
              checked={snippetsEnabled}
              type="checkbox"
              onChange={this.onPreferenceSelect}
              preference="feeds.snippets"
              aria-labelledby="custom-snippets-title"
              aria-describedby="custom-snippets-subtitle"
            />
            <span className="slider" role="presentation"></span>
          </label>
          <div>
            <h2
              id="custom-snippets-title"
              className="title"
              data-l10n-id="newtab-custom-snippets-title"
            />
            <p
              id="custom-snippets-subtitle"
              className="subtitle"
              data-l10n-id="newtab-custom-snippets-subtitle"
            />
          </div>
        </div>

        <span className="divider" role="separator"></span>

        <div>
          <button
            id="settings-link"
            className="external-link"
            onClick={this.props.openPreferences}
            data-l10n-id="newtab-custom-settings"
          />
        </div>
      </div>
    );
  }
}
