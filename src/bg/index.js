// Created by installing linkedom locally and then using
// `terser worker.js -o linkedom.min.js -c --mangle=false` from inside the node_modules package
import { parseHTML } from '../../js/linkedom.min.js';

// Created by getting the sentry bundle from their cdn https://browser.sentry-cdn.com/7.116.0/bundle.min.js
// then for some reason i had to add `export default Sentry;` to the end of it
import Sentry from '../../js/sentry.bundle.js';

import { self, getRkCookies, getRequest, postRequest, sendLog, getVersion } from "./common.js";
import { BASE_URL } from "./constants.js";
import { startLibraryBooksSync } from "./libraryBooksSync.js";
import { getStorage, removeStorage, setStorage } from "./storage.js";

Sentry.init({
  dsn: "https://3fec21c6ad6ea96c2bdf3b027633ad54@o374023.ingest.us.sentry.io/4507377150459904",
  environment: BASE_URL.includes('local') ? 'development' : 'production',
});

const AUTHOR_SELECTOR = "p.kp-notebook-metadata.a-spacing-none"

let contextMenuItemId;
// This is disabled if the web highlighter extension is installed
let shouldHaveContextMenuItem = true;

function createElement(html) {
  return parseHTML(html).document;
}

async function onDoneSync() {
  self.startedSyncing = null;
  self.doneSyncing = true;
  sendLog("Done sync, a total of " + (self.currentBookIndex + 1) + " books covered before finishing.");
  chrome.storage.local.set({lastSync: {status: "success", time: Date.now()}});
  await setStorage("syncedBookHashes", JSON.stringify(self.syncedBookHashes))
}


function isMismatchedAmazonAccount(el)   {
  if (self.isForcedSync) {
    return false;
  }
  var greeting = el.querySelector('.kp-notebook-username')?.innerText;
  var cookieName = decodeURIComponent(self.cookz.userAmazonName);

  var misMatch = greeting && cookieName && (greeting !== cookieName);
  if (misMatch) {
    sendLog("Ending sync early because amazon account does not seem to match: " + cookieName + " vs. " + greeting);
  }
  return misMatch;
}

async function onInitialRequestError(error) {
  const rootResponse = await fetch('https://read.amazon.co.jp/notebook', {
    headers: self.requestHeaders,
    redirect: 'manual'
  });

  if (rootResponse.type === 'opaqueredirect') {
    sendLog("Ending sync early because initial /notebook request failed -- user seems to be logged out? Error: " + error);
    console.log(error);
    postRequest('/api/extension_logged_out/', {accessToken: self.cookz.accessToken, userEmail: self.cookz.userEmail});
    chrome.storage.local.set({lastSync: {status: "loggedOut"}});
  } else {
    sendLog("Got onInitialRequestError but user does not seeeem to be logged out" + error);
  }
}


// start shared code here: ----------------------------------------------------

function hashString(s) {
  // a simple hashing function taken from https://gist.github.com/iperelivskiy/4110988
  for (var i = 0, h = 0xdeadbeef; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 2654435761);
  return (h ^ h >>> 16) >>> 0;
}

function afterSendBookData(isLastBook) {
  if (isLastBook) {
    onDoneSync();
  } else {
    pullNextBook();
  }
}

function sendBookData(bookData, cookies, lastBook) {
  let payload = {
    bookData: bookData,
    accessToken: cookies.accessToken,
    userEmail: cookies.userEmail,
    sessionId: cookies.sessionid,
    v: getVersion(),
  };

  let hashedPayload = hashString(JSON.stringify(payload));
  console.log(payload)
  console.log(hashedPayload)
  let bookMatchesPreviousSync = self.syncedBookHashes.includes(hashedPayload) && !self.isForcedSync;
  let needToSendFinalBookToCreateResync = lastBook && self.syncedNewChanges;
  if (!needToSendFinalBookToCreateResync && (bookMatchesPreviousSync || bookData[self.currentBookId].quotes.length === 0)) {
    // Skip sending if we've already sent exactly the same data or it's a book with no highlights
    console.log("Skipping book: " + bookData[self.currentBookId].title)
    afterSendBookData(lastBook);
    return
  }

  console.log("Sending " + self.currentBookId + " (" + bookData[self.currentBookId].title + ")");

  postRequest(
    "/async_bd/",
    payload,
    function (resp) {
      console.log("Sent successfully. Saving hash to local storage...");
      self.syncedBookHashes.push(hashedPayload);
      self.syncedNewChanges = true;
      afterSendBookData(lastBook);
    }.bind(this),
    function (resp) {
      console.log("Sent with error.")
      afterSendBookData(lastBook);
    }.bind(this)
  );
}


