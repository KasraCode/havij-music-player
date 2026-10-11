'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const audio = $('#audio');
  const DB_NAME = 'havij-player-local-v1';
  const DB_VERSION = 3;
  const AUDIO_EXTENSIONS = new Set(['mp3','flac','m4a','aac','wav','ogg','opus','oga','wma','aiff','aif','mp4','3gp','amr']);
  const NAV_ITEMS = [
    { view: 'home', label: 'Home', icon: '⌂' },
    { view: 'library', label: 'Library', icon: '▤' },
    { view: 'playlists', label: 'Playlists', icon: '☷' },
    { view: 'favorites', label: 'Favorites', icon: '♡' },
    { view: 'settings', label: 'Settings', icon: '⚙' }
  ];
  const DEFAULT_STATE = {
    view: 'home', libraryTab: 'Songs', sortBy: 'Recently Added', sortDirection: 'desc',
    playlists: [], favorites: [], recent: [], currentId: null, currentTime: 0,
    queueIds: [], shuffle: false, shuffleQueue: [], shufflePos: 0, repeat: 'all', gain: 1, gainLimitPercent: 300,
    search: '', detail: null, modal: null, folders: [], importing: false, importProgress: '',
    lastSavedAt: 0
  };
  let state = structuredClone(DEFAULT_STATE);
  let db = null;
  let tracks = [];
  let trackById = new Map();
  let audioUrlCache = new Map();
  let coverUrlCache = new Map();
  const coverLoadsInProgress = new Set();
  const coverChecked = new Set();
  let coverObserver = null;
  // File objects are kept only in memory for the current session. They are never stored in IndexedDB.
  const sessionFiles = new Map();
  let audioContext = null;
  let gainNode = null;
  let compressorNode = null;
  let sourceNode = null;
  let saveTimer = null;
  let lastPersistedTime = 0;
  let importGeneration = 0;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const norm = value => String(value ?? '').trim().toLocaleLowerCase();
  const stableHash = value => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  };
  const extOf = name => (String(name).split('.').pop() || '').toLowerCase();
  const isAudioFile = file => {
    const ext = extOf(file.name);
    return AUDIO_EXTENSIONS.has(ext) || (file.type || '').startsWith('audio/');
  };
  const formatTime = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const n = Math.floor(seconds);
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  const formatSize = bytes => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B','KB','MB','GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  };
  const shuffleArray = array => {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const unique = values => [...new Set(values)];
  const isFileHandle = handle => !!handle && handle.kind === 'file' && typeof handle.getFile === 'function';
  const isDirectoryHandle = handle => !!handle && handle.kind === 'directory' && typeof handle.getDirectoryHandle === 'function';
  const hasDurableSource = track => isFileHandle(track?.fileHandle) || isDirectoryHandle(track?.sourceRootHandle);
  const playableTracks = () => tracks.filter(track => !track.missing && (hasDurableSource(track) || sessionFiles.has(track.id)));
  const findTrack = id => trackById.get(id) || null;
  const aliveIds = ids => unique((ids || []).filter(id => findTrack(id)));
  const playlistById = id => state.playlists.find(playlist => playlist.id === id) || null;
  const currentTrack = () => findTrack(state.currentId);
  const allTrackIds = () => playableTracks().map(track => track.id);

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('covers')) database.createObjectStore('covers', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local storage'));
    });
  }
  function txStore(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const req = txStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const req = txStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function dbPut(store, value) {
    return new Promise((resolve, reject) => {
      const req = txStore(store, 'readwrite').put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function dbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const req = txStore(store, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function dbClear(store) {
    return new Promise((resolve, reject) => {
      const req = txStore(store, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function stripLegacyAudioBlobs() {
    // Cursor one record at a time: avoid loading an entire old music library into memory during migration.
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('tracks', 'readwrite');
      const request = transaction.objectStore('tracks').openCursor();
      let failure = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const raw = cursor.value;
          const hasLegacyBytes = raw.blob instanceof Blob || raw.coverBlob instanceof Blob || 'blob' in raw || 'coverBlob' in raw;
          const missing = !hasDurableSource(raw);
          if (hasLegacyBytes || raw.missing !== missing) {
            const clean = { ...raw, missing };
            delete clean.blob;
            delete clean.coverBlob;
            cursor.update(clean);
          }
          cursor.continue();
        } catch (error) {
          failure = error;
          try { transaction.abort(); } catch { /* transaction may already be finished */ }
        }
      };
      request.onerror = () => { failure = request.error || new Error('Could not inspect legacy track records'); };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure || transaction.error || new Error('Could not migrate legacy audio storage'));
      transaction.onabort = () => reject(failure || transaction.error || new Error('Legacy audio storage migration was aborted'));
    });
  }
  function refreshTrackMap() { trackById = new Map(tracks.map(track => [track.id, track])); }

  function persistState(immediate = false) {
    if (!db) return;
    clearTimeout(saveTimer);
    const save = async () => {
      const data = {};
      for (const key of Object.keys(DEFAULT_STATE)) {
        if (!['view','libraryTab','sortBy','sortDirection','search','detail','modal','importing','importProgress','lastSavedAt'].includes(key)) data[key] = state[key];
      }
      data.view = state.view;
      data.libraryTab = state.libraryTab;
      data.sortBy = state.sortBy;
      data.sortDirection = state.sortDirection;
      data.folders = state.folders;
      data.lastSavedAt = Date.now();
      try { await dbPut('kv', { key: 'appState', value: data }); } catch (error) { console.warn('Unable to save player state', error); }
    };
    if (immediate) save(); else saveTimer = setTimeout(save, 180);
  }
  async function saveTrack(track) {
    // Keep only metadata and a cloneable file handle in persistent storage. No audio or cover Blob is saved.
    const stored = { ...track };
    delete stored.blob;
    delete stored.coverBlob;
    stored.missing = !hasDurableSource(track);
    try {
      await dbPut('tracks', stored);
    } catch (error) {
      // Some browsers expose a picker but cannot persist its handle. Keep session playback, but no bytes.
      if (!hasDurableSource(track)) throw error;
      console.warn('File handle could not be persisted; it will need to be reselected next session.', error);
      delete stored.fileHandle;
      delete stored.sourceRootHandle;
      stored.rootFolderName = '';
      stored.missing = true;
      await dbPut('tracks', stored);
      track.fileHandle = null;
      track.sourceRootHandle = null;
      track.rootFolderName = '';
    }
    const index = tracks.findIndex(item => item.id === track.id);
    if (index < 0) tracks.push(track); else tracks[index] = track;
    refreshTrackMap();
  }

  function toast(message, kind = 'info') {
    const region = $('#toastRegion');
    const item = document.createElement('div');
    item.className = 'toast';
    item.innerHTML = `<span class="toast-mark">${kind === 'error' ? '!' : '✓'}</span><span>${esc(message)}</span>`;
    region.appendChild(item);
    window.setTimeout(() => item.remove(), 3600);
  }
  function iconSvg(name) {
    const paths = {
      music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
      play: '<path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>',
      pause: '<path d="M8 5h4v14H8zM16 5h4v14h-4z" fill="currentColor" stroke="none"/>',
      shuffle: '<path d="m16 3 4 4-4 4M4 7h3c5 0 5 10 10 10h3M16 13l4 4-4 4M4 17h3c1.6 0 2.7-1.5 3.5-3"/>',
      repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
      heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
      next: '<path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
      previous: '<path d="m19 5-10 7 10 7z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
      list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 6h.01M3 12h.01M3 18h.01" stroke-width="3"/>',
      more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
      folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      album: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
      artist: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      download: '<path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/>',
      upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 20h16"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.9L6.1 12l1.4-2.4 1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1-.1 1.9Z" transform="translate(-1 -1)"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      queue: '<path d="M4 5h16M4 10h16M4 15h10M4 20h10"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/>',
      edit: '<path d="m4 16-.8 4.8L8 20l11.8-11.8a2.8 2.8 0 0 0-4-4zM14.5 5.5l4 4"/>',
      check: '<path d="m4 12 5 5L20 6"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      add: '<path d="M12 5v14M5 12h14"/>',
      headphones: '<path d="M3 13v-2a9 9 0 0 1 18 0v2M3 13h4v7H5a2 2 0 0 1-2-2zM21 13h-4v7h2a2 2 0 0 0 2-2z"/>',
      disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
      playNext: '<path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
      spark: '<path d="m12 3 1.6 6.4L20 12l-6.4 1.6L12 20l-1.6-6.4L4 12l6.4-2.6z"/>',
    };
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.music}</svg>`;
  }
  function fallbackArt(kind = 'music') {
    const icon = kind === 'folder' ? 'folder' : kind === 'album' ? 'album' : kind === 'artist' ? 'artist' : 'music';
    return `<div class="cover-fallback">${iconSvg(icon)}</div>`;
  }
  function objectUrlFor(track, which = 'cover') {
    if (!track) return '';
    const cache = which === 'cover' ? coverUrlCache : audioUrlCache;
    const blob = which === 'cover' ? track.coverBlob : null;
    if (!(blob instanceof Blob)) return '';
    if (!cache.has(track.id)) cache.set(track.id, URL.createObjectURL(blob));
    return cache.get(track.id);
  }
  async function compressCoverThumbnail(sourceBlob) {
    if (!(sourceBlob instanceof Blob) || !sourceBlob.size) return null;
    let bitmap = null;
    let objectUrl = '';
    try {
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(sourceBlob);
      } else {
        objectUrl = URL.createObjectURL(sourceBlob);
        const image = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Unsupported cover image'));
          img.src = objectUrl;
        });
        bitmap = image;
      }
      const width = Number(bitmap.width || bitmap.naturalWidth || 0);
      const height = Number(bitmap.height || bitmap.naturalHeight || 0);
      if (!width || !height) return null;
      const scale = Math.min(1, 320 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const encode = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
      const webp = await encode('image/webp', 0.78);
      if (webp && webp.size) return webp;
      const jpeg = await encode('image/jpeg', 0.78);
      return jpeg && jpeg.size ? jpeg : null;
    } catch (error) {
      console.debug('Could not compress embedded cover art', error);
      return null;
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  async function coverBlobId(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) { hash ^= bytes[i]; hash = Math.imul(hash, 16777619); }
    return `cover_${(hash >>> 0).toString(36)}_${bytes.length.toString(36)}`;
  }
  async function cacheCoverThumbnail(sourceBlob) {
    const thumbnail = await compressCoverThumbnail(sourceBlob);
    if (!thumbnail) return null;
    const id = await coverBlobId(thumbnail);
    try {
      const existing = await dbGet('covers', id);
      if (!existing) await dbPut('covers', { id, blob: thumbnail, type: thumbnail.type || 'image/webp', size: thumbnail.size });
      return { id, blob: existing?.blob instanceof Blob ? existing.blob : thumbnail };
    } catch (error) {
      // If quota/storage access fails, display the thumbnail for this session without breaking import.
      console.warn('Could not save the small cover thumbnail; keeping it for this session only.', error);
      return { id: '', blob: thumbnail };
    }
  }

  async function handleHasReadPermission(handle, requestPermission) {
    if (typeof handle?.queryPermission === 'function') {
      let permission = await handle.queryPermission({ mode: 'read' });
      if (permission !== 'granted' && requestPermission && typeof handle.requestPermission === 'function') {
        permission = await handle.requestPermission({ mode: 'read' });
      }
      if (permission && permission !== 'granted') return false;
    }
    return true;
  }
  async function fileForTrack(track, requestPermission = true) {
    if (!track) return null;
    if (sessionFiles.has(track.id)) return sessionFiles.get(track.id);
    try {
      // Prefer the selected root directory so one folder permission can cover an entire library.
      const root = track.sourceRootHandle;
      if (isDirectoryHandle(root) && await handleHasReadPermission(root, requestPermission)) {
        let relativeParts = String(track.relativePath || '').split('/').filter(Boolean);
        if (relativeParts[0] === track.rootFolderName) relativeParts.shift();
        if (relativeParts.length) {
          let directory = root;
          for (const part of relativeParts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
          const handle = await directory.getFileHandle(relativeParts[relativeParts.length - 1]);
          const file = await handle.getFile();
          if (file && isAudioFile(file)) return file;
        }
      }
      const handle = track.fileHandle;
      if (isFileHandle(handle) && await handleHasReadPermission(handle, requestPermission)) {
        const file = await handle.getFile();
        if (file && isAudioFile(file)) return file;
      }
    } catch (error) {
      console.warn('Could not access the original audio file:', track.name, error);
    }
    return null;
  }

  function setCurrentAudioFile(track, file) {
    const oldUrls = [...audioUrlCache.values()];
    audioUrlCache.clear();
    const url = URL.createObjectURL(file);
    audioUrlCache.set(track.id, url);
    audio.src = url;
    audio.load();
    for (const oldUrl of oldUrls) if (oldUrl !== url) setTimeout(() => URL.revokeObjectURL(oldUrl), 1000);
  }
  function coverMarkup(track, className = '', kind = 'music') {
    const trackAttr = track?.id ? ` data-cover-track="${esc(track.id)}"` : '';
    if (track && track.coverBlob instanceof Blob) {
      return `<div class="cover ${className}"${trackAttr}><img src="${esc(objectUrlFor(track, 'cover'))}" alt="Cover art for ${esc(track.title || track.name)}" loading="lazy"></div>`;
    }
    return `<div class="cover ${className}"${trackAttr}>${fallbackArt(kind)}</div>`;
  }

  function paintTrackCover(track) {
    if (!track || !(track.coverBlob instanceof Blob)) return;
    const src = objectUrlFor(track, 'cover');
    for (const element of $$('[data-cover-track]')) {
      if (element.dataset.coverTrack !== track.id) continue;
      element.innerHTML = `<img src="${esc(src)}" alt="Cover art for ${esc(track.title || track.name)}" loading="lazy">`;
    }
    updateMediaSession();
  }

  async function hydrateTrackCover(track, suppliedFile = null) {
    if (!track || track.coverBlob instanceof Blob || coverChecked.has(track.id) || coverLoadsInProgress.has(track.id)) return;
    coverLoadsInProgress.add(track.id);
    try {
      // Small, compressed album-art thumbnails are persisted separately from music files.
      if (track.coverId) {
        const cached = await dbGet('covers', track.coverId).catch(() => null);
        if (cached?.blob instanceof Blob) {
          track.coverBlob = cached.blob;
          coverChecked.add(track.id);
          paintTrackCover(track);
          return;
        }
      }
      // If no cached thumbnail exists, try to re-read the embedded art from the original file.
      // Do not request permission merely to show a thumbnail; Play can request it on user action.
      const file = suppliedFile || await fileForTrack(track, false);
      if (!file) return;
      const tags = await readAudioTags(file);
      coverChecked.add(track.id);
      if (tags.coverBlob instanceof Blob && tags.coverBlob.size > 0) {
        const cached = await cacheCoverThumbnail(tags.coverBlob);
        track.coverBlob = cached?.blob || tags.coverBlob;
        if (cached?.id) {
          track.coverId = cached.id;
          await saveTrack(track);
        }
        paintTrackCover(track);
      }
    } catch (error) {
      console.debug('Could not reload embedded cover art for', track.name, error);
    } finally {
      coverLoadsInProgress.delete(track.id);
    }
  }

  function scheduleCoverHydration() {
    const elements = $$('[data-cover-track]');
    if (!elements.length) return;
    if ('IntersectionObserver' in window) {
      if (!coverObserver) {
        coverObserver = new IntersectionObserver(entries => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            coverObserver.unobserve(entry.target);
            const track = findTrack(entry.target.dataset.coverTrack);
            if (track && !(track.coverBlob instanceof Blob) && !coverChecked.has(track.id)) void hydrateTrackCover(track);
          }
        }, { root: null, rootMargin: '240px' });
      }
      for (const element of elements) {
        const track = findTrack(element.dataset.coverTrack);
        if (track && !(track.coverBlob instanceof Blob) && !coverChecked.has(track.id)) coverObserver.observe(element);
      }
      return;
    }
    // Legacy-browser fallback: only inspect thumbnails near the viewport.
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.top < window.innerHeight + 240 && rect.bottom > -240) {
        const track = findTrack(element.dataset.coverTrack);
        if (track && !(track.coverBlob instanceof Blob) && !coverChecked.has(track.id)) void hydrateTrackCover(track);
      }
    }
  }
  function sortTracks(list) {
    const output = [...list];
    const fieldMap = { 'Title': 'title', 'Artist': 'artist', 'Album': 'album', 'Recently Added': 'addedAt', 'Duration': 'duration' };
    const key = fieldMap[state.sortBy] || 'addedAt';
    output.sort((a, b) => {
      let left = a[key], right = b[key];
      if (key === 'duration' || key === 'addedAt') { left = Number(left || 0); right = Number(right || 0); return state.sortDirection === 'asc' ? left - right : right - left; }
      const result = String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base', numeric: true });
      return state.sortDirection === 'asc' ? result : -result;
    });
    return output;
  }
  function getTracksByIds(ids) { return (ids || []).map(id => findTrack(id)).filter(Boolean); }
  function getCurrentContext() {
    if (state.view === 'playlist-detail' && state.detail?.type === 'playlist') return aliveIds(playlistById(state.detail.id)?.trackIds || []);
    if (state.view === 'detail' && state.detail) return detailTracks(state.detail).map(track => track.id);
    if (state.view === 'favorites' || (state.view === 'library' && state.libraryTab === 'Favorites')) return aliveIds(state.favorites);
    if (state.view === 'search') return searchResults().map(track => track.id);
    if (state.view === 'library' && state.libraryTab === 'Folders') return playableTracks().map(track => track.id);
    return allTrackIds();
  }
  function detailTracks(detail) {
    if (!detail) return [];
    const songs = playableTracks();
    const key = String(detail.key ?? '');
    if (detail.type === 'album') return songs.filter(song => (song.album || 'Unknown Album') === key);
    if (detail.type === 'artist') return songs.filter(song => (song.artist || 'Unknown Artist') === key);
    if (detail.type === 'folder') return songs.filter(song => folderFor(song) === key);
    if (detail.type === 'genre') return songs.filter(song => (song.genre || 'Unknown Genre') === key);
    return [];
  }
  function folderFor(track) {
    const path = String(track.relativePath || track.name || '');
    if (path.includes('/')) return path.split('/').slice(0, -1).join('/') || 'Music';
    return 'Imported songs';
  }
  function searchResults() {
    const query = norm(state.search);
    if (!query) return playableTracks();
    return playableTracks().filter(track => [track.title, track.artist, track.album, track.genre, track.relativePath, track.name].some(value => norm(value).includes(query)));
  }
  function groupedTracks(groupKey) {
    const groups = new Map();
    for (const song of playableTracks()) {
      const raw = groupKey === 'folder' ? folderFor(song) : (song[groupKey] || (groupKey === 'album' ? 'Unknown Album' : groupKey === 'artist' ? 'Unknown Artist' : 'Unknown Genre'));
      if (!groups.has(raw)) groups.set(raw, []);
      groups.get(raw).push(song);
    }
    return [...groups.entries()].map(([key, songs]) => ({ key, songs, count: songs.length, first: songs[0] })).sort((a,b) => keyCompare(a.key,b.key));
  }
  function keyCompare(a,b) { return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true }); }
  function trackRow(track, index, contextIds = [], opts = {}) {
    const isCurrent = track.id === state.currentId;
    const fav = state.favorites.includes(track.id);
    const missing = !!track.missing;
    const idsAttr = esc((contextIds || []).join(','));
    const album = track.album || 'Unknown Album';
    return `<div class="track-row ${isCurrent ? 'playing' : ''}" draggable="${opts.draggable ? 'true' : 'false'}" data-trackrow="${esc(track.id)}" ${opts.draggable ? `data-drag-id="${esc(track.id)}"` : ''}>
      <div class="track-index">${opts.draggable ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : `<span>${isCurrent && !audio.paused ? '♫' : (index + 1)}</span>`}</div>
      <div class="track-main">
        ${coverMarkup(track, '', 'album')}
        <div class="track-copy"><div class="track-title" data-action="play-track" data-id="${esc(track.id)}" data-context="${idsAttr}" data-missing="${missing}">${esc(track.title || track.name || 'Untitled')}${missing ? '<span class="missing-tag">Missing</span>' : ''}</div><div class="track-subtitle">${esc(track.artist || 'Unknown Artist')}</div></div>
      </div>
      <div class="track-album">${esc(album)}</div>
      <div class="track-duration">${missing ? '—' : formatTime(track.duration)}</div>
      <div class="track-actions">
        ${opts.playlistId ? `<button data-action="remove-playlist-track" data-id="${esc(track.id)}" data-playlist="${esc(opts.playlistId)}" title="Remove from playlist" aria-label="Remove from playlist">×</button>` : `<button class="${fav ? 'favorited' : ''}" data-action="toggle-favorite" data-id="${esc(track.id)}" title="${fav ? 'Remove favorite' : 'Add to favorites'}" aria-label="${fav ? 'Remove favorite' : 'Add to favorites'}">${fav ? '♥' : '♡'}</button><button data-action="add-track-playlist" data-id="${esc(track.id)}" title="Add to playlist" aria-label="Add to playlist">＋</button>`}
      </div>
    </div>`;
  }
  function trackList(ids, opts = {}) {
    const list = opts.tracks || getTracksByIds(ids);
    if (!list.length) return `<div class="track-list-empty">${esc(opts.emptyText || 'No songs here yet.')}</div>`;
    const context = opts.contextIds || list.map(song => song.id);
    const rows = list.map((track, i) => trackRow(track, i, context, opts)).join('');
    return `<div class="track-list"><div class="track-row header-row"><div></div><div>Title</div><div class="track-album">Album</div><div class="track-duration">Time</div><div></div></div>${rows}</div>`;
  }
  function emptyState(title, body, actionLabel = 'Import music', action = 'import-files') {
    return `<section class="empty-state"><div class="empty-orb"><img src="carrot.svg" alt=""></div><h2>${esc(title)}</h2><p>${esc(body)}</p><button class="primary-button" data-action="${esc(action)}">${iconSvg(action === 'import-files' ? 'plus' : 'music')}${esc(actionLabel)}</button><div class="small-hint">Your music stays on this device.</div></section>`;
  }
  function heading(eyebrow, title, subtitle = '', actions = '') {
    return `<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${subtitle ? `<p class="subheading">${esc(subtitle)}</p>` : ''}</div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
  }
  function sortControl() {
    const options = ['Recently Added','Title','Artist','Album','Duration'];
    return `<label class="sort-select">Sort by <select data-action="sort-change" aria-label="Sort tracks">${options.map(option => `<option ${state.sortBy === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
  }
  function playButton(ids, label = 'Play all', startId = '') {
    return `<button class="primary-button" data-action="play-context" data-ids="${esc(ids.join(','))}" data-startid="${esc(startId || ids[0] || '')}">${iconSvg('play')}${esc(label)}</button>`;
  }
  function shuffleButton(ids, label = 'Shuffle') {
    return `<button class="secondary-button" data-action="shuffle-context" data-ids="${esc(ids.join(','))}">${iconSvg('shuffle')}${esc(label)}</button>`;
  }
  function emptyLibraryView() {
    return emptyState('Your music, all in one place', 'Index your songs without copying the audio. Havij saves track details and playlists; playback reads the original files when access is available.', 'Import songs', 'import-files');
  }

  function renderHome() {
    const songs = playableTracks();
    const recent = state.recent.map(id => findTrack(id)).filter(track => track && !track.missing).slice(0,5);
    const added = [...songs].sort((a,b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0,4);
    const top = `<section class="hero-card"><div class="hero-copy"><p class="eyebrow">A little space for sound</p><h2>Your music.<br><em>Your mood.</em></h2><p>A quiet, personal library for the songs you keep coming back to. No feeds, no noise — just press play.</p><button class="primary-button" data-action="navigate" data-view="library">Explore your library <span>↗</span></button></div><div class="hero-art" aria-hidden="true"><div class="hero-orbit"></div><span class="spark one"></span><span class="spark two"></span><span class="spark three"></span><div class="hero-disc"><div class="hero-disc-center"><img src="carrot.svg" alt=""></div></div></div></section>`;
    const quick = `<section class="content-section"><div class="quick-grid"><button class="quick-card" data-action="navigate" data-view="library"><span class="quick-top"><span class="quick-symbol">${iconSvg('music')}</span><span class="quick-arrow">↗</span></span><span><strong>All songs</strong><small>${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}</small></span></button><button class="quick-card" data-action="quick-shuffle"><span class="quick-top"><span class="quick-symbol">${iconSvg('shuffle')}</span><span class="quick-arrow">↗</span></span><span><strong>Quick shuffle</strong><small>Let it surprise you</small></span></button><button class="quick-card" data-action="navigate" data-view="favorites"><span class="quick-top"><span class="quick-symbol">${iconSvg('heart')}</span><span class="quick-arrow">↗</span></span><span><strong>Favorites</strong><small>${state.favorites.filter(id => findTrack(id) && !findTrack(id).missing).length} saved tracks</small></span></button><button class="quick-card" data-action="navigate" data-view="playlists"><span class="quick-top"><span class="quick-symbol">${iconSvg('list')}</span><span class="quick-arrow">↗</span></span><span><strong>Your playlists</strong><small>${state.playlists.length} collections</small></span></button></div></section>`;
    if (!songs.length) return `${heading('HOME','Welcome to Havij','A local music player that keeps your collection private.')} ${top}${quick}<section class="content-section">${emptyLibraryView()}</section>`;
    const recentSection = recent.length ? `<section class="content-section"><div class="section-heading"><div><h2>Pick up where you left off</h2><p class="section-caption">Your recently played tracks</p></div><button data-action="navigate" data-view="library">View library ↗</button></div>${trackList(recent.map(t => t.id), { tracks: recent, contextIds: allTrackIds() })}</section>` : '';
    const addedSection = `<section class="content-section"><div class="section-heading"><div><h2>Recently added</h2><p class="section-caption">Freshly in your library</p></div><button data-action="navigate" data-view="library">See all ↗</button></div><div class="horizontal-cards">${added.map(song => `<article class="media-card" data-action="play-track" data-id="${esc(song.id)}" data-context="${esc(allTrackIds().join(','))}">${`<div class="media-card-art">${coverMarkup(song)}</div>`}<strong>${esc(song.title)}</strong><small>${esc(song.artist)}</small></article>`).join('')}</div></section>`;
    const playlistSection = state.playlists.length ? `<section class="content-section"><div class="section-heading"><div><h2>Made by you</h2><p class="section-caption">Your playlists, your rules</p></div><button data-action="navigate" data-view="playlists">All playlists ↗</button></div><div class="horizontal-cards">${state.playlists.slice(0,4).map(playlist => playlistCard(playlist)).join('')}</div></section>` : '';
    return `${heading('HOME','Welcome back','The right song can make a small moment feel like something.')} ${top}${quick}${recentSection}${addedSection}${playlistSection}`;
  }
  function playlistCard(playlist) {
    const available = aliveIds(playlist.trackIds || []).filter(id => !findTrack(id)?.missing);
    const first = getTracksByIds(available)[0];
    const art = first && first.coverBlob ? coverMarkup(first) : `<div class="cover-fallback">${iconSvg('list')}</div>`;
    return `<article class="media-card" data-action="open-playlist" data-id="${esc(playlist.id)}"><div class="media-card-art">${art}</div><strong>${esc(playlist.name)}</strong><small>${available.length} ${available.length === 1 ? 'song' : 'songs'}</small></article>`;
  }
  function renderLibrary() {
    const tabs = ['Songs','Albums','Artists','Folders','Genres','Favorites'];
    const tabMarkup = `<div class="pills">${tabs.map(tab => `<button class="pill ${state.libraryTab === tab ? 'active' : ''}" data-action="library-tab" data-tab="${tab}">${tab}</button>`).join('')}<label class="sort-select">Sort <select data-action="sort-change">${['Recently Added','Title','Artist','Album','Duration'].map(option => `<option ${state.sortBy === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label></div>`;
    if (!playableTracks().length) return `${heading('YOUR COLLECTION','Library','Import tracks once, then organize and play them locally.', `<button class="secondary-button" data-action="import-folder">${iconSvg('folder')}Choose folder</button><button class="primary-button" data-action="import-files">${iconSvg('plus')}Import songs</button>`)}${emptyLibraryView()}`;
    let content = '';
    if (state.libraryTab === 'Songs') {
      const sorted = sortTracks(playableTracks());
      const ids = sorted.map(track => track.id);
      content = `<div class="table-tools">${playButton(ids)}${shuffleButton(ids)}<span class="muted" style="font-size:11px;margin-left:auto">${ids.length} tracks</span></div>${trackList(ids, { tracks: sorted, contextIds: ids })}`;
    } else if (state.libraryTab === 'Favorites') {
      const favourites = state.favorites.map(findTrack).filter(track => track && !track.missing);
      const sorted = sortTracks(favourites);
      const ids = sorted.map(track => track.id);
      content = ids.length ? `<div class="table-tools">${playButton(ids)}${shuffleButton(ids)}<span class="muted" style="font-size:11px;margin-left:auto">${ids.length} tracks</span></div>${trackList(ids, { tracks: sorted, contextIds: ids })}` : emptyState('A little love goes a long way','Tap the heart next to any song to save it here.','Browse songs','navigate-library');
    } else {
      const groupKey = ({ Albums: 'album', Artists: 'artist', Folders: 'folder', Genres: 'genre' })[state.libraryTab];
      const groups = groupedTracks(groupKey);
      content = groups.length ? `<div class="album-grid">${groups.map(group => groupCard(group, groupKey)).join('')}</div>` : `<div class="track-list-empty">No ${state.libraryTab.toLowerCase()} yet.</div>`;
    }
    return `${heading('YOUR COLLECTION','Library',`${playableTracks().length} songs collected on this device.`, `<button class="secondary-button" data-action="import-folder">${iconSvg('folder')}Choose folder</button><button class="primary-button" data-action="import-files">${iconSvg('plus')}Import music</button>`)}${tabMarkup}${content}`;
  }
  function groupCard(group, type) {
    const kind = type === 'folder' ? 'folder' : type === 'artist' ? 'artist' : 'album';
    const art = coverMarkup(group.first, '', kind);
    return `<article class="media-card" data-action="open-detail" data-type="${esc(type)}" data-key="${esc(group.key)}"><div class="media-card-art">${art}<button class="round-button card-menu" data-action="shuffle-group" data-ids="${esc(group.songs.map(s => s.id).join(','))}" title="Shuffle ${esc(group.key)}" aria-label="Shuffle ${esc(group.key)}">${iconSvg('shuffle')}</button></div><strong>${esc(group.key)}</strong><small>${group.count} ${group.count === 1 ? 'song' : 'songs'}</small></article>`;
  }
  function renderDetail() {
    const detail = state.detail;
    if (!detail) { state.view = 'library'; return renderLibrary(); }
    if (detail.type === 'playlist') return renderPlaylistDetail(detail.id);
    const songs = detailTracks(detail);
    const ids = songs.map(song => song.id);
    const title = detail.key || 'Untitled';
    const kind = detail.type === 'folder' ? 'folder' : detail.type === 'artist' ? 'artist' : 'album';
    const countLabel = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;
    const byline = detail.type === 'artist' ? 'Artist collection' : detail.type === 'folder' ? 'Local folder' : detail.type === 'genre' ? 'Genre collection' : (songs[0]?.artist || 'Various artists');
    const art = coverMarkup(songs[0], '', kind);
    return `<div class="page-heading"><div><button class="soft-button" data-action="back-to-library">${iconSvg('back')} Back to library</button><p class="eyebrow" style="margin-top:20px">${esc(detail.type.toUpperCase())}</p></div><div class="heading-actions"><button class="secondary-button" data-action="import-files">${iconSvg('plus')}Add music</button></div></div><section class="detail-hero">${art}<div style="min-width:0;flex:1"><h1>${esc(title)}</h1><p>${esc(byline)} · ${countLabel}</p><div class="detail-actions">${playButton(ids, 'Play all', ids[0] || '')}${shuffleButton(ids)}</div></div></section><div class="section-heading"><h2>Tracks</h2>${sortControl()}</div>${trackList(sortTracks(songs).map(song => song.id), { tracks: sortTracks(songs), contextIds: ids, emptyText: 'Nothing in this collection yet.' })}`;
  }
  function renderPlaylistDetail(id) {
    const playlist = playlistById(id);
    if (!playlist) { state.view = 'playlists'; state.detail = null; return renderPlaylists(); }
    const all = getTracksByIds(playlist.trackIds || []);
    const ids = all.map(track => track.id);
    const first = all.find(track => !track.missing);
    const art = first ? coverMarkup(first, '', 'album') : `<div class="cover">${fallbackArt('album')}</div>`;
    const missingCount = all.filter(track => track.missing).length;
    return `<div class="page-heading"><div><button class="soft-button" data-action="back-playlists">${iconSvg('back')} All playlists</button><p class="eyebrow" style="margin-top:20px">YOUR PLAYLIST</p></div><div class="heading-actions"><button class="secondary-button" data-action="rename-playlist" data-id="${esc(id)}">${iconSvg('edit')}Rename</button><button class="secondary-button" data-action="delete-playlist" data-id="${esc(id)}">${iconSvg('trash')}Delete</button></div></div><section class="detail-hero">${art}<div style="min-width:0;flex:1"><h1>${esc(playlist.name)}</h1><p>${all.length} ${all.length === 1 ? 'song' : 'songs'}${missingCount ? ` · ${missingCount} missing` : ''}</p><div class="detail-actions">${playButton(ids.filter(trackId => !findTrack(trackId)?.missing), 'Play playlist')}${shuffleButton(ids.filter(trackId => !findTrack(trackId)?.missing))}<button class="secondary-button" data-action="add-songs" data-id="${esc(id)}">${iconSvg('plus')}Add songs</button></div></div></section><div class="section-heading"><div><h2>Playlist tracks</h2><p class="section-caption">Drag tracks to change their order.</p></div><button data-action="export-playlists">Backup all playlists ↗</button></div><div class="track-list"><div class="track-row header-row"><div></div><div>Title</div><div class="track-album">Album</div><div class="track-duration">Time</div><div></div></div>${all.length ? all.map((track,i) => trackRow(track, i, ids, { draggable: true, playlistId: id })).join('') : `<div class="track-list-empty">This playlist is empty. Add a few songs to get started.</div>`}</div>`;
  }
  function renderPlaylists() {
    const cards = state.playlists.length ? `<div class="album-grid">${state.playlists.map(playlist => playlistCard(playlist)).join('')}</div>` : emptyState('Make it yours','Create a playlist for your commute, late nights, long walks, or whatever mood finds you.','Create your first playlist','create-playlist');
    return `${heading('YOUR COLLECTION','Playlists','Build a soundtrack for any kind of day.', `<button class="secondary-button" data-action="import-playlists">${iconSvg('download')}Import backup</button><button class="secondary-button" data-action="export-playlists">${iconSvg('upload')}Backup</button><button class="primary-button" data-action="create-playlist">${iconSvg('plus')}New playlist</button>`)}${state.playlists.length ? `<div class="section-heading"><h2>Your collections</h2><span class="muted" style="font-size:11px">${state.playlists.length} playlists</span></div>${cards}<section class="content-section"><div class="warning-note">Playlist backups contain song references and ordering, not audio files. Keep your audio files on your device; import a backup later to reconnect matching tracks.</div></section>` : cards}`;
  }
  function renderFavorites() {
    const favs = state.favorites.map(findTrack).filter(track => track && !track.missing);
    const ids = favs.map(track => track.id);
    return `${heading('YOUR COLLECTION','Favorites','The songs that feel like yours.', ids.length ? `${playButton(ids)}${shuffleButton(ids)}` : '')}${ids.length ? trackList(sortTracks(favs).map(t => t.id), { tracks: sortTracks(favs), contextIds: ids }) : emptyState('Save the good ones','Tap the heart beside a song to keep it close. Your favorites stay saved on this device.','Browse your library','navigate-library')}`;
  }
  function renderSearch() {
    const results = searchResults();
    const ids = results.map(track => track.id);
    return `${heading('SEARCH','Results for “' + state.search + '”',`${results.length} matching ${results.length === 1 ? 'track' : 'tracks'}.`, ids.length ? `${playButton(ids)}${shuffleButton(ids)}` : '')}${state.search.trim() ? (results.length ? trackList(ids, { tracks: results, contextIds: ids }) : emptyState('No matches this time','Try a different title, artist, album, genre, or folder name.','Clear search','clear-search')) : `<p class="subheading">Search your local library by title, artist, album, genre, or folder.</p>`}`;
  }
  function renderNowPlaying() {
    const track = currentTrack();
    if (!track) return `${heading('NOW PLAYING','Nothing playing','Choose something from your library to get started.')} ${emptyState('Ready when you are','Pick a song and make this moment yours.','Open library','navigate-library')}`;
    const context = aliveIds(state.queueIds);
    return `${heading('NOW PLAYING','In the moment','Take your time.')}<section class="detail-hero" style="align-items:center;gap:28px;padding:28px;min-height:310px"><div style="flex:0 0 auto">${coverMarkup(track,'cover-hero')}</div><div style="min-width:0;flex:1"><p class="eyebrow">NOW PLAYING</p><h1>${esc(track.title)}</h1><p>${esc(track.artist || 'Unknown Artist')} · ${esc(track.album || 'Unknown Album')}</p><div class="detail-actions">${`<button class="round-button" data-action="previous" title="Previous">${iconSvg('previous')}</button><button class="primary-button" data-action="toggle-play">${iconSvg(audio.paused ? 'play' : 'pause')}${audio.paused ? 'Play' : 'Pause'}</button><button class="round-button" data-action="next" title="Next">${iconSvg('next')}</button>`}</div><div style="margin-top:22px;max-width:470px"><div class="dock-progress" style="position:static;gap:10px;pointer-events:auto"><time id="nowElapsed">${formatTime(audio.currentTime || state.currentTime)}</time><input id="nowPlayingSeek" class="seek-range" type="range" min="0" max="${Math.max(1, track.duration || audio.duration || 1)}" value="${audio.currentTime || state.currentTime || 0}" aria-label="Seek track"><time id="nowDuration">${formatTime(track.duration)}</time></div></div><div style="display:flex;gap:13px;align-items:center;margin-top:20px"><button class="round-button ${state.shuffle ? 'is-active' : ''}" data-action="toggle-shuffle" title="Shuffle">${iconSvg('shuffle')}</button><button class="round-button ${state.repeat !== 'off' ? 'is-active' : ''}" data-action="cycle-repeat" title="Repeat">${iconSvg('repeat')}${state.repeat === 'one' ? '<sup>1</sup>' : ''}</button><button class="round-button ${state.favorites.includes(track.id) ? 'is-active' : ''}" data-action="toggle-favorite" data-id="${esc(track.id)}" title="Favorite">${iconSvg('heart')}</button><button class="round-button" data-action="show-queue" title="Queue">${iconSvg('queue')}</button></div></div></section><section class="content-section"><div class="settings-card"><h3>Audio gain</h3><p>Adjust Havij playback only. High gain may cause distortion on some tracks.</p><div class="gain-line"><span class="muted" style="font-size:11px">0%</span><input type="range" min="0" max="${gainLimitMultiplier()}" step="0.01" value="${state.gain}" data-action="gain-change" aria-label="Audio gain"><span class="gain-value">${Math.round(state.gain * 100)}%</span></div></div></section><section class="content-section"><div class="section-heading"><h2>Up next</h2><button data-action="show-queue">View queue ↗</button></div>${trackList(context.slice(Math.max(0, context.indexOf(track.id) + 1), Math.max(0, context.indexOf(track.id) + 6)), { contextIds: context, emptyText: 'That is the end of this queue.' })}</section>`;
  }
  function renderSettings() {
    const available = playableTracks().length;
    const total = tracks.length;
    const missingCount = tracks.filter(track => track.missing).length;
    const folderRows = state.folders.length ? state.folders.map(folder => `<div class="setting-row"><div><strong>${esc(folder)}</strong><small>${playableTracks().filter(track => String(track.relativePath || '') === folder || String(track.relativePath || '').startsWith(`${folder}/`)).length} indexed tracks in this folder.</small></div><button class="secondary-button" data-action="remove-library-folder" data-folder="${esc(folder)}">Remove</button></div>`).join('') : `<div class="setting-row"><div><strong>No imported folders yet</strong><small>Select a folder to index its audio files.</small></div></div>`;
    const reconnectNote = missingCount ? `<div class="warning-note">${missingCount} track reference${missingCount === 1 ? ' needs' : 's need'} to be reconnected. This browser did not retain access to the original file${missingCount === 1 ? '' : 's'}. Choose the same files or folder again; playlists and favorites will be kept.</div>` : '';
    return `${heading('PREFERENCES','Settings','Make Havij feel right for your listening habits.')}<div class="settings-grid"><section class="settings-card"><h3>Music library</h3><p>Havij stores track details and file references only. It does not copy the songs into browser storage or change your original files.</p><div class="setting-row"><div><strong>Index audio files</strong><small>Choose songs. When supported, Havij remembers file handles so it can reopen the originals later.</small></div><button class="secondary-button" data-action="import-files">Choose files</button></div><div class="setting-row"><div><strong>Index a folder</strong><small>Best option when the browser supports persistent folder/file access.</small></div><button class="secondary-button" data-action="import-folder">Choose folder</button></div><div class="setting-row"><div><strong>Reconnect / add music</strong><small>Re-select originals if a permission expired or the browser only supported temporary file access.</small></div><button class="secondary-button" data-action="import-files">Choose files</button></div>${reconnectNote}<div class="setting-row" style="display:block"><div style="margin-bottom:4px"><strong>Indexed folders</strong><small>Removing a folder clears its index entries and saved file references only. It never deletes device files. Playlist references remain as Missing entries.</small></div>${folderRows}</div><div class="setting-row"><div><strong>Clear library data</strong><small>Removes Havij's track index and playlists, not the original music files.</small></div><button class="secondary-button" data-action="clear-library">Clear</button></div></section>
    <section class="settings-card"><h3>Storage on this device</h3><p>Audio bytes remain in their original location. Havij uses browser storage for track metadata, playlists, preferences, and file-access references—not full songs.</p><div style="display:flex;align-items:baseline;gap:7px"><strong style="font:700 29px Manrope">${available}</strong><span class="muted" style="font-size:11px">available tracks · ${total} indexed</span></div><div class="setting-row"><div><strong>Browser storage estimate</strong><small id="storageEstimate">Checking small app-data usage…</small></div><button class="secondary-button" data-action="storage-info">Refresh</button></div><div class="warning-note">Browser/site data still takes a small amount of space, and clearing it may remove playlists and stored file references. Export a playlist backup periodically. A browser may also forget file permissions, requiring you to reconnect songs.</div></section>
    <section class="settings-card"><h3>Playback</h3><p>Playback preferences are saved locally and restored when you reopen the app.</p><div class="setting-row"><div><strong>Audio gain</strong><small>Amplification is handled in this app when Web Audio is supported.</small></div><span class="gain-value">${Math.round(state.gain * 100)}%</span></div><div class="gain-line"><span class="muted" style="font-size:10px">0%</span><input type="range" min="0" max="${gainLimitMultiplier()}" step="0.01" value="${state.gain}" data-action="gain-change" aria-label="Audio gain"><span class="gain-limit-value">${state.gainLimitPercent}%</span></div><div class="setting-row gain-limit-row"><div><strong>Maximum gain limit</strong><small>Set the upper limit for all gain sliders. Higher values can cause distortion.</small></div><div class="gain-limit-control"><input id="gainLimitInput" type="number" min="1" max="100000" step="1" inputmode="numeric" value="${state.gainLimitPercent}" aria-label="Maximum gain percentage"><span>%</span><button class="secondary-button" data-action="set-gain-limit">Apply</button></div></div><div class="setting-row"><div><strong>Repeat mode</strong><small>Current setting: ${state.repeat === 'off' ? 'Off' : state.repeat === 'one' ? 'Repeat one' : 'Repeat all'}</small></div><button class="secondary-button" data-action="cycle-repeat">Change</button></div><div class="setting-row"><div><strong>Shuffle</strong><small>${state.shuffle ? 'On — current cycle is preserved.' : 'Off — queue order follows the selected list.'}</small></div><button class="secondary-button" data-action="toggle-shuffle">${state.shuffle ? 'Turn off' : 'Turn on'}</button></div></section>
    <section class="settings-card"><h3>Playlist backup</h3><p>Back up every playlist into one JSON file. Audio is never included.</p><div class="setting-row"><div><strong>Backup playlists</strong><small>Save playlist names, ordering, and track references.</small></div><button class="secondary-button" data-action="export-playlists">Export</button></div><div class="setting-row"><div><strong>Import backup</strong><small>Match indexed files by path and metadata; unmatched references remain marked Missing.</small></div><button class="secondary-button" data-action="import-playlists">Import</button></div></section>
    <section class="settings-card"><h3>About Havij</h3><p>A warm, quiet music player that keeps your listening local. Havij does not save audio copies or upload your library.</p><div class="setting-row"><div><strong>Havij Music Player</strong><small>Vanilla HTML, CSS and JavaScript · Local-first PWA</small></div><img src="carrot.svg" alt="Havij carrot mark" width="43" height="43"></div><div class="warning-note">Browser limitation: Havij cannot silently scan every phone folder. You must choose files or grant folder access through a supported browser picker. Persistent file access varies by browser; if unsupported, choosing files may only work until the browser session ends. Lock-screen/background behavior depends on the browser and device power settings.</div></section></div>`;
  }
  function renderMain() {
    const root = $('#mainView');
    if (state.search.trim()) state.view = 'search';
    if (!state.search.trim() && state.view === 'search') state.view = 'library';
    const views = {
      home: renderHome, library: renderLibrary, playlists: renderPlaylists, favorites: renderFavorites,
      settings: renderSettings, search: renderSearch, detail: renderDetail, 'playlist-detail': () => renderPlaylistDetail(state.detail?.id), nowplaying: renderNowPlaying
    };
    root.innerHTML = (views[state.view] || renderHome)();
    if (state.importing) root.insertAdjacentHTML('afterbegin', `<div id="importProgressBanner" class="busy-banner"><span class="spinner"></span>${esc(state.importProgress || 'Importing music…')}</div>`);
    $$('.side-link').forEach(link => link.classList.toggle('active', link.dataset.view === state.view || (state.view === 'detail' && link.dataset.view === 'library') || (state.view === 'playlist-detail' && link.dataset.view === 'playlists')));
    scheduleCoverHydration();
  }
  function renderSidebar() {
    $('#sidebarPlaylists').innerHTML = state.playlists.slice(0,7).map(playlist => `<button class="side-link" data-action="open-playlist" data-id="${esc(playlist.id)}"><span class="playlist-dot">♫</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(playlist.name)}</span></button>`).join('') || `<p style="padding:0 12px;color:#70685d;font-size:10px;line-height:1.6">Your playlists will show up here.</p>`;
  }
  function renderPlayer() {
    const track = currentTrack();
    const hasTrack = !!track && !track.missing;
    const playing = !audio.paused && hasTrack;
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number(track?.duration || 0);
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : Number(state.currentTime || 0);
    $('#playerDock').innerHTML = `<div class="dock-track">${coverMarkup(track, '', 'album')}<div class="track-copy"><div class="track-title" data-action="navigate" data-view="nowplaying" ${hasTrack ? '' : 'style="opacity:.65"'}>${esc(track?.title || 'Choose a song')}</div><div class="track-subtitle">${esc(track?.artist || (tracks.length ? 'Ready when you are' : 'Import your music to begin'))}</div></div><button class="dock-fav ${track && state.favorites.includes(track.id) ? 'active' : ''}" data-action="toggle-favorite" data-id="${esc(track?.id || '')}" ${hasTrack ? '' : 'disabled'} aria-label="Toggle favorite">${track && state.favorites.includes(track.id) ? '♥' : '♡'}</button></div>
    <div class="dock-center"><div class="transport"><button data-action="toggle-shuffle" class="${state.shuffle ? 'active' : ''}" title="Shuffle" aria-label="Shuffle">${iconSvg('shuffle')}</button><button data-action="previous" title="Previous" aria-label="Previous">${iconSvg('previous')}</button><button data-action="toggle-play" class="play-main" title="${playing ? 'Pause' : 'Play'}" aria-label="${playing ? 'Pause' : 'Play'}"><img src="carrot.svg" alt=""><span class="play-overlay">${playing ? 'Ⅱ' : '▶'}</span></button><button data-action="next" title="Next" aria-label="Next">${iconSvg('next')}</button><button data-action="cycle-repeat" class="${state.repeat !== 'off' ? 'active' : ''}" title="Repeat ${state.repeat}" aria-label="Repeat">${iconSvg('repeat')}${state.repeat === 'one' ? '<sup>1</sup>' : ''}</button></div><div class="dock-progress"><time id="dockElapsed">${formatTime(time)}</time><input id="dockSeek" class="seek-range" type="range" min="0" max="${Math.max(1,duration)}" value="${Math.min(time, Math.max(1,duration))}" style="--seek:${duration ? (time / duration * 100) : 0}%" aria-label="Seek track" ${hasTrack ? '' : 'disabled'}><time id="dockDuration">${formatTime(duration)}</time></div></div>
    <div class="dock-extras"><span class="dock-status">${state.shuffle ? 'Shuffle on' : state.repeat === 'one' ? 'Repeat one' : 'Local playback'}</span><button data-action="show-queue" title="Queue" aria-label="Queue">${iconSvg('queue')}</button><button data-action="navigate" data-view="nowplaying" title="Now playing" aria-label="Now playing">${iconSvg('headphones')}</button><input type="range" min="0" max="${gainLimitMultiplier()}" step="0.01" value="${state.gain}" data-action="gain-change" title="Audio gain (maximum ${state.gainLimitPercent}%)" aria-label="Audio gain"></div>`;
    scheduleCoverHydration();
  }
  function renderMobileNav() {
    $('#mobileNav').innerHTML = NAV_ITEMS.map(item => `<button data-action="navigate" data-view="${item.view}" class="${state.view === item.view || (item.view === 'library' && (state.view === 'detail' || state.view === 'search')) || (item.view === 'playlists' && state.view === 'playlist-detail') ? 'active' : ''}"><span>${item.icon}</span><span>${item.label}</span></button>`).join('');
  }
  function render() {
    renderSidebar(); renderMain(); renderPlayer(); renderMobileNav(); updateMediaSession();
  }
  function updateSeekUI() {
    const track = currentTrack();
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number(track?.duration || 0);
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : Number(state.currentTime || 0);
    const seek = $('#dockSeek');
    if (seek) { seek.max = String(Math.max(1, duration)); seek.value = String(Math.min(time, Math.max(1,duration))); seek.style.setProperty('--seek', `${duration ? time / duration * 100 : 0}%`); }
    const elapsed = $('#dockElapsed'); if (elapsed) elapsed.textContent = formatTime(time);
    const end = $('#dockDuration'); if (end) end.textContent = formatTime(duration);
    const nowSeek = $('#nowPlayingSeek'); if (nowSeek) { nowSeek.max = String(Math.max(1,duration)); nowSeek.value = String(Math.min(time, Math.max(1,duration))); }
    const nowElapsed = $('#nowElapsed'); if (nowElapsed) nowElapsed.textContent = formatTime(time);
    const nowDuration = $('#nowDuration'); if (nowDuration) nowDuration.textContent = formatTime(duration);
  }

  function ensureAudioGraph() {
    if (sourceNode) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      audioContext = new AudioContextCtor();
      sourceNode = audioContext.createMediaElementSource(audio);
      gainNode = audioContext.createGain();
      compressorNode = audioContext.createDynamicsCompressor();
      compressorNode.threshold.value = -8;
      compressorNode.knee.value = 8;
      compressorNode.ratio.value = 4;
      compressorNode.attack.value = 0.006;
      compressorNode.release.value = 0.18;
      sourceNode.connect(gainNode);
      gainNode.connect(compressorNode);
      compressorNode.connect(audioContext.destination);
      gainNode.gain.value = Number(state.gain || 0);
    } catch (error) {
      console.warn('Web Audio gain is unavailable; using normal media volume.', error);
      audioContext = null; sourceNode = null; gainNode = null; compressorNode = null;
    }
  }
  function gainLimitMultiplier() {
    const percent = Number(state.gainLimitPercent);
    return (Number.isFinite(percent) && percent >= 1 ? Math.min(percent, 100000) : 300) / 100;
  }
  async function applyGain(value, rerender = false) {
    const parsed = Number(value);
    const next = Math.max(0, Math.min(gainLimitMultiplier(), Number.isFinite(parsed) ? parsed : 0));
    state.gain = next;
    if (gainNode && audioContext) gainNode.gain.setTargetAtTime(next, audioContext.currentTime, 0.015);
    else { audio.volume = Math.min(1, next); if (next > 1) toast('This browser does not support audio amplification here; use a browser with Web Audio support.', 'error'); }
    $$('[data-action="gain-change"]').forEach(input => {
      input.max = String(gainLimitMultiplier());
      if (input !== document.activeElement) input.value = String(next);
    });
    $$('.gain-value').forEach(label => { if (/\d+%/.test(label.textContent)) label.textContent = `${Math.round(next * 100)}%`; });
    persistState();
    if (rerender) render();
  }
  async function setGainLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      toast('Enter a maximum gain of at least 1%.', 'error');
      return;
    }
    // Keep a finite upper bound to avoid invalid slider ranges; 100,000% is far beyond practical use.
    const percent = Math.round(Math.min(100000, parsed));
    state.gainLimitPercent = percent;
    if (state.gain > percent / 100) state.gain = percent / 100;
    await applyGain(state.gain, false);
    persistState(true);
    render();
    toast(`Maximum gain limit set to ${percent}%.`);
  }
  async function ensureAudioContextRunning() {
    ensureAudioGraph();
    if (audioContext && audioContext.state === 'suspended') {
      try { await audioContext.resume(); } catch (error) { console.warn('AudioContext resume failed', error); }
    }
  }
  async function playTrack(id, contextIds = null, options = {}) {
    const track = findTrack(id);
    if (!track || track.missing || (!hasDurableSource(track) && !sessionFiles.has(track.id))) {
      toast('The original file is not connected. Select the file or its folder again to reconnect it.', 'error'); return;
    }
    const isSameTrack = state.currentId === id;
    let chosenFile = null;
    if (!isSameTrack || !audio.src) {
      chosenFile = await fileForTrack(track, true);
      if (!chosenFile) {
        toast('Havij cannot access this original file. Re-select the file or folder and try again.', 'error');
        return;
      }
      if (!(track.coverBlob instanceof Blob)) void hydrateTrackCover(track, chosenFile);
    }
    if (!chosenFile && !(track.coverBlob instanceof Blob) && (hasDurableSource(track) || sessionFiles.has(track.id))) {
      const coverSource = await fileForTrack(track, true);
      if (coverSource) void hydrateTrackCover(track, coverSource);
    }
    const incomingContext = aliveIds(contextIds || state.queueIds || allTrackIds()).filter(trackId => !findTrack(trackId)?.missing);
    const queueSame = incomingContext.length === state.queueIds.length && incomingContext.every(trackId => state.queueIds.includes(trackId));
    if (incomingContext.length && !queueSame) state.queueIds = incomingContext;
    if (!state.queueIds.length) state.queueIds = incomingContext.length ? incomingContext : allTrackIds();
    state.currentId = id;
    if (!options.preservePosition) state.currentTime = isSameTrack ? (audio.currentTime || state.currentTime || 0) : 0;
    if (state.shuffle && state.shuffleQueue.includes(id)) {
      const picked = state.shuffleQueue.indexOf(id);
      if (picked > state.shufflePos) state.shufflePos = picked;
    } else if (state.shuffle && !state.shuffleQueue.length) {
      createShuffleCycle(state.queueIds, id);
    } else if (!state.shuffle && !queueSame && state.queueIds.length) {
      state.shuffleQueue = state.shuffleQueue || [];
    }
    if (state.recent[0] !== id) state.recent = [id, ...state.recent.filter(item => item !== id)].slice(0, 60);
    if (!isSameTrack || !audio.src) {
      try {
        audio.pause();
        setCurrentAudioFile(track, chosenFile);
        audio.addEventListener('loadedmetadata', function restorePosition() {
          audio.removeEventListener('loadedmetadata', restorePosition);
          const resumeTime = Number(state.currentTime || 0);
          if (resumeTime > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(resumeTime, Math.max(0, audio.duration - 0.5));
          updateSeekUI();
          if (options.autoplay !== false) actuallyPlay();
        }, { once: true });
        audio.addEventListener('error', function onLoadError() {
          audio.removeEventListener('error', onLoadError);
          if (state.currentId === id) toast(`The browser could not decode “${track.name}”. Try another supported audio format.`, 'error');
        }, { once: true });
      } catch (error) {
        console.error(error); toast('Could not load this audio file.', 'error'); return;
      }
    } else if (options.autoplay !== false) {
      await actuallyPlay();
    }
    persistState(true);
    render();
  }
  async function actuallyPlay() {
    const track = currentTrack();
    if (!track || track.missing) return;
    await ensureAudioContextRunning();
    try {
      await audio.play();
      renderPlayer(); updateMediaSession();
    } catch (error) {
      console.warn('Playback did not start', error);
      toast(error?.name === 'NotAllowedError' ? 'Tap Play again to start audio.' : 'The browser could not start playback for this file.', 'error');
    }
  }
  function pausePlayback() {
    audio.pause();
    state.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : state.currentTime;
    persistState(true); renderPlayer(); updateMediaSession();
  }
  async function togglePlayback() {
    const track = currentTrack();
    if (!track || track.missing) {
      const last = findTrack(state.currentId) && !findTrack(state.currentId).missing ? state.currentId : allTrackIds()[0];
      if (last) await playTrack(last, state.queueIds.length ? state.queueIds : allTrackIds());
      else toast('Import some music first.');
      return;
    }
    if (audio.paused && !audio.src) { await playTrack(track.id, state.queueIds.length ? state.queueIds : allTrackIds(), { preservePosition: true }); return; }
    if (audio.paused) await actuallyPlay(); else pausePlayback();
    render();
  }
  function createShuffleCycle(ids, startId = null) {
    let items = unique(aliveIds(ids).filter(id => !findTrack(id)?.missing));
    if (!items.length) items = allTrackIds();
    if (!items.length) { state.shuffleQueue = []; state.shufflePos = 0; return; }
    const start = startId && items.includes(startId) ? startId : null;
    const rest = items.filter(id => id !== start);
    let newOrder = start ? [start, ...shuffleArray(rest)] : shuffleArray(items);
    if (newOrder.length > 2 && state.shuffleQueue.length === newOrder.length && newOrder.every((id,i) => id === state.shuffleQueue[i])) {
      const first = newOrder.shift(); newOrder.splice(Math.min(1,newOrder.length), 0, first);
    }
    state.shuffleQueue = newOrder;
    state.shufflePos = start ? 0 : 0;
  }
  function toggleShuffle(forceContextIds = null) {
    const requestedContext = forceContextIds ? aliveIds(forceContextIds) : (state.queueIds.length ? state.queueIds : getCurrentContext());
    if (state.shuffle) {
      state.shuffle = false;
      toast('Shuffle off.');
    } else {
      state.shuffle = true;
      const ids = requestedContext.length ? requestedContext : allTrackIds();
      createShuffleCycle(ids, state.currentId && ids.includes(state.currentId) ? state.currentId : null);
      state.queueIds = ids;
      toast('Shuffle on — a new cycle is ready.');
    }
    persistState(true); render();
  }
  async function playContext(ids, startId = null, shuffle = false) {
    const clean = aliveIds(ids).filter(id => !findTrack(id)?.missing);
    if (!clean.length) { toast('There are no available songs in this list.'); return; }
    state.queueIds = clean;
    if (shuffle) {
      state.shuffle = true; createShuffleCycle(clean, startId && clean.includes(startId) ? startId : null);
      const first = state.shuffleQueue[0];
      await playTrack(first, clean);
      return;
    }
    await playTrack(startId && clean.includes(startId) ? startId : clean[0], clean);
  }
  async function nextTrack(manual = true) {
    const context = aliveIds(state.queueIds.length ? state.queueIds : allTrackIds()).filter(id => !findTrack(id)?.missing);
    if (!context.length) { pausePlayback(); return; }
    if (state.shuffle) {
      if (!state.shuffleQueue.length) createShuffleCycle(context, state.currentId);
      let nextPos = state.shufflePos + 1;
      while (nextPos < state.shuffleQueue.length && (!findTrack(state.shuffleQueue[nextPos]) || findTrack(state.shuffleQueue[nextPos]).missing)) nextPos++;
      if (nextPos >= state.shuffleQueue.length) {
        if (state.repeat === 'all') { createShuffleCycle(context, null); nextPos = 0; if (state.shuffleQueue[0] === state.currentId && state.shuffleQueue.length > 1) { [state.shuffleQueue[0], state.shuffleQueue[1]] = [state.shuffleQueue[1], state.shuffleQueue[0]]; } }
        else { pausePlayback(); if (state.currentId) { const duration = audio.duration || currentTrack()?.duration || 0; if (duration) audio.currentTime = duration; } return; }
      }
      state.shufflePos = nextPos;
      await playTrack(state.shuffleQueue[nextPos], context);
      return;
    }
    let pos = context.indexOf(state.currentId);
    if (pos < 0) pos = -1;
    if (pos + 1 >= context.length) {
      if (state.repeat === 'all') pos = -1;
      else { pausePlayback(); return; }
    }
    await playTrack(context[pos + 1], context);
  }
  async function previousTrack() {
    if (audio.currentTime > 3) { audio.currentTime = 0; state.currentTime = 0; updateSeekUI(); persistState(true); return; }
    const context = aliveIds(state.queueIds.length ? state.queueIds : allTrackIds()).filter(id => !findTrack(id)?.missing);
    if (state.shuffle) {
      if (state.shufflePos > 0) { state.shufflePos--; await playTrack(state.shuffleQueue[state.shufflePos], context); }
      else if (state.repeat === 'all' && state.shuffleQueue.length) { state.shufflePos = state.shuffleQueue.length - 1; await playTrack(state.shuffleQueue[state.shufflePos], context); }
      else if (state.currentId) { audio.currentTime = 0; updateSeekUI(); }
      return;
    }
    const position = context.indexOf(state.currentId);
    if (position > 0) await playTrack(context[position - 1], context);
    else if (state.repeat === 'all' && context.length) await playTrack(context[context.length - 1], context);
    else { audio.currentTime = 0; updateSeekUI(); }
  }
  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    toast(`Repeat ${state.repeat === 'off' ? 'off' : state.repeat === 'all' ? 'all tracks' : 'one track'}.`);
    persistState(true); render();
  }
  function toggleFavorite(id) {
    if (!id || !findTrack(id)) return;
    if (state.favorites.includes(id)) { state.favorites = state.favorites.filter(item => item !== id); toast('Removed from favorites.'); }
    else { state.favorites = unique([id, ...state.favorites]); toast('Added to favorites.'); }
    persistState(true); render();
  }
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = currentTrack();
    try {
      if (track && !track.missing) {
        let artwork = track.coverBlob instanceof Blob ? [{ src: objectUrlFor(track, 'cover'), sizes: '512x512', type: track.coverBlob.type || 'image/jpeg' }] : [];
        if (!artwork.length) {
          try { artwork = [{ src: new URL('carrot.svg', location.href).href, sizes: 'any', type: 'image/svg+xml' }]; } catch { artwork = []; }
        }
        navigator.mediaSession.metadata = new MediaMetadata({ title: track.title || track.name, artist: track.artist || 'Unknown Artist', album: track.album || 'Unknown Album', artwork });
        navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
      } else {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      }
      const handlers = {
        play: () => state.currentId ? playTrack(state.currentId, state.queueIds.length ? state.queueIds : allTrackIds(), { preservePosition: true }) : togglePlayback(), pause: () => pausePlayback(), previoustrack: () => previousTrack(), nexttrack: () => nextTrack(false),
        seekbackward: details => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); },
        seekforward: details => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 10)); },
        seekto: details => { if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime; }
      };
      for (const [action, handler] of Object.entries(handlers)) {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
      }
      if (Number.isFinite(audio.duration) && typeof navigator.mediaSession.setPositionState === 'function' && audio.duration > 0) {
        navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime || 0, audio.duration) });
      }
    } catch (error) { console.warn('Media session metadata update failed', error); }
  }

  function getId3Text(data, offset, size) {
    if (size < 2 || offset + size > data.length) return '';
    const encoding = data[offset];
    let bytes = data.subarray(offset + 1, offset + size);
    if (encoding === 1) return new TextDecoder('utf-16').decode(bytes).replace(/\0+$/g,'').trim();
    if (encoding === 2) return new TextDecoder('utf-16be').decode(bytes).replace(/\0+$/g,'').trim();
    if (encoding === 3) return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/g,'').trim();
    return new TextDecoder('windows-1252').decode(bytes).replace(/\0+$/g,'').trim();
  }
  function syncSafeInt(bytes, start = 0) { return ((bytes[start] & 0x7f) << 21) | ((bytes[start+1] & 0x7f) << 14) | ((bytes[start+2] & 0x7f) << 7) | (bytes[start+3] & 0x7f); }
  async function readAudioTags(file) {
    const result = {};
    try {
      const head = new Uint8Array(await file.slice(0,10).arrayBuffer());
      if (head.length >= 10 && String.fromCharCode(...head.slice(0,3)) === 'ID3') {
        const version = head[3];
        const tagSize = syncSafeInt(head,6);
        if (tagSize > 0 && tagSize < 24 * 1024 * 1024) {
          const bytes = new Uint8Array(await file.slice(10, 10 + tagSize).arrayBuffer());
          let offset = 0;
          if (head[5] & 0x40 && version === 3 && bytes.length > 4) offset = 4 + ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
          while (offset + 10 <= bytes.length) {
            const frameId = String.fromCharCode(...bytes.slice(offset,offset+4));
            if (!/^[A-Z0-9]{4}$/.test(frameId) || frameId === '\0\0\0\0') break;
            const frameSize = version === 4 ? syncSafeInt(bytes, offset+4) : ((bytes[offset+4] << 24) | (bytes[offset+5] << 16) | (bytes[offset+6] << 8) | bytes[offset+7]);
            if (!Number.isFinite(frameSize) || frameSize <= 0 || offset + 10 + frameSize > bytes.length) break;
            const bodyStart = offset + 10;
            const body = bytes.subarray(bodyStart, bodyStart + frameSize);
            const textMap = { TIT2:'title', TPE1:'artist', TALB:'album', TCON:'genre', TDRC:'year', TYER:'year', TRCK:'trackNumber' };
            if (textMap[frameId]) result[textMap[frameId]] = getId3Text(body,0,body.length);
            if (frameId === 'APIC' && body.length > 10) {
              const encoding = body[0];
              let cursor = 1;
              let mimeEnd = cursor;
              while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd++;
              const mime = new TextDecoder().decode(body.subarray(cursor,mimeEnd)) || 'image/jpeg';
              cursor = Math.min(mimeEnd + 2, body.length); // MIME terminator + picture type
              if (encoding === 1 || encoding === 2) {
                while (cursor + 1 < body.length && !(body[cursor] === 0 && body[cursor+1] === 0)) cursor += 2;
                cursor += 2;
              } else {
                while (cursor < body.length && body[cursor] !== 0) cursor++;
                cursor++;
              }
              if (cursor < body.length) result.coverBlob = new Blob([body.slice(cursor)], { type: mime });
            }
            offset += 10 + frameSize;
          }
        }
      }
      if (!result.title || !result.artist || !result.album) {
        const tail = new Uint8Array(await file.slice(Math.max(0,file.size-128),file.size).arrayBuffer());
        if (tail.length === 128 && String.fromCharCode(...tail.slice(0,3)) === 'TAG') {
          const readLatin = (start,length) => new TextDecoder('windows-1252').decode(tail.slice(start,start+length)).replace(/\0+$/g,'').trim();
          result.title ||= readLatin(3,30); result.artist ||= readLatin(33,30); result.album ||= readLatin(63,30); result.year ||= readLatin(93,4);
        }
      }
    } catch (error) { console.debug('Some metadata could not be read for', file.name, error); }
    return result;
  }
  async function probeDuration(file) {
    return new Promise(resolve => {
      const probe = document.createElement('audio');
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        probe.removeAttribute('src'); probe.load();
        clearTimeout(timer);
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        resolve(Number.isFinite(value) && value > 0 ? value : 0);
      };
      const url = URL.createObjectURL(file);
      const timer = setTimeout(() => finish(0), 1700);
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => finish(probe.duration), { once: true });
      probe.addEventListener('error', () => finish(0), { once: true });
      probe.src = url;
    });
  }
  function makeTrackId(file) { return `trk_${stableHash(`${norm(file.name)}|${file.size}|${file.lastModified || 0}`)}`; }
  async function prepareTrack(item) {
    const file = item.file || item;
    const relativePath = item.relativePath || file.webkitRelativePath || file.name;
    const fileHandle = isFileHandle(item.fileHandle) ? item.fileHandle : null;
    const sourceRootHandle = isDirectoryHandle(item.sourceRootHandle) ? item.sourceRootHandle : null;
    const id = makeTrackId(file);
    const old = findTrack(id);
    if (old && !old.missing) {
      // Keep the index; refresh the original-file handle whenever one is available.
      sessionFiles.set(id, file);
      coverChecked.delete(id);
      if (sourceRootHandle) { old.sourceRootHandle = sourceRootHandle; old.rootFolderName = item.rootFolderName || sourceRootHandle.name || ''; old.fileHandle = null; }
      else if (fileHandle) { old.fileHandle = fileHandle; old.sourceRootHandle = null; old.rootFolderName = ''; }
      if ((!old.relativePath || old.relativePath === old.name) && relativePath !== file.name) old.relativePath = relativePath;
      old.missing = false;
      await saveTrack(old);
      return { track: old, duplicate: true };
    }
    const tags = await readAudioTags(file);
    const cachedCover = tags.coverBlob instanceof Blob ? await cacheCoverThumbnail(tags.coverBlob) : null;
    const fileBase = file.name.replace(/\.[^.]+$/,'').replace(/[_]+/g,' ').trim() || file.name;
    const duration = await probeDuration(file);
    const track = {
      id, name: file.name, title: tags.title || fileBase, artist: tags.artist || 'Unknown Artist',
      album: tags.album || 'Unknown Album', genre: tags.genre || 'Unknown Genre', year: tags.year || '',
      trackNumber: tags.trackNumber || '', duration, size: file.size, type: file.type || `audio/${extOf(file.name)}`,
      lastModified: file.lastModified || 0, relativePath, addedAt: Date.now(), fileHandle, sourceRootHandle, rootFolderName: item.rootFolderName || sourceRootHandle?.name || '', coverId: cachedCover?.id || '', coverBlob: cachedCover?.blob || null, missing: false
    };
    sessionFiles.set(id, file); // Session-only reference: never write the File bytes to IndexedDB.
    coverChecked.delete(id);
    await saveTrack(track);
    return { track, duplicate: false };
  }
  async function walkDirectory(handle, prefix = '', rootHandle = handle) {
    const out = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') {
        if (AUDIO_EXTENSIONS.has(extOf(entry.name))) {
          try { out.push({ file: await entry.getFile(), fileHandle: entry, sourceRootHandle: rootHandle, rootFolderName: rootHandle.name || '', relativePath: `${prefix}${entry.name}` }); } catch (error) { console.warn('Cannot read selected file', entry.name, error); }
        }
      } else if (entry.kind === 'directory') {
        out.push(...await walkDirectory(entry, `${prefix}${entry.name}/`, rootHandle));
      }
    }
    return out;
  }
  async function importItems(items, folderNames = []) {
    const supported = items.filter(item => isAudioFile(item.file || item));
    if (!supported.length) { toast('No supported audio files found in that selection.', 'error'); return; }
    const generation = ++importGeneration;
    state.importing = true; state.importProgress = `Indexing ${supported.length} tracks without copying audio…`; render();
    const before = playableTracks().length;
    let cursor = 0, imported = 0, duplicates = 0, failed = 0;
    const workerCount = Math.min(4, supported.length);
    const worker = async () => {
      while (cursor < supported.length && generation === importGeneration) {
        const index = cursor++;
        const item = supported[index];
        state.importProgress = `Indexing ${index + 1} of ${supported.length} · ${item.file?.name || item.name}`;
        try {
          const result = await prepareTrack(item);
          if (result.duplicate) duplicates++; else imported++;
        } catch (error) { console.error('Import failed for track', item.file?.name || item.name, error); failed++; }
        if ((index % 3) === 0) renderProgressOnly();
      }
    };
    try {
      await Promise.all(Array.from({length: workerCount}, worker));
      await reconnectMissingTracks();
      for (const folder of folderNames) if (folder && !state.folders.includes(folder)) state.folders.push(folder);
      if (navigator.storage?.persist) { try { await navigator.storage.persist(); } catch { /* persistence is browser-controlled */ } }
      state.importing = false; state.importProgress = '';
      persistState(true); render();
      const after = playableTracks().length;
      toast(`${imported} added${duplicates ? ` · ${duplicates} already in library` : ''}${failed ? ` · ${failed} failed` : ''}. ${after - before} new tracks available.` , failed ? 'error' : 'info');
    } catch (error) {
      state.importing = false; state.importProgress = ''; render();
      console.error(error); toast('Indexing stopped because the browser could not save track metadata or file references.', 'error');
    }
  }
  function renderProgressOnly() {
    const banner = $('#importProgressBanner');
    if (banner) banner.innerHTML = `<span class="spinner"></span>${esc(state.importProgress)}`;
  }
  async function reconnectMissingTracks() {
    const missingTracks = tracks.filter(track => track.missing);
    if (!missingTracks.length) return;
    const newlyAvailable = playableTracks();
    for (const missing of missingTracks) {
      const match = newlyAvailable.find(track => {
        const samePath = norm(track.relativePath) === norm(missing.relativePath);
        const sameName = norm(track.name) === norm(missing.name);
        const sameMeta = norm(track.title) === norm(missing.title) && norm(track.artist) === norm(missing.artist) && norm(track.album) === norm(missing.album);
        return samePath || (sameName && (sameMeta || missing.artist === 'Unknown Artist' || !missing.artist)) || (sameMeta && missing.title && missing.title !== 'Untitled');
      });
      if (!match) continue;
      state.playlists.forEach(playlist => { playlist.trackIds = playlist.trackIds.map(id => id === missing.id ? match.id : id); });
      state.favorites = state.favorites.map(id => id === missing.id ? match.id : id);
      state.recent = state.recent.map(id => id === missing.id ? match.id : id);
      state.queueIds = state.queueIds.map(id => id === missing.id ? match.id : id);
      state.shuffleQueue = state.shuffleQueue.map(id => id === missing.id ? match.id : id);
      if (state.currentId === missing.id) state.currentId = match.id;
      tracks = tracks.filter(track => track.id !== missing.id); refreshTrackMap();
      await dbDelete('tracks', missing.id);
    }
  }
  async function chooseFiles() {
    if (typeof window.showOpenFilePicker === 'function' && window.isSecureContext) {
      try {
        const handles = await window.showOpenFilePicker({ multiple: true });
        const items = [];
        for (const fileHandle of handles) {
          try { items.push({ file: await fileHandle.getFile(), fileHandle, relativePath: fileHandle.name }); }
          catch (error) { console.warn('Could not read selected file handle', error); }
        }
        await importItems(items);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn('Persistent file picker unavailable; using the standard file input.', error);
        $('#fileInput').click();
      }
    } else {
      $('#fileInput').click();
    }
  }

  function isMobileBrowser() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent || ''));
  }
  function chooseMultipleAudioFilesForFolderFallback(reason = 'This browser does not provide folder access.') {
    // Some mobile browsers expose the webkitdirectory attribute but still show a single-file picker.
    // Use an ordinary multiple-file picker instead of silently importing only one item.
    toast(`${reason} Select multiple music files in the next picker, or use an up-to-date Chrome on Android for folder import.`, 'info');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.flac,.m4a,.aac,.wav,.ogg,.opus,.wma,.aiff';
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      if (files.length) await importItems(files.map(file => ({ file, relativePath: file.name })));
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  }
  async function chooseFolder() {
    if (typeof window.showDirectoryPicker === 'function' && window.isSecureContext) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read', startIn: 'music' });
        const entries = await walkDirectory(handle, `${handle.name || 'Selected folder'}/`);
        if (!entries.length) { toast('No supported audio files were found in that folder.', 'error'); return; }
        await importItems(entries, [handle.name || 'Selected folder']);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn('Directory picker failed.', error);
        if (isMobileBrowser()) chooseMultipleAudioFilesForFolderFallback('Folder access failed in this browser.');
        else $('#folderInput').click();
      }
    } else if (isMobileBrowser()) {
      chooseMultipleAudioFilesForFolderFallback('Folder selection is not supported by this browser version.');
    } else {
      $('#folderInput').click();
    }
  }

  function showModal(type, data = {}) {
    state.modal = { type, ...data };
    const root = $('#modalRoot');
    if (type === 'create-playlist' || type === 'rename-playlist') {
      const playlist = data.playlist || null;
      root.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><form class="modal" id="playlistForm"><h2>${playlist ? 'Rename playlist' : 'Create a playlist'}</h2><p>${playlist ? 'Give this collection a name that feels right.' : 'Start with a name. You can add and reorder songs later.'}</p><label for="playlistName">Playlist name</label><input id="playlistName" name="name" maxlength="80" required placeholder="e.g. Late night drives" value="${esc(playlist?.name || '')}" autocomplete="off"><div class="modal-actions"><button type="button" class="secondary-button" data-action="modal-close">Cancel</button><button type="submit" class="primary-button">${playlist ? 'Save name' : 'Create playlist'}</button></div></form></div>`;
      $('#playlistName').focus();
    } else if (type === 'add-songs') {
      const playlist = playlistById(data.id);
      const already = new Set(playlist?.trackIds || []);
      const all = sortTracks(playableTracks());
      root.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><section class="modal add-songs-modal" role="dialog" aria-modal="true" aria-labelledby="addSongsTitle"><h2 id="addSongsTitle">Add songs</h2><p>Choose tracks to add to <strong>${esc(playlist?.name || 'this playlist')}</strong>. Duplicate entries are skipped.</p><input id="addSongSearch" placeholder="Filter your library…" autocomplete="off"><div id="addSongChoices" class="add-song-choices">${all.map(track => `<label class="add-song-choice ${already.has(track.id) ? 'already-added' : ''}"><input class="add-song-checkbox" type="checkbox" data-add-track="${esc(track.id)}" ${already.has(track.id) ? 'disabled checked' : ''}><span class="add-song-art">${coverMarkup(track, '', 'album')}</span><span class="add-song-meta"><strong>${esc(track.title)}</strong><small>${esc(track.artist)}${already.has(track.id) ? ' · Already in playlist' : ''}</small></span></label>`).join('')}</div><div class="modal-actions"><button class="secondary-button" data-action="modal-close">Cancel</button><button class="primary-button" data-action="confirm-add-songs" data-id="${esc(data.id)}">Add selected</button></div></section></div>`;
      if (!all.length) $('#addSongChoices').innerHTML = '<p class="muted">Import music into your library first.</p>';
    } else if (type === 'add-track-playlist') {
      const song = findTrack(data.id);
      root.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><section class="modal"><h2>Add to playlist</h2><p>${esc(song?.title || 'This song')}</p>${state.playlists.length ? state.playlists.map(playlist => `<div class="setting-row"><div><strong>${esc(playlist.name)}</strong><small>${(playlist.trackIds || []).length} songs</small></div><button class="secondary-button" data-action="add-one-to-playlist" data-id="${esc(data.id)}" data-playlist="${esc(playlist.id)}">Add</button></div>`).join('') : '<p>You do not have any playlists yet.</p>'}<div class="modal-actions"><button class="secondary-button" data-action="modal-close">Close</button><button class="primary-button" data-action="create-playlist-from-track" data-id="${esc(data.id)}">New playlist</button></div></section></div>`;
    } else if (type === 'queue') {
      const ids = state.shuffle ? state.shuffleQueue : state.queueIds;
      const items = getTracksByIds(ids);
      root.innerHTML = `<div class="modal-backdrop queue-modal-backdrop" data-action="modal-backdrop"><section class="modal queue-modal" role="dialog" aria-modal="true" aria-labelledby="queueModalTitle"><h2 id="queueModalTitle">Up next</h2><p>${state.shuffle ? `Shuffle cycle · position ${state.shufflePos + 1} of ${ids.length}` : `${items.length} tracks in queue`}</p><div class="queue-modal-list">${items.map((track,i) => `<button class="playlist-row" style="width:100%;text-align:left;background:${track.id === state.currentId ? '#f59a5212' : 'transparent'};border:0;border-bottom:1px solid #ffffff0b" data-action="play-track" data-id="${esc(track.id)}" data-context="${esc(state.queueIds.join(','))}"><span class="track-index">${track.id === state.currentId ? '♫' : i+1}</span>${coverMarkup(track)}<span class="playlist-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)}</small></span>${track.id === state.currentId ? '<span style="color:var(--orange)">Playing</span>' : ''}</button>`).join('') || '<p>No tracks in the queue.</p>'}</div><div class="modal-actions"><button class="secondary-button" data-action="modal-close">Close</button>${shuffleButton(state.queueIds, 'Shuffle again')}</div></section></div>`;
    }
    scheduleCoverHydration();
  }
  function closeModal() { state.modal = null; $('#modalRoot').innerHTML = ''; }
  function reorderPlaylistTrack(playlistId, draggedId, targetId) {
    const playlist = playlistById(playlistId);
    if (!playlist || draggedId === targetId) return;
    const arr = [...playlist.trackIds];
    const from = arr.indexOf(draggedId), to = arr.indexOf(targetId);
    if (from < 0 || to < 0) return;
    arr.splice(from,1); arr.splice(to,0,draggedId); playlist.trackIds = arr;
    persistState(true); render();
  }

  async function exportPlaylists() {
    const payload = {
      app: 'Havij Music Player', format: 'havij-playlists', version: 1, exportedAt: new Date().toISOString(),
      playlists: state.playlists.map(playlist => ({
        name: playlist.name,
        createdAt: playlist.createdAt || 0,
        tracks: (playlist.trackIds || []).map(id => findTrack(id)).filter(Boolean).map(track => ({
          filename: track.name || '', title: track.title || '', artist: track.artist || '', album: track.album || '', genre: track.genre || '',
          year: track.year || '', duration: track.duration || 0, size: track.size || 0, originalPath: track.relativePath || track.name || '', lastModified: track.lastModified || 0
        }))
      }))
    };
    const blob = new Blob([JSON.stringify(payload,null,2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `havij-playlists-${new Date().toISOString().slice(0,10)}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${payload.playlists.length} playlists.`);
  }
  function matchBackupTrack(meta) {
    const available = playableTracks();
    const path = norm(meta.originalPath);
    let match = available.find(track => norm(track.relativePath) === path && path);
    if (match) return match;
    const file = norm(meta.filename);
    const artist = norm(meta.artist), album = norm(meta.album), title = norm(meta.title);
    match = available.find(track => norm(track.name) === file && norm(track.artist) === artist && norm(track.album) === album && file);
    if (match) return match;
    match = available.find(track => norm(track.name) === file && file);
    if (match) return match;
    return available.find(track => norm(track.title) === title && norm(track.artist) === artist && norm(track.album) === album && title && artist && album) || null;
  }
  async function importPlaylistBackup(file) {
    let payload;
    try { payload = JSON.parse(await file.text()); } catch { toast('That backup is not valid JSON.', 'error'); return; }
    if (!payload || !Array.isArray(payload.playlists)) { toast('This file does not contain a Havij playlist backup.', 'error'); return; }
    let playlistCount = 0, missingCount = 0;
    for (const source of payload.playlists) {
      if (!source || typeof source.name !== 'string' || !Array.isArray(source.tracks)) continue;
      const ids = [];
      for (const meta of source.tracks) {
        const match = matchBackupTrack(meta || {});
        if (match) { ids.push(match.id); continue; }
        const identity = `${meta.filename || ''}|${meta.title || ''}|${meta.artist || ''}|${meta.album || ''}|${meta.originalPath || ''}`;
        const id = `missing_${stableHash(identity)}`;
        if (!findTrack(id)) {
          const record = {
            id, name: meta.filename || meta.title || 'Missing track', title: meta.title || (meta.filename || 'Missing track').replace(/\.[^.]+$/,''),
            artist: meta.artist || 'Unknown Artist', album: meta.album || 'Unknown Album', genre: meta.genre || 'Unknown Genre',
            year: meta.year || '', duration: Number(meta.duration || 0), size: Number(meta.size || 0), type: '', lastModified: Number(meta.lastModified || 0),
            relativePath: meta.originalPath || meta.filename || '', addedAt: Date.now(), blob: null, coverBlob: null, missing: true
          };
          await saveTrack(record);
        }
        ids.push(id); missingCount++;
      }
      let name = source.name.trim() || 'Imported playlist';
      if (state.playlists.some(item => norm(item.name) === norm(name))) name = `${name} (imported)`;
      state.playlists.push({ id: `pl_${stableHash(`${name}|${Date.now()}|${Math.random()}`)}`, name, trackIds: unique(ids), createdAt: Date.now() });
      playlistCount++;
    }
    await reconnectMissingTracks(); persistState(true); render();
    toast(`Imported ${playlistCount} playlists${missingCount ? ` · ${missingCount} track references need reconnecting` : ''}.`);
  }
  async function removeFolderFromLibrary(folderName) {
    if (!folderName) return;
    const affected = playableTracks().filter(track => {
      const path = String(track.relativePath || '');
      return path === folderName || path.startsWith(`${folderName}/`);
    });
    if (!affected.length) { state.folders = state.folders.filter(folder => folder !== folderName); persistState(true); render(); toast('Folder removed from the library list.'); return; }
    if (!window.confirm(`Remove ${affected.length} indexed tracks from “${folderName}” in Havij? Original audio files will not be changed. Playlist entries will be kept as Missing.`)) return;
    const affectedIds = new Set(affected.map(track => track.id));
    if (affectedIds.has(state.currentId)) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.currentId = null; state.currentTime = 0; }
    for (const track of affected) {
      const removed = { ...track, fileHandle: null, sourceRootHandle: null, rootFolderName: '', coverBlob: null, missing: true };
      sessionFiles.delete(track.id);
      await saveTrack(removed);
      const audioUrl = audioUrlCache.get(track.id); if (audioUrl) URL.revokeObjectURL(audioUrl);
      const coverUrl = coverUrlCache.get(track.id); if (coverUrl) URL.revokeObjectURL(coverUrl);
      audioUrlCache.delete(track.id); coverUrlCache.delete(track.id);
      const index = tracks.findIndex(item => item.id === track.id); if (index >= 0) tracks[index] = removed;
    }
    refreshTrackMap();
    state.folders = state.folders.filter(folder => folder !== folderName);
    state.queueIds = aliveIds(state.queueIds); // Keep Missing records in queues/playlists to prevent silent deletion.
    state.shuffleQueue = aliveIds(state.shuffleQueue);
    persistState(true); render(); toast(`Removed ${affected.length} tracks from Havij. Original files are untouched.`);
  }
  async function clearLibrary() {
    if (!window.confirm('Clear Havij’s indexed music library and playlist data? The original audio files on your device will not be deleted.')) return;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    for (const track of tracks) await dbDelete('tracks', track.id);
    await dbClear('covers');
    for (const url of [...audioUrlCache.values(),...coverUrlCache.values()]) URL.revokeObjectURL(url);
    audioUrlCache.clear(); coverUrlCache.clear(); sessionFiles.clear(); coverChecked.clear(); coverLoadsInProgress.clear(); tracks = []; refreshTrackMap();
    state.favorites = []; state.recent = []; state.queueIds = []; state.shuffleQueue = []; state.shufflePos = 0; state.currentId = null; state.currentTime = 0; state.folders = []; state.playlists = []; state.shuffle = false;
    persistState(true); render(); toast('Havij library cleared. Your original files are untouched.');
  }
  async function refreshStorageInfo() {
    const target = $('#storageEstimate');
    if (!target) return;
    if (!navigator.storage?.estimate) { target.textContent = 'This browser does not expose a storage estimate.'; return; }
    try {
      const est = await navigator.storage.estimate();
      target.textContent = `${formatSize(est.usage || 0)} used of approximately ${formatSize(est.quota || 0)} available to this site.`;
    } catch { target.textContent = 'Storage estimate unavailable.'; }
  }

  function navigate(view) {
    state.search = '';
    $('#globalSearch').value = '';
    state.view = view;
    if (view !== 'detail' && view !== 'playlist-detail') state.detail = null;
    renderMain(); renderSidebar(); renderMobileNav(); persistState();
    $('#mainView').scrollTop = 0;
  }
  function backToLibrary() { state.view = 'library'; state.detail = null; render(); persistState(); }
  function openDetail(type, key) { state.view = 'detail'; state.detail = { type, key }; render(); persistState(); }
  function openPlaylist(id) { state.view = 'playlist-detail'; state.detail = { type:'playlist', id }; render(); persistState(); }

  document.addEventListener('click', async event => {
    const tappedRow = event.target.closest('[data-trackrow]');
    const clickedControl = event.target.closest('[data-action],button,input,select,a,.drag-handle');
    if (tappedRow && !clickedControl && !tappedRow.classList.contains('header-row')) {
      const playTarget = $('.track-title[data-action="play-track"]', tappedRow);
      if (playTarget && playTarget.dataset.missing !== 'true' && playTarget.dataset.id) {
        const ids = playTarget.dataset.context ? playTarget.dataset.context.split(',').filter(Boolean) : allTrackIds();
        await playTrack(playTarget.dataset.id, ids);
        if (state.view === 'nowplaying') render();
        return;
      }
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (button.disabled) return;
    if (action === 'navigate') { navigate(button.dataset.view || 'home'); return; }
    if (action === 'navigate-library') { navigate('library'); return; }
    if (action === 'import-files') { await chooseFiles(); return; }
    if (action === 'import-folder') { await chooseFolder(); return; }
    if (action === 'library-tab') { state.libraryTab = button.dataset.tab; state.view = 'library'; render(); persistState(); return; }
    if (action === 'sort-change') return;
    if (action === 'play-track') {
      const ids = button.dataset.context ? button.dataset.context.split(',').filter(Boolean) : (state.queueIds.length ? state.queueIds : allTrackIds());
      const id = button.dataset.id;
      await playTrack(id, ids);
      if (state.view === 'nowplaying') render();
      if (state.modal?.type === 'queue') closeModal();
      return;
    }
    if (action === 'play-context') { if (state.modal) closeModal(); await playContext((button.dataset.ids || '').split(',').filter(Boolean), button.dataset.startid || null, false); return; }
    if (action === 'shuffle-context' || action === 'shuffle-group') { if (state.modal) closeModal(); await playContext((button.dataset.ids || '').split(',').filter(Boolean), null, true); return; }
    if (action === 'quick-shuffle') { await playContext(allTrackIds(), null, true); return; }
    if (action === 'set-gain-limit') { await setGainLimit($('#gainLimitInput')?.value); return; }
    if (action === 'toggle-play') { await togglePlayback(); return; }
    if (action === 'next') { await nextTrack(); render(); return; }
    if (action === 'previous') { await previousTrack(); render(); return; }
    if (action === 'toggle-shuffle') { toggleShuffle(); return; }
    if (action === 'cycle-repeat') { cycleRepeat(); return; }
    if (action === 'toggle-favorite') { toggleFavorite(button.dataset.id); return; }
    if (action === 'open-detail') { openDetail(button.dataset.type, button.dataset.key); return; }
    if (action === 'open-playlist') { openPlaylist(button.dataset.id); return; }
    if (action === 'back-to-library') { backToLibrary(); return; }
    if (action === 'back-playlists') { navigate('playlists'); return; }
    if (action === 'create-playlist') { showModal('create-playlist'); return; }
    if (action === 'rename-playlist') { showModal('rename-playlist', { playlist: playlistById(button.dataset.id) }); return; }
    if (action === 'delete-playlist') {
      const playlist = playlistById(button.dataset.id);
      if (playlist && confirm(`Delete the playlist “${playlist.name}”? Original audio files will not be changed.`)) {
        state.playlists = state.playlists.filter(item => item.id !== playlist.id); if (state.view === 'playlist-detail') navigate('playlists'); else render(); persistState(true); toast('Playlist deleted.');
      }
      return;
    }
    if (action === 'add-songs') { showModal('add-songs', { id: button.dataset.id }); return; }
    if (action === 'add-track-playlist') { showModal('add-track-playlist', { id: button.dataset.id }); return; }
    if (action === 'add-one-to-playlist') {
      const playlist = playlistById(button.dataset.playlist), id = button.dataset.id;
      if (playlist && id) {
        if (!playlist.trackIds.includes(id)) { playlist.trackIds.push(id); persistState(true); toast(`Added to ${playlist.name}.`); }
        else toast('That song is already in this playlist.');
        closeModal(); render();
      }
      return;
    }
    if (action === 'create-playlist-from-track') { const id = button.dataset.id; showModal('create-playlist', { initialTrackId: id }); return; }
    if (action === 'confirm-add-songs') {
      const playlist = playlistById(button.dataset.id);
      if (!playlist) return;
      const selected = $$('[data-add-track]:checked', $('#modalRoot')).map(input => input.dataset.addTrack).filter(id => id && !inputIsDisabled(id));
      const before = playlist.trackIds.length; playlist.trackIds = unique([...playlist.trackIds, ...selected]);
      closeModal(); persistState(true); render(); toast(`${playlist.trackIds.length - before} songs added.`); return;
    }
    if (action === 'remove-playlist-track') {
      const playlist = playlistById(button.dataset.playlist), id = button.dataset.id;
      if (playlist) { playlist.trackIds = playlist.trackIds.filter(trackId => trackId !== id); persistState(true); render(); toast('Removed from playlist. The original audio file is unchanged.'); }
      return;
    }
    if (action === 'export-playlists') { await exportPlaylists(); return; }
    if (action === 'import-playlists') { $('#backupInput')?.click() || createBackupInput(); return; }
    if (action === 'show-queue') { showModal('queue'); return; }
    if (action === 'modal-close') { closeModal(); return; }
    if (action === 'modal-backdrop' && event.target === button) { closeModal(); return; }
    if (action === 'confirm-modal') return;
    if (action === 'clear-search') { state.search = ''; $('#globalSearch').value = ''; navigate('library'); return; }
    if (action === 'clear-library') { await clearLibrary(); return; }
    if (action === 'remove-library-folder') { await removeFolderFromLibrary(button.dataset.folder); return; }
    if (action === 'storage-info') { await refreshStorageInfo(); return; }
  });
  function inputIsDisabled(id) { const input = $(`[data-add-track="${CSS.escape(id)}"]`, $('#modalRoot')); return !input || input.disabled; }
  function createBackupInput() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true; input.addEventListener('change', async () => { if (input.files?.[0]) await importPlaylistBackup(input.files[0]); input.remove(); }); document.body.appendChild(input); input.click();
  }

  document.addEventListener('submit', async event => {
    if (event.target.id !== 'playlistForm') return;
    event.preventDefault();
    const name = ($('#playlistName')?.value || '').trim();
    if (!name) { toast('Give your playlist a name.', 'error'); return; }
    const modal = state.modal || {};
    if (modal.type === 'rename-playlist' && modal.playlist) {
      modal.playlist.name = name; toast('Playlist renamed.');
    } else {
      const playlist = { id: `pl_${stableHash(`${name}|${Date.now()}|${Math.random()}`)}`, name, trackIds: modal.initialTrackId ? [modal.initialTrackId] : [], createdAt: Date.now() };
      state.playlists.unshift(playlist); toast('Playlist created.');
    }
    closeModal(); persistState(true); render();
  });
  document.addEventListener('input', event => {
    const el = event.target;
    if (el.id === 'globalSearch') {
      state.search = el.value;
      if (state.search.trim()) state.view = 'search'; else if (state.view === 'search') state.view = 'library';
      renderMain(); renderMobileNav(); persistState(); return;
    }
    if (el.id === 'dockSeek' || el.id === 'nowPlayingSeek') {
      const next = Number(el.value); if (Number.isFinite(next) && Number.isFinite(audio.duration)) { audio.currentTime = Math.max(0, Math.min(next, audio.duration)); state.currentTime = audio.currentTime; updateSeekUI(); }
      return;
    }
    if (el.matches('[data-action="gain-change"]')) { applyGain(el.value); return; }
    if (el.id === 'addSongSearch') {
      const q = norm(el.value);
      $$('[data-add-track]', $('#addSongChoices')).forEach(input => {
        const label = input.closest('label');
        const content = norm(label?.textContent || '');
        if (label) label.style.display = content.includes(q) ? 'flex' : 'none';
      });
    }
  });
  document.addEventListener('change', async event => {
    const el = event.target;
    if (el.id === 'fileInput' || el.id === 'folderInput') {
      const files = [...(el.files || [])];
      if (files.length) {
        let folderName = '';
        if (el.id === 'folderInput') folderName = files[0].webkitRelativePath?.split('/')[0] || 'Selected folder';
        await importItems(files.map(file => ({ file, relativePath: file.webkitRelativePath || file.name })), folderName ? [folderName] : []);
      }
      el.value = ''; return;
    }
    if (el.type === 'range' && el.matches('[data-action="gain-change"]')) { await applyGain(el.value, true); return; }
    if (el.matches('[data-action="sort-change"]')) { state.sortBy = el.value; renderMain(); persistState(); return; }
  });
  // A dynamically-created backup picker keeps the main document small and avoids a dependency.
  let draggedTrackId = null;
  document.addEventListener('dragstart', event => {
    const row = event.target.closest('[data-drag-id]');
    if (!row || state.view !== 'playlist-detail') return;
    draggedTrackId = row.dataset.dragId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedTrackId);
    row.style.opacity = '.45';
  });
  document.addEventListener('dragend', event => { const row = event.target.closest('[data-drag-id]'); if (row) row.style.opacity = ''; draggedTrackId = null; });
  document.addEventListener('dragover', event => { if (event.target.closest('[data-drag-id]')) event.preventDefault(); });
  document.addEventListener('drop', event => {
    const row = event.target.closest('[data-drag-id]');
    if (!row || state.view !== 'playlist-detail') return;
    event.preventDefault();
    const dragged = event.dataTransfer.getData('text/plain') || draggedTrackId;
    reorderPlaylistTrack(state.detail?.id, dragged, row.dataset.dragId);
  });

  audio.addEventListener('play', () => { renderPlayer(); updateMediaSession(); });
  audio.addEventListener('pause', () => { renderPlayer(); updateMediaSession(); });
  audio.addEventListener('loadedmetadata', () => { updateSeekUI(); updateMediaSession(); });
  audio.addEventListener('durationchange', () => { updateSeekUI(); updateMediaSession(); });
  audio.addEventListener('timeupdate', () => {
    state.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    updateSeekUI();
    if (Date.now() - lastPersistedTime > 4500) { lastPersistedTime = Date.now(); persistState(); }
    if ('mediaSession' in navigator && Number.isFinite(audio.duration) && audio.duration > 0 && typeof navigator.mediaSession.setPositionState === 'function') {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime || 0, audio.duration) }); } catch { /* browsers may reject transient states */ }
    }
  });
  audio.addEventListener('ended', async () => {
    if (state.repeat === 'one') { audio.currentTime = 0; await actuallyPlay(); return; }
    await nextTrack(false);
  });
  audio.addEventListener('error', () => {
    if (state.currentId) {
      const track = findTrack(state.currentId);
      if (track && !track.missing) toast(`This browser cannot play ${track.name}. It may use an unsupported codec.`, 'error');
    }
  });
  window.addEventListener('beforeunload', () => {
    state.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : state.currentTime;
    persistState(true);
  });
  document.addEventListener('keydown', event => {
    if (event.target?.id === 'gainLimitInput' && event.key === 'Enter') { event.preventDefault(); void setGainLimit(event.target.value); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#globalSearch').focus(); }
    if (event.key === 'Escape' && state.modal) closeModal();
    if (event.code === 'Space' && !['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement?.tagName)) { event.preventDefault(); togglePlayback(); }
  });

  async function init() {
    try {
      db = await openDb();
      // One-time cleanup for older versions that stored complete audio files in IndexedDB.
      // A cursor removes legacy bytes one record at a time, preventing a large library being
      // loaded into memory as a single array. Tracks without durable file handles become Missing.
      await stripLegacyAudioBlobs();
      tracks = await dbGetAll('tracks');
      refreshTrackMap();
      const saved = await dbGet('kv','appState');
      if (saved?.value) state = { ...structuredClone(DEFAULT_STATE), ...saved.value, importing: false, importProgress: '', modal: null, search: '' };
      const savedGainLimit = Number(state.gainLimitPercent);
      state.gainLimitPercent = Number.isFinite(savedGainLimit) && savedGainLimit >= 1 ? Math.round(Math.min(savedGainLimit, 100000)) : 300;
      const savedGain = Number(state.gain);
      state.gain = Math.max(0, Math.min(state.gainLimitPercent / 100, Number.isFinite(savedGain) ? savedGain : 1));
      tracks = await dbGetAll('tracks'); refreshTrackMap();
      // Drop invalid queue references without creating a new shuffle cycle.
      state.queueIds = aliveIds(state.queueIds);
      state.shuffleQueue = aliveIds(state.shuffleQueue);
      if (state.currentId && !findTrack(state.currentId)) state.currentId = null;
      // Do not open audio sources on startup; resolve original file handles only when Play is pressed.
      // The saved position remains in state until the track's metadata is loaded.
      render(); updateSeekUI(); refreshStorageInfo();
      if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        navigator.serviceWorker.register('./sw.js').catch(error => console.debug('Service worker unavailable', error));
      }
      if (!playableTracks().length) state.view = 'home';
      render();
    } catch (error) {
      console.error('Havij failed to initialize', error);
      $('#mainView').innerHTML = `<section class="empty-state"><div class="empty-orb"><img src="carrot.svg" alt=""></div><h2>Local storage is unavailable</h2><p>Havij needs IndexedDB to store imported tracks and playlists. Open the app in a modern browser and make sure site storage is enabled.</p></section>`;
      $('#playerDock').innerHTML = '';
    }
  }
  init();
})();
