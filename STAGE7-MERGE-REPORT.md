# Hesabdari Stage7 Merge

Base: Stage6 runtime from the verified app.asar.

Preserved runtime files:
- main.cjs
- preload.cjs
- src/app.js
- src/index.html
- src/styles.css
- assets/fonts/Vazirmatn-Regular.woff2
- assets/fonts/Vazirmatn-Bold.woff2

Imported build infrastructure from GitHub baseline:
- Electron 22.3.27
- electron-builder 23.6.0
- better-sqlite3 8.7.0
- @electron/rebuild 3.7.1
- ia32 Windows target
- NSIS + Portable targets
- dist-desktop output
- better-sqlite3 asarUnpack
- CI native rebuild and artifact verification

No Stage6 runtime source was replaced by GitHub source.