function onDonePullingBook() {
  var el = self.currentBookEl;
  var bookId = self.currentBookId;
  var bookEl = el.querySelector("#annotation-scroller");
  var bookData = {};
  bookData[bookId] = {
    id: bookId,
    title: bookEl.querySelector("h3.kp-notebook-metadata").textContent.trim(),
    author: bookEl.querySelector(AUTHOR_SELECTOR).textContent.trim(),
    lastHighlightDate: self.allBookDates[bookId],
    quotes: {},
    imageUrl: bookEl.querySelector("img.kp-notebook-cover-image-border") && bookEl.querySelector("img.kp-notebook-cover-image-border").src,
    lastBook: self.currentBookIndex === self.allBookIds.length - 1,
  }

  var asinFromDom = el.querySelector("#kp-notebook-annotations-asin")?.value;
  if (asinFromDom !== bookId) {
    sendLog("Mismatching asins: bookId (" + bookId + ") vs asinFromDom (" + asinFromDom + "). Aborting.");

    // We end this sync, and hope if there's another thread running (which caused this bug) that
    // it can figure stuff out on its own...
    onDoneSync();
    return;
  }

  self.currentBookTitle = bookData[bookId].title;
  var highlightElements = el.querySelector('#kp-notebook-annotations').children;
  var highlightTextEl, locationEl, location;
  var highlightCount = 0;


  highlightElements.forEach(function (highlightEl, ind) {
    highlightTextEl = highlightEl.querySelector("#highlight");
    locationEl = highlightEl.querySelector("#kp-annotation-location");
    if (!locationEl || !highlightTextEl) {
      return; // skip the current element if it's not a highlight
    }
    highlightCount += 1;
    location = locationEl.value;
    location += "_" + highlightCount;

    var highlightHeaderText = highlightEl.querySelector('#annotationHighlightHeader')?.innerText;
    var highlightColor = highlightHeaderText && highlightHeaderText.split(" ")[0].trim().toLowerCase();
    var highlightNote = highlightEl.querySelector("#note")?.innerText || null;
    if (highlightNote) {
      // Fix highlightNote in weird edgecase
      highlightEl.querySelector("#note").innerHTML = highlightEl.querySelector("#note").innerHTML.replace(/<br>/mgi, "\n");
      highlightNote = highlightEl.querySelector("#note").innerText || null;
    }

    bookData[bookId].quotes[location] = {
      text: highlightTextEl.textContent.trim(),
      note: highlightNote,
      color: highlightColor,
    };
  });

  console.log("Pulled all " + Object.keys(bookData[bookId].quotes).length + " highlights for " + bookData[bookId].title)

  var unchangedBooksCutOff = 3

  getRkCookies(function (cookies) {
    if (self.bookCounts) {
      var onLastSync = self.bookCounts[bookId];

      var numNotes = Object.values(bookData[bookId].quotes).filter(function (q) {
        return q.note !== null;
      }).length;
      var numHighlights = Object.values(bookData[bookId].quotes).length;

      if (onLastSync && onLastSync.highlights === numHighlights) { // && onLastSync.notes === numNotes) {
        // If this book hasn't updated highlights, update the unchangedCount
        self.unchangedCount++;
        console.log("unchangedCount: " + self.unchangedCount);
      } else {
        // console.log("Found mismatch: cookies say " + (onLastSync && onLastSync.highlights) + " vs our " + numHighlights);
        // If this book DID have updates, set the unchangedCount back to 0
        self.unchangedCount = 0;
      }

      if (self.unchangedCount === unchangedBooksCutOff) {
        // If 3 books in a row haven't changed, set this book to be
        // lastBook so that we exit early and save a redundant resync
        bookData[bookId].lastBook = true;
      }
    }
    sendBookData(bookData, cookies, bookData[bookId].lastBook);
  }, true);

}

