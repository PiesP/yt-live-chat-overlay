/**
 * GM_* API mocks for yt-live-chat-overlay testing.
 * This file is designed to be copied into test HTML pages.
 * Usage: <script src="gm-mocks.js"></script>
 */

(function installYTGmMocks() {
  const storage = new Map();
  const listeners = new Map();
  let listenerId = 0;

  window.GM_setValue = async (key, value) => {
    storage.set(key, value);
    // Trigger listeners to simulate real behavior
    for (const [, { key: k, callback }] of listeners) {
      if (k === key) callback(key, undefined, value, false);
    }
  };

  window.GM_getValue = (key, defaultValue) => {
    return storage.has(key) ? storage.get(key) : defaultValue;
  };

  window.GM_deleteValue = (key) => {
    for (const [, { key: k, callback }] of listeners) {
      if (k === key) callback(key, storage.get(key), undefined, false);
    }
    storage.delete(key);
  };

  window.GM_registerMenuCommand = (name, callback) => {
    console.log('[GM] menu registered:', name, 'callback:', typeof callback);
  };

  window.GM_addValueChangeListener = (key, callback) => {
    const id = ++listenerId;
    listeners.set(id, { key, callback });
    return id;
  };

  window.GM_removeValueChangeListener = (id) => {
    listeners.delete(id);
  };

  console.log('[YT GM mocks] Installed. Storage size:', storage.size);
})();
