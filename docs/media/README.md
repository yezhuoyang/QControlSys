# README animations

The GIFs here are photographed from the running app, one trace step per frame, by [`capture.mjs`](capture.mjs).
Start the server (`npm start`), then run `PLAYWRIGHT_CORE=<folder with a playwright-core installation> node docs/media/capture.mjs` for all of them, or add a name such as `neutral-aod` for one (`--list` prints the names).
It needs Google Chrome and `ffmpeg`. Playwright is not a dependency of the project, and the header of the script lists the other settings.