function pullBookPages(pageToken, contentLimitState, isRetry) {
  var isFirstRequest = !pageToken && !contentLimitState;
  var url = 'https://read.amazon.co.jp/notebook?asin=' + self.currentBookId;
  if (isFirstRequest) {
    // set the url to its regular state if we are on the first page
    url += '&contentLimitState=&';
  } else {
    url += '&token=' + pageToken +
        '&contentLimitState=' + contentLimitState + '&';
  }

  getRequest(url).then(function (html) {
    var el = createElement(html);
    var nextPageToken = el.querySelector('.kp-notebook-annotations-next-page-start')?.value;
    var nextContentLimitState = el.querySelector('.kp-notebook-content-limit-state')?.value;
    if (isFirstRequest) {
      self.currentBookEl = el;
    } else {
      self.currentBookEl.querySelector('#kp-notebook-annotations').innerHTML += el.toString();
    }

    if (nextPageToken) {
      return pullBookPages(nextPageToken, nextContentLimitState);
    } else {
      return onDonePullingBook();
    }
  }).catch(err => {
    if (isRetry) {
      // skip to the next book
      // TODO: there's still an edge case here where if this is the last book,
      // we won't send a book w/ the lastBook flag and thus won't create a resync
      sendLog("Failed twice fetch highlights for " + self.currentBookId + " ... SKIPPING book");
      pullNextBook();
    } else {
      // retry all failed requests once
      sendLog("First failure to fetch highlights for " + self.currentBookId + " ... trying again");
      pullBookPages(pageToken, contentLimitState, true)
    }
  });
}

function pullNextBook() {
  self.currentBookIndex += 1;
  if (self.currentBookIndex >= self.allBookIds.length) {
    console.log("Done from exhausting entire sidebar, finishing.");
    self.currentBookIndex -= 1; // just to clean up logging of num books synced
    onDoneSync();
    return;
  }

  self.currentBookId = self.allBookIds[self.currentBookIndex];
  self.currentBookEl = null;

  console.log("Starting to pull next book: " + self.currentBookId);

  pullBookPages();
}


function pullRemainingBookIds(bookIdsToken) {
  if (!bookIdsToken) {
    console.log("Pulled all book Ids from sidebar");
    return;
  }

  getRequest('https://read.amazon.co.jp/notebook?library=list&token=' + bookIdsToken).then(function (html) {
    var el = createElement(html);

    // add these new book ids to the end of our existing ones
    var newBookIds = el.querySelectorAll('.kp-notebook-library-each-book').map((b) => b.id);
    self.allBookIds.push.apply(self.allBookIds, newBookIds);

    el.querySelectorAll("[id^=kp-notebook-annotated-date-]").forEach(function (dateEl) {
      self.allBookDates[dateEl.id.replace("kp-notebook-annotated-date-", "")] = dateEl.value;
    });

    // pull potentially more book ids
    var nextBookIdsToken = el.querySelector('.kp-notebook-library-next-page-start')?.value;
    pullRemainingBookIds(nextBookIdsToken);
  });
}

