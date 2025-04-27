import { self, getRkCookies, getRequest, postRequest, sendLog, getVersion } from "./common.js";
import { getStorage, setStorage } from "./storage.js";

const syncedLibraryBookAsinsStorageKey = "syncedLibraryBookAsins";

export async function startLibraryBooksSync(force) {
  if (self.startedLibraryBooksSyncing && self.startedLibraryBooksSyncing > Date.now() - 27 * 60 * 1000) {
    // if we're currently syncing, or were mid-syncing less than half an hour ago, don't try again
    sendLog("Library books sync was already started (and unfinished) in past hour), returning early.");
    return;
  }
  getRkCookies(async function (cookies) {
    postRequest(
      '/api/extension_lb_check/',
      {
        accessToken: cookies.accessToken,
        force: force ?? false,
      },
      async function (resp) {
        if (resp.status === "sync") {
          self.startedLibraryBooksSyncing = Date.now();
          const rawSyncedLibraryBookAsins = await getStorage(syncedLibraryBookAsinsStorageKey);
          self.syncedLibraryBookAsins = JSON.parse(rawSyncedLibraryBookAsins || "[]")
            // ditch books synced with previous sync version
            .filter(bookEntry => getStoredBookEntryVersion(bookEntry) === resp.syncVersion);
          pullLibraryBooks(resp.syncVersion);
        } else if (resp.status === "skip") {
          console.log("Library books sync skipped.");
        }
      },
      function () {
        console.log("Library books sync check failed.");
      }
    )
  });
}

async function finishLibraryBooksSync() {
  self.startedLibraryBooksSyncing = null;
  await setStorage(syncedLibraryBookAsinsStorageKey, JSON.stringify(self.syncedLibraryBookAsins));
}

function pullLibraryBooks(syncVersion, paginationToken) {
  getRkCookies(function (cookies) {
    console.log(`Pulling library books starting from item ${paginationToken || 0}...`);
    let query = new URLSearchParams({
      libraryType: 'BOOKS',
      // this lets us stop the sync once we encounter a book we already have synced before
      // note: when a sample book gets purchased, it goes to the top of this list
      sortType: 'acquisition_desc',
      querySize: 50,
      ...(paginationToken ? {paginationToken} : {}),
    });
    let url = 'https://read.amazon.co.jp/kindle-library/search?' + query.toString();
    return getRequest(url).then(async (json) => {
      const data = JSON.parse(json);
      const bookData =
        (data.itemsList || [])
          .map(bookItem => {
            return {
              asin: bookItem.asin,
              title: bookItem.title,
              author: (
                // "Smith Md, Edward M.:McExample, Peter S.": -> "Edward M. Smith Md, Peter S. McExample"
                (bookItem.authors[0] ?? "")
                .split(":")
                .filter(name => name.trim() !== "")
                .map(name => (
                  name.split(",").map(part => part.trim()).reverse().join(" ")
                ))
                .join(", ")
              ),
              small_image_url: bookItem.productUrl,
              is_sample: bookItem.resourceType === "EBOOK_SAMPLE",
            };
          })
          .filter(lb => !self.syncedLibraryBookAsins.includes(getStoredBookEntry(syncVersion, lb.asin, lb.is_sample)));

      if (!bookData.length) {
        console.log("No new library books to sync. Stopping library books sync.");
        await finishLibraryBooksSync();
        return;
      }
      return postRequest(
        "/async_lb/",
        {
          bookData,
          v: getVersion(),
          accessToken: cookies.accessToken,
          syncVersion,
        },
        async function (response) {
          console.log(`Library books batch pushed correctly. New entries: ${response.numCreated}.`);
          const syncedAsins = new Set(bookData.map(lb => lb.asin));
          self.syncedLibraryBookAsins = [
            // remove existing synced book entries with the synced ASINs
            // this is useful when book sample status changes
            ...(self.syncedLibraryBookAsins.filter(bookEntry => !syncedAsins.has(getStoredBookEntryASIN(bookEntry)))),
            // add book entries (new and with sample status changes)
            ...(bookData.map(lb => getStoredBookEntry(syncVersion, lb.asin, lb.is_sample))),
          ];
          // stop the whole sync if we encounter any ASIN we've already synced
          // we're sending books from the most recently added to library, it's safe to skip the rest
          if (data.paginationToken && bookData.length === response.numCreated) {
            pullLibraryBooks(syncVersion, data.paginationToken);
          } else {
            await finishLibraryBooksSync();
          }
        },
        async function (error) {
          console.log("Library books batch push error", error);
          await finishLibraryBooksSync();
        }
      );
    }).catch(async function (error) {
      console.log(`Pulling library books failed (${paginationToken})`, error);
      sendLog(`Pulling library books failed (${paginationToken})`);
      await finishLibraryBooksSync();
    });
  }, true);
}

function getStoredBookEntry(syncVersion, asin, isSample) {
  return `${syncVersion}:${asin}:${isSample ? "S" : "P"}`;  // e.g. "2:EXAMPLEASIN:S"
}

function getStoredBookEntryVersion(bookEntry) {
  return bookEntry.split(":")[0];  // e.g. "2:EXAMPLEASIN:S" -> "2"
}

function getStoredBookEntryASIN(bookEntry) {
  return bookEntry.split(":")[1];  // e.g. "2:EXAMPLEASIN:S" -> "EXAMPLEASIN"
}
