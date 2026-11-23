// Local stand-in for the Artifact `room` capability (presence arm only), so co-op can be
// exercised with two tabs of the dev server: http://localhost:8080/?mock
// Uses BroadcastChannel; not a network transport.
(function () {
  const me = Math.random().toString(36).slice(2, 10);
  const ch = new BroadcastChannel('bw-mock-room');
  const peers = new Map();            // peer -> { presence, seen }
  let mine = {}, listeners = [], snapshot = Object.freeze([]);
  function rebuild() {
    const now = Date.now(), list = [{ peer: me, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: Object.freeze(Object.assign({}, mine)), updatedAt: now }];
    for (const [peer, p] of peers) {
      if (now - p.seen > 3000) { peers.delete(peer); continue; }
      list.push({ peer, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: p.presence, updatedAt: p.seen });
    }
    snapshot = Object.freeze(list);
    listeners.forEach((fn) => { try { fn({ peers: snapshot, joined: [], left: [], updated: [] }); } catch (e) { console.error(e); } });
  }
  ch.onmessage = (e) => { const d = e.data; if (!d || d.peer === me) return; peers.set(d.peer, { presence: Object.freeze(d.presence), seen: Date.now() }); rebuild(); };
  const send = () => ch.postMessage({ peer: me, presence: mine });
  setInterval(() => { send(); rebuild(); }, 500);
  const room = {
    presence(patch) {
      for (const k in patch) { if (patch[k] === null) delete mine[k]; else mine[k] = patch[k]; }
      const bytes = JSON.stringify(mine).length;
      if (bytes > 4096) { console.error('[mock room] presence over 4 KiB:', bytes); return Promise.reject({ code: 'invalid_argument' }); }
      window.__presenceBytes = bytes;
      send(); return Promise.resolve();
    },
    peers: () => snapshot,
    onPeers(fn) { listeners.push(fn); Promise.resolve().then(rebuild); return () => { listeners = listeners.filter((f) => f !== fn); }; },
    connected: () => true,
  };
  window.claude = { use: (name) => Promise.resolve(name === 'room' ? room : null) };
})();