async function startSync() {
  if (self.startedSyncing && self.startedSyncing > Date.now() - 27 * 60 * 1000 && !self.isForcedSync) {
    // if we're currently syncing, or were mid-syncing less than half an hour ago, don't try again
    sendLog("Sync was already started (and unfinished) in past hour), returning early.");
    return;
  }

  sendLog("Starting sync for " + (self.cookz ? self.cookz.userFirstName : 'unknown'));

  self.requestHeaders = {
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': navigator.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8,el;q=0.7',
  };

  // Global variables used in sync:
  self.allBookIds = null;
  self.allBookDates = null;
  self.currentBookIndex = null;
  self.currentBookEl = null;
  self.currentBookId = null;
  self.currentBookTitle = null;
  self.unchangedCount = 0;
  self.startedSyncing = Date.now();
  self.doneSyncing = false;
  self.syncedBookHashes = [];
  self.syncedNewChanges = false;

  // plus also:
  // self.bookCounts, self.isForcedSync,
  // self.azCookie, self.syncAfterTime
  // set after extension_check
  let lastHashesCleanupDate = await getStorage('lastHashesCleanupDate') || 0

  if (Date.now() - Number(lastHashesCleanupDate) > 2 * 24 * 3600 * 1000) { // clear storage every 2 days
    console.log('cleaning up syncedBookHashes');
    await removeStorage("syncedBookHashes")
    await setStorage('lastHashesCleanupDate', Date.now());
  }

  let alreadySyncedBooks = await getStorage('syncedBookHashes') || "[]"
  self.syncedBookHashes = JSON.parse(alreadySyncedBooks)

  var syncWindow = 25 * 60 * 60 * 1000  // 25 hours

  getRequest('https://read.amazon.co.jp/notebook').then(function (html) {
    const el = createElement(html);

    if (isMismatchedAmazonAccount(el)) {
      return;
    }
    self.allBookIds = el.querySelectorAll('.kp-notebook-library-each-book').map((b) => b.id);

    self.allBookDates = {};
    el.querySelectorAll("[id^=kp-notebook-annotated-date-]").forEach(function (dateEl) {
      self.allBookDates[dateEl.id.replace("kp-notebook-annotated-date-", "")] = dateEl.value;
    });

    var lastBook = el.querySelectorAll('.kp-notebook-library-each-book')[self.allBookIds.length - 1];
    var lastBookTime = lastBook && Date.parse(lastBook.querySelector('input')?.value);

    if (self.syncAfterTime !== 0 && lastBookTime < self.syncAfterTime && !self.isForcedSync) {
      // Filter out books that we saw in our previous syncs to hopefully speed this all up
      self.allBookIds = self.allBookIds.filter(function (bookId) {
        return Date.parse(self.allBookDates[bookId]) > self.syncAfterTime - syncWindow;
      });
      console.log("Filtered out books that we saw during the last sync. Down to " + self.allBookIds.length);
    } else {
      var nextBookIdsToken = el.querySelector('.kp-notebook-library-next-page-start')?.value;
      pullRemainingBookIds(nextBookIdsToken);
    }
    self.currentBookIndex = -1;
    self.currentBookEl = null;
    pullNextBook();

  }).catch(function (error) {
    self.startedSyncing = null;
    self.doneSyncing = true;
    self.allBookIds = null;
    onInitialRequestError(error);
  });
}

function forceStartSync(azCookie) {
  self.uniqueSyncId = Math.random().toString(36).substring(2, 15);
  self.isForcedSync = true;

  getRkCookies(function (cookies) {
    postRequest('/api/extension_check/', {
      force: true,
      accessToken: cookies.accessToken,
      uniqueSyncId: self.uniqueSyncId
    }, function (resp) {
      self.bookCounts = JSON.parse(resp.bookCounts);
      self.syncAfterTime = resp.syncAfterTime * 1000;
      self.azCookie = azCookie; // use the one sent from the DOM

      getRkCookies(function () {
        setTimeout(startSync, 100);
      }, true);
    });
  });
}

function checkAndMaybeStartBackgroundSync() {
  console.log("Woke up to check for sync at " + Date.now());
  self.uniqueSyncId = Math.random().toString(36).substring(2, 15);

  getRkCookies(function (cookies) {

    postRequest('/api/extension_check/', {
          accessToken: cookies.accessToken,
          uniqueSyncId: self.uniqueSyncId
        }, function (resp) {
          if (resp.status === "sync") {
            console.log("Backend check said to sync! " + cookies.userFirstName)
            self.bookCounts = JSON.parse(resp.bookCounts);
            self.syncAfterTime = resp.syncAfterTime * 1000;
            self.azCookie = resp.azCookie;
            self.isForcedSync = false;

            // re-parse our cookies just in case extension_check set some, then START OUR SYNC
            // (for some reason rollbar wont pick up errors unless we use a setTimeout here, lol)
            getRkCookies(function () {
              setTimeout(startSync, 100);
            }, true);
          } else if (resp.status === "skip") {
            console.log("skipping");
          } else if (resp.status === "invalidToken") {
            console.log("invalidToken");
            // if we don't have the accessToken cookie, maybe it'll be stored in storage?
            // send that over
            if (chrome && chrome.storage && chrome.storage.local) {
              chrome.storage.local.get("rkCookies", function (storageCookies) {
                sendLog("got invalidToken response from extension_check, here are the storageCookies: " + JSON.stringify(storageCookies));
              });
            }
          }
        }.bind(this),
        function (resp) {
          ;// TODO: what to do on web request error"?}
        }.bind(this)
    );
  });
}

