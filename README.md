# PoisonInk

PoisonInk is an independent portfolio prototype for artists who want to add a subtle visual obfuscation layer and a verifiable fingerprint before publishing an image.

The project is intentionally transparent: processing happens inside the browser, the exported image is re-encoded without the original metadata, and no artwork is sent to a server. It does not promise universal protection against AI training or copying.

## Run locally

Serve the folder with any static server:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Structure

- `index.html` — product landing page
- `studio/` — working image-protection studio
- `assets/` — shared styles, scripts, and visual assets

