// ==UserScript==
// @name         YT MINIMAL TEST
// @version      0.0.1
// @description  Minimal test to verify Tampermonkey works
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    console.log('████████████████████████████████████');
    console.log('██ MINIMAL TEST SCRIPT RUNNING!! ██');
    console.log('██ URL:', location.href);
    console.log('██ Time:', new Date().toISOString());
    console.log('████████████████████████████████████');

    // Alert for maximum visibility
    alert('MINIMAL TEST SCRIPT IS RUNNING!\n\nIf you see this alert, Tampermonkey is working.\n\nURL: ' + location.href);
})();