// end shared code here: ----------------------------------------------------


function onInstallProcess() {
  // don't do the annoying sync start on-install locally by default
  // if (BASE_URL === "https://local.readwise.io:8000") {
  //   return;
  // }

  chrome.tabs.create({url: BASE_URL + "/kindle_welcome_start"});

  // Close the tab that opened the extension installation; it is no longer needed
  chrome.tabs.query({url: BASE_URL + '/welcome/start*'}, function (tabs) {
    if (tabs.length > 0) {
      chrome.tabs.remove(tabs[0].id);
    }
  });
  chrome.tabs.query({url: BASE_URL + '/welcome/sync*'}, function (tabs) {
    if (tabs.length > 0) {
      chrome.tabs.remove(tabs[0].id);
    }
  });
}

chrome.alarms.onAlarm.addListener(async function (alarm) {
  const alarmHandlers = {
    checkSync: checkAndMaybeStartBackgroundSync,
    checkLibraryBookSync: startLibraryBooksSync,
  };
  console.log(alarm)
  alarmHandlers[alarm.name]?.();
});


function setupAlarms() {
  const isProd = BASE_URL.indexOf("local") === -1;
  chrome.alarms.clear("checkSync", function () {
    const firstSyncDelay = isProd
      // in prod, don't try a background sync until an hour after first installation
      ? 60 * 60 * 1000
      // locally, start the first sync immediately
      : 1000;
    chrome.alarms.create("checkSync", {periodInMinutes: 30, when: Date.now() + firstSyncDelay});
  });
  chrome.alarms.clear("checkLibraryBookSync", function () {
    // don't try a background sync until 90 minutes after first installation
    const firstSyncDelay = 90 * 60 * 1000;
    chrome.alarms.create("checkLibraryBookSync", {periodInMinutes: 30, when: Date.now() + firstSyncDelay});
  });

}

chrome.runtime.onInstalled.addListener(function listener(details) {
  if (!/Firefox/i.test(navigator.userAgent)) {
    chrome.tabs.query({url: BASE_URL + '/welcome/start*'}, function (tabs) {

      if (tabs.length > 0) {
        onInstallProcess();
      } else {
        chrome.tabs.query({url: BASE_URL + '/welcome/sync*'}, function (tabs) {
          if (tabs.length > 0) {
            onInstallProcess();
          }
        });
      }
    });
    setupAlarms();
    setUpContextMenu();
    postRequest('/api/extension_login/', {});
  }
});

if (/Firefox/i.test(navigator.userAgent)) {
  setupAlarms();
  setUpContextMenu();
  postRequest('/api/extension_login/', {});
}

chrome.action.onClicked.addListener(function (tab) {
  chrome.tabs.create({url: BASE_URL + "/from_extension"});
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.command === "start") {
    if (self.startedSyncing && self.startedSyncing > Date.now() - 10 * 60 * 1000) {
      sendResponse({started: false});
      // don't allow user to start a new sync while one is already running as this causes major race conditions.
      // if we started more than 10mins ago, assume the last sync is over (failed) and try again.
      // this is a faster, necessary check than the one in startSync, which is for autosyncs.
      return;
    }
    // set these here to be extra safe of race conditions:
    self.startedSyncing = Date.now();
    self.doneSyncing = false;

    forceStartSync(request.azCookie);
    startLibraryBooksSync(true);

    sendResponse({started: true});
  } else if (request.command === "status") {
    sendResponse({
      doneSyncing: self.doneSyncing,
      currentBookIndex: self.currentBookIndex,
      numTotalBooks: self.allBookIds && self.allBookIds.length,
      currentBookTitle: self.currentBookTitle,
    })
  } else {
    sendResponse({});
  }
});

