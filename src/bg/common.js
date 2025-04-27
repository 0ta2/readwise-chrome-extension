import { BASE_URL } from "./constants.js";

export const self = {};

export function getVersion() {
  if (self.isNativeApp) {
    return !self.isNativeAppBackground ? "app" : "appbg";
  }
  return self.isForcedSync ? "chrome" : "chromebg";
}

export function sendLog(message) {
  console.log("LOG: " + message)
  getRkCookies(function (cookies) {
    postRequest('/api/log/', {
      message: message,
      time: Date.now(),
      accessToken: cookies.accessToken,
      userEmail: cookies.userEmail,
      uniqueSyncId: self.uniqueSyncId,
    })
  });
}

export function postRequest(url, data, onSuccess, onError, extraHeaders={}) {
  const headers = {
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
  };

  return fetch(BASE_URL + url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(data)
  })
  .then(response => {
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    return response.json();
  })
  .then(data => {
    if (onSuccess) {
      onSuccess.call(this, data);
    }
  })
  .catch(error => {
    if (onError) {
      onError.call(this, error);
    }
  });
}

export function getRequest(url) {
  return fetch(url, {
    headers: self.requestHeaders,
  }).then(function (response) {
    if (!response.ok) {
      throw Error(response.statusText);
    }
    return response.text();
  });
}

export function getRkCookies(callback, forceRefresh) {
  if (self.cookz && self.cookz.accessToken && !forceRefresh) {
    return callback(self.cookz);
  }

  // If we didn't have the rw cookies cached, get them from chrome
  var cookieDomain;
  if (BASE_URL.indexOf("local") !== -1) {
    cookieDomain = ".local.readwise.io";
  } else {
    cookieDomain = ".readwise.io";
  }

  chrome.cookies.getAll({url: BASE_URL, domain: cookieDomain}, function (cookies) {
    self.cookz = {};
    cookies.forEach(function(c) {
      self.cookz[c.name] = c.value;
    });

    if (self.cookz.accessToken) {
      return callback(self.cookz);
    } else {
      // if we didn't get any good cookies for some reason (i.e no access token)
      // then try pulling the cookies from the chrome local storage
      chrome.storage.local.get("rkCookies", function (storageCookies) {
        if (storageCookies.rkCookies) {
          self.cookz = storageCookies.rkCookies;
          return callback(self.cookz);
        } else {
          // final failure: we have no cookies
          return callback({});
        }
      });
    }
  });
}
