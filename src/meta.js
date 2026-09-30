// ==UserScript==
// @name         bingetovlc — send Emby episodes to VLC
// @namespace    https://github.com/red4711/bingetovlc
// @version      {{VERSION}}
// @description  Adds a "Play in VLC" panel to the Emby web app. Queues one episode, a whole season or a whole show into VLC as a direct-play playlist — the original file, no transcoding, no background service.
// @author       red4711
// @license      MIT
// @homepageURL  https://github.com/red4711/bingetovlc
// @supportURL   https://github.com/red4711/bingetovlc/issues
// @updateURL    https://raw.githubusercontent.com/red4711/bingetovlc/main/dist/bingetovlc.user.js
// @downloadURL  https://raw.githubusercontent.com/red4711/bingetovlc/main/dist/bingetovlc.user.js
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Two metadata choices here are load-bearing.
 *
 * @grant none makes this script run in the page's own context, which is the only
 * way to read the Emby web client's ApiClient object: it holds the server
 * address, the access token and the current user id, and it is not exposed to the
 * DOM. No GM_ API is used anywhere, so nothing is lost — the script talks to Emby
 * through the page's own fetch and storage, exactly as the web app does.
 *
 * @match is deliberately broad (any scheme, any host, any path). Emby is served
 * from arbitrary addresses: the official app.emby.media host, a rented server, a
 * LAN address, or a custom domain behind a reverse proxy. There is no pattern
 * that covers them all, so the script has to look at every page and decide in
 * milliseconds whether it is an Emby client. main.js aborts before touching the
 * DOM when it is not. If you would rather not run it everywhere, narrow the match
 * pattern to your own server before installing.
 */
