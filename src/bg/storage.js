const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage : chrome.storage;

// helper function to set data
export function setStorage(key, value) {
  return new Promise((resolve, reject) => {
    const data = {};
    data[key] = value;
    storage.local.set(data, function() {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        console.log(`${key} is set to ${value}`);
        resolve();
      }
    });
  });
}

// helper function to get data
export function getStorage(key) {
  return new Promise((resolve, reject) => {
    storage.local.get([key], function(result) {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        console.log(`${key} currently is ${result[key]}`);
        resolve(result[key]);
      }
    });
  });
}

// helper function to remove data
export function removeStorage(key) {
  return new Promise((resolve, reject) => {
    storage.local.remove([key], function() {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        console.log(`${key} is removed`);
        resolve();
      }
    });
  });
}
