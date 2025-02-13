/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";
// Test for error icon and the error count displayed at right of the
// toolbox toolbar
const TEST_URI = `http://example.org/document-builder.sjs?html=<meta charset=utf8></meta>
<script>
  console.error("Cache Error1");
  console.exception(false, "Cache Exception");
  console.warn("Cache warning");
  console.assert(false, "Cache assert");
  cache.unknown.access
</script><body>`;

const { Toolbox } = require("devtools/client/framework/toolbox");

add_task(async function() {
  // Make sure we start the test with the split console disabled.
  await pushPref("devtools.toolbox.splitconsoleEnabled", false);
  const tab = await addTab(TEST_URI);

  const toolbox = await openToolboxForTab(
    tab,
    "inspector",
    Toolbox.HostType.BOTTOM
  );

  info("Check for cached errors");
  // (console.error + console.exception + console.assert + error)
  let expectedErrorCount = 4;

  await waitFor(() => getErrorIcon(toolbox));
  is(
    getErrorIcon(toolbox).getAttribute("title"),
    "Show Split Console",
    "Icon has expected title"
  );
  is(
    getErrorIconCount(toolbox),
    expectedErrorCount,
    "Correct count is displayed"
  );

  info("Check that calling console.clear clears the error count");
  ContentTask.spawn(tab.linkedBrowser, null, function() {
    content.console.clear();
  });
  await waitFor(() => !getErrorIcon(toolbox));
  ok(true, "The button was hidden after calling console.clear()");

  info("Check that realtime errors increase the counter");
  ContentTask.spawn(tab.linkedBrowser, null, function() {
    content.console.error("Live Error1");
    content.console.error("Live Error2");
    content.console.exception("Live Exception");
    content.console.warn("Live warning");
    content.console.assert(false, "Live assert");
    content.fetch("unknown-url-that-will-404");
    const script = content.document.createElement("script");
    script.textContent = `a.b.c.d`;
    content.document.body.append(script);
  });

  expectedErrorCount = 6;
  await waitFor(() => getErrorIconCount(toolbox) === expectedErrorCount);

  info("Check if split console opens on clicking the error icon");
  const onSplitConsoleOpen = toolbox.once("split-console");
  getErrorIcon(toolbox).click();
  await onSplitConsoleOpen;
  ok(
    toolbox.splitConsole,
    "The split console was opened after clicking on the icon."
  );

  // Select the console and check that the icon title is updated
  await toolbox.selectTool("webconsole");
  is(
    getErrorIcon(toolbox).getAttribute("title"),
    null,
    "When the console is selected, the icon does not have a title"
  );

  const webconsoleDoc = toolbox.getCurrentPanel().hud.ui.window.document;
  // wait until all error messages are displayed in the console
  await waitFor(
    () =>
      webconsoleDoc.querySelectorAll(".message.error").length ===
      expectedErrorCount
  );

  info("Clear the console output and check that the error icon is hidden");
  webconsoleDoc.querySelector(".devtools-clear-icon").click();
  await waitFor(() => !getErrorIcon(toolbox));
  ok(true, "Clearing the console does hide the icon");
  await waitFor(
    () => webconsoleDoc.querySelectorAll(".message.error").length === 0
  );

  info(
    "Reload the page and check that the error icon has the expected content"
  );
  tab.linkedBrowser.reload();

  // (console.error, console.exception, console.assert and exception)
  expectedErrorCount = 4;
  await waitFor(() => getErrorIconCount(toolbox) === expectedErrorCount);
  ok(true, "Correct count is displayed");

  // wait until all error messages are displayed in the console
  await waitFor(
    () =>
      webconsoleDoc.querySelectorAll(".message.error").length ===
      expectedErrorCount
  );

  info(
    "Navigate to an error-less page and check that the error icon is hidden"
  );
  await navigateTo(`data:text/html;charset=utf8,No errors`);
  await waitFor(() => !getErrorIcon(toolbox));
  ok(
    true,
    "The error icon was hidden when navigating to a new page without errors"
  );

  info("Check that the error count is capped at 99");
  expectedErrorCount = 100;
  ContentTask.spawn(tab.linkedBrowser, expectedErrorCount, function(count) {
    for (let i = 0; i < count; i++) {
      content.console.error(i);
    }
  });

  // Wait until all the messages are displayed in the console
  await waitFor(
    () =>
      webconsoleDoc.querySelectorAll(".message.error").length ===
      expectedErrorCount
  );
  is(
    getErrorIcon(toolbox).textContent,
    "99+",
    "The message count doesn't go higher than 99"
  );

  toolbox.destroy();
});

function getErrorIcon(toolbox) {
  return toolbox.doc.querySelector(".toolbox-error");
}

function getErrorIconCount(toolbox) {
  const number = getErrorIcon(toolbox)?.textContent;
  try {
    return parseInt(number, 10);
  } catch (e) {
    return number;
  }
}
