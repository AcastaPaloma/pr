/* BREAKWATER — net: two pilots, one machine.
 * Uses the Artifact `room` capability's PRESENCE arm only (anyone admitted to the room may set presence;
 * it is coalesced ~30 Hz and always carries absolute state, so dropped packets do not matter):
 *   host presence    { bw: 1, r: 'h', code, s: <world snapshot> }
 *   co-pilot presence{ bw: 1, r: 'c', code, i: <their controls> }
 * The host simulates; the co-pilot renders the snapshot and sends controls. Nothing here is authority
 * over anything but this game session, and everything received is treated as untrusted numbers.
 */
(function () {
  'use strict';
  const BW = window.BW;
  const N = (BW.Net = { available: false, ready: false, role: 'solo', code: '', linked: false, remote: null, hosts: [], onChange: null });
  let room = null, lastSend = 0, linkSeen = 0;
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  N.init = function () {
    const c = window.claude;
    if (!c || typeof c.use !== 'function') { N.ready = true; if (N.onChange) N.onChange(); return Promise.resolve(false); }
    return c.use('room').then((r) => {
      room = r || null;
      N.available = !!room;
      N.ready = true;
      if (room) {
        try { room.onPeers(() => scan(), () => { N.available = false; drop(); }); } catch (e) { /* stay solo */ }
      }
      if (N.onChange) N.onChange();
      return N.available;
    }).catch(() => { N.ready = true; if (N.onChange) N.onChange(); return false; });
  };
  function set(patch) { if (room) { try { const p = room.presence(patch); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } } }
  function drop() { N.linked = false; N.remote = null; if (N.onChange) N.onChange(); }

  function scan() {
    if (!room) return;
    let peers; try { peers = room.peers(); } catch (e) { return; }
    const hosts = []; let partner = null;
    for (const p of peers) {
      const pr = p && p.presence;
      if (!pr || pr.bw !== 1 || p.sameTab || typeof pr.code !== 'string') continue;
      if (pr.r === 'h') hosts.push({ code: pr.code.slice(0, 6), full: !!pr.full });
      if (N.role === 'host' && pr.r === 'c' && pr.code === N.code) partner = pr;
      if (N.role === 'co' && pr.r === 'h' && pr.code === N.code) partner = pr;
    }
    const was = N.linked, hostsKey = hosts.map((h) => h.code + h.full).join();
    N.remote = partner;
    N.linked = !!partner;
    if (N.linked) linkSeen = performance.now();
    const changed = was !== N.linked || hostsKey !== N._hk;
    N._hk = hostsKey; N.hosts = hosts;
    if (changed && N.onChange) N.onChange();
  }
  N.poll = function () { scan(); };

  N.host = function () {
    N.role = 'host';
    N.code = Array.from({ length: 4 }, () => ALPHA[(Math.random() * ALPHA.length) | 0]).join('');
    set({ bw: 1, r: 'h', code: N.code, s: null, i: null, full: false });
    scan();
  };
  N.join = function (code) {
    N.role = 'co'; N.code = code;
    set({ bw: 1, r: 'c', code, i: null, s: null });
    scan();
  };
  N.leave = function () {
    N.role = 'solo'; N.code = ''; N.linked = false; N.remote = null;
    set({ bw: null, r: null, code: null, s: null, i: null, full: null });
  };
  // host -> everyone: world snapshot (plain JSON, kept well under the 4 KiB presence limit)
  N.sendState = function (s, now) {
    if (N.role !== 'host' || now - lastSend < 45) return;
    lastSend = now;
    set({ s, full: N.linked });
  };
  // co-pilot -> host: controls
  N.sendInput = function (i, now) {
    if (N.role !== 'co' || now - lastSend < 33) return;
    lastSend = now;
    set({ i });
  };
  N.remoteState = function () { return N.role === 'co' && N.remote && N.remote.s && typeof N.remote.s === 'object' ? N.remote.s : null; };
  N.remoteInput = function () { return N.role === 'host' && N.remote && N.remote.i && typeof N.remote.i === 'object' ? N.remote.i : null; };
  N.sinceLink = function () { return performance.now() - linkSeen; };
})();