function showNotification(shortMessage, longMessage, onClickUrl) {
    const notificationId = (Math.random() + 1).toString(36).substring(7);

    chrome.notifications.create(notificationId, {
      iconUrl: 'data:image/png;base64,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',
      message: shortMessage + "\n" + longMessage,
      type: 'basic',
      title: 'Readwise'
    });
    chrome.notifications.onClicked.addListener(function(clickedNotificationId) {
        if (clickedNotificationId === notificationId) {
            chrome.tabs.create({url: onClickUrl});
        }
    });
}


// The onClicked callback function.
function onContextMenuClick(info, tab) {
  console.log("onContextMenuClick")
  getRkCookies(function (cookies) {
    postRequest(
      '/api/v2/highlights/',
        {
        'highlights': [{
          'text': info['selectionText'],
          'title': tab['title'],
          'url': (info['pageUrl'].indexOf("chrome-extension://") !== -1 && info['srcUrl']) ? info['srcUrl'] : info['pageUrl'],
          'source_type': 'web_clipper',
        },],
        'isWebClipper': true,
      },
      function (resp) {
        showNotification("Highlight saved to your library ✨", "Click to view.", resp[0].highlights_url);
      },
      function () {
        showNotification("❌ Failed to save highlight.", "Are you logged out? Click here to login.", "https://readwise.io/accounts/login");
      },
      {'Authorization': 'Token ' + cookies.accessToken},
    );
  });
};

function listenToContextMenuClicks() {
  if (!shouldHaveContextMenuItem) {
    return;
  }

  if (chrome.contextMenus && chrome.contextMenus.onClicked) {
    if (chrome.contextMenus.onClicked.hasListeners && chrome.contextMenus.onClicked.hasListeners()) {
      return;
    }

    console.log("setting up oncontextmenuclicks");
    chrome.contextMenus.onClicked.addListener(onContextMenuClick);
  }
}

function setUpContextMenu() {
  if (!shouldHaveContextMenuItem) {
    return;
  }

  console.log("setUpContextMenu")
  var context = "selection"
  var title = "Save Highlight to Readwise";

  if (chrome.contextMenus) {
    contextMenuItemId = chrome.contextMenus.create({
      "title": title, "contexts": [context],
      "id": "context" + context
    });
    console.log("'" + context + "' item:" + contextMenuItemId);
    listenToContextMenuClicks();
  }

  postRequest('/api/extension_login/', {});
}

chrome.runtime.onStartup.addListener(setUpContextMenu);

// We have to re-set this listener every single time the background page "wakes up"
// as chrome kills it often for non-persistent background pages
// For more deets, see: https://stackoverflow.com/a/27251743/1522443
listenToContextMenuClicks();

const removeContextMenuItem = () => {
  if (!shouldHaveContextMenuItem) {
    return; // Already done
  }

  if (!contextMenuItemId) {
    console.log("Context menu item removed");
    shouldHaveContextMenuItem = false;
    return;
  }

  console.log("Removing context menu item...");
  chrome.contextMenus.remove(contextMenuItemId, () => {
    console.log("Context menu item removed");
    shouldHaveContextMenuItem = false;
  });
};

const isFirefoxExtensionId = (id) => id.startsWith("{");
const extensionIdFilter = isFirefoxExtensionId(chrome.runtime.id) ? isFirefoxExtensionId : (id) => !isFirefoxExtensionId(id);
const webHighlighterExtensionIds = [
  "jjhefcfhmnkfeepcpnilbbkaadhngkbi", // Chrome
  // TODO: Firefox
].filter(extensionIdFilter);

chrome.runtime.onMessageExternal.addListener(
  (request, sender, sendResponse) => {
    if (webHighlighterExtensionIds.includes(sender.id) && request === 'i-exist') {
      sendResponse(true); // I also exist
      removeContextMenuItem();
    }
  }
);

webHighlighterExtensionIds.forEach((extensionId) => {
  chrome.runtime.sendMessage(extensionId, 'i-exist', (response) => {
    if (chrome.runtime.lastError) {
      if (!chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
        console.error("Unexpected error while contacting other extensions", chrome.runtime.lastError);
      }
      return;
    }
    if (response) { // It also exists
      removeContextMenuItem();
    }
  });
});
