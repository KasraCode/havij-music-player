# Havij Music Player — HTML/CSS/JavaScript PWA

Havij is a local-first music-player web app built with vanilla HTML, CSS, and JavaScript. It does not require React, npm, a backend, an account, or a third-party runtime library.

## Storage model: index files, do not copy songs

Havij is designed **not to save audio-file bytes in browser storage**. It stores track metadata (title, artist, album, duration, filename/path), playlists, favorites, playback state, and—where supported by the browser—persistent file handles. When you press Play, it reads the original audio file from its existing location.

- Modern browsers with the File System Access API can allow Havij to retain file/folder handles in IndexedDB. The browser may still ask for permission again later.
- If the browser only provides a standard file picker, Havij keeps the selected `File` reference in memory for the current session only. After closing/reopening the app, you may have to select those files again.
- Folder selection is preferred when supported. Havij remembers the selected file handles rather than copying the folder's songs.
- Music/audio files are never copied into browser storage. To keep thumbnails across sessions, Havij stores a small compressed copy of embedded cover art (resized to at most 320×320 px and deduplicated when the compressed bytes match). This is artwork only, not songs or full albums.
- Browser storage still contains a small amount of app data, metadata, file handles and cached app resources. It is not zero storage, but should be far smaller than a music library.

On startup, Havij removes legacy full-audio/cover Blobs from previous track records. Compact artwork thumbnails are stored separately in the `covers` object store. Tracks imported by older versions may not have cached thumbnails until you reselect their original files/folder. Older tracks without a retained file handle may be marked Missing; playlists and their ordering are retained.

## Features

- Import individual audio files or choose a folder where supported.
- Play, pause, seek, next, previous, shuffle, repeat one/all/off, and persistent shuffle queue.
- Browse songs, albums, artists, folders, genres, and search by metadata/path.
- Create, rename, delete and reorder playlists; add/remove tracks; tracks are never deleted from the device.
- Favorites, recently played, recently added, and responsive mini-player.
- Export and import playlists in one JSON backup. No audio is included. Unmatched tracks remain as Missing entries until reconnected.
- App-level gain through Web Audio where available, with a user-configurable maximum gain limit in Settings (default 300%).
- Media Session metadata and lock-screen/headset controls where supported.
- PWA app-shell caching for offline UI after loading from a secure origin.
- No music, filenames, playlists or listening history are uploaded; no analytics or advertising code.

## Run locally on a computer

Use a local server instead of opening `index.html` directly. From this directory, run:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` in a modern browser. On localhost, APIs that require a secure context are available where implemented by the browser.

## Use on Android

For installation as a PWA and service-worker support, host these static files on an **HTTPS** origin, open the address in Chrome for Android, and use **Install app** / **Add to Home screen**.

Open Havij's Settings and choose your songs/folder. When the browser supports persistent file handles, it can remember access to the originals. When it does not, the app indexes metadata and lets you play the selected files during the current session; you may need to reselect files after reopening. That limitation is imposed by browser APIs and permissions, not by the music-player UI.

## Important limitations

- A website cannot silently scan all phone storage or access Android's full MediaStore library. The user must explicitly select files/folders.
- Browser storage is still used for metadata, playlists, settings, the optional persistent file handles, and cached app resources. Havij does not intentionally store complete songs or albums in IndexedDB.
- If a file is moved, renamed, deleted or the browser revokes access, the track may need to be reconnected by selecting its original file/folder again. The playlist entry remains saved.
- Clearing site data can remove playlists and file handles; export a playlist backup periodically. Backup files include references and metadata, never music bytes.
- Codec support depends on the browser/OS. A file extension alone cannot guarantee playback support.
- Screen-off playback and lock-screen/media notification controls are controlled by the browser and operating system. The Media Session API is used where available, but background/battery policies may affect behavior.
- File System Access API support varies by browser and platform. Browsers that only offer an ordinary file picker cannot persist the selected `File` reference across restarts.
- Audio metadata currently reads common MP3 ID3v2/ID3v1 title, artist, album, genre, track/year and embedded cover-art tags where possible. Unsupported/missing metadata falls back to the filename.

## Files

- `index.html` — app layout and file input fallback
- `styles.css` — responsive dark/orange UI
- `app.js` — metadata index, file handles, playback, library, playlists, shuffle, backups and Media Session
- `manifest.webmanifest` — installable PWA metadata
- `sw.js` — offline app-shell caching
- `carrot.svg`, `carrot-192.png`, `carrot-512.png` — app icon assets

## Validation

The JavaScript source should pass `node --check app.js`. Actual file-handle persistence and playback need to be tested in the target Android browser with a real file and HTTPS-hosted installation, because API support and file permission behavior differ by browser and OS.

On Windows, `start-local.bat` starts the server on port 8000. Open `http://localhost:8000` for local testing. This is not a production/HTTPS host for installing the PWA on your phone.


## Android folder import and tap-to-play

Song rows can be tapped anywhere outside their action controls to start that track; the dedicated per-row Play icon has been removed. On mobile, the seek slider is attached to the top edge of the mini-player instead of floating over page content.

Folder import uses `showDirectoryPicker()` on secure origins where the browser implements it. Some mobile browsers do not support persistent folder selection; in those browsers Havij falls back to a standard multi-file chooser and explains that multiple songs can be selected. For true folder import on Android, use an updated Chrome version that supports the File System Access directory picker. If the browser does not support reusable file handles, imported selections may need to be reconnected after the app is closed.
