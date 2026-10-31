# Milestone Timeline

A simple project-milestone tracker. Add milestones (date, media, name, responsible team, notes) and review the project history on an expandable timeline.

Two ways to run it — same app, same screens:

| | Where data is saved | Needs |
| --- | --- | --- |
| **GitHub Pages** (recommended for a demo) | This browser (IndexedDB) | Nothing — just open the link |
| **Local Node server** (`npm start`) | `data/` folder on disk | Node.js 18+ (no `npm install`) |

The app picks automatically: if a Node server is answering, it uses that; otherwise it saves in the browser.

## Sharing with others (screenshots & PDF)

Data stays in your browser, so the way to share is a screenshot or PDF.

- Click **Share view** on the timeline. Controls, filters and the footer disappear, and a title header appears (project name, what's shown, "as of" date, colour legend). The shortcut hint hides itself on your first key press or click, so it never ends up in your screenshot.
  - Click a card to expand/collapse it, or press **E** to expand/collapse all.
  - Pick a process chip *before* entering Share view to share just that process; choose **Group by process** for one timeline per process.
  - **T** switches light/dark (the ◐ button in the top bar does the same; your choice is remembered). Light usually looks best in email.
  - **P** opens the print dialog, choose *Save as PDF*. Printing is always white, clean and page-break-friendly, whatever the screen theme. Good for timelines too long for one screenshot.
  - **Esc** returns to the normal view.

## Public read-only link (username + password)

For people who only need to *look*. Your data stays in your browser; you publish an **encrypted snapshot** that the public viewer page unlocks with a username + password.

1. In the editor, footer → **Publish a read-only link…** → choose a username and password → **Create file**. This downloads `timeline.enc` (milestones, notes, images and PDFs, encrypted; large images are shrunk so it stays small).
2. On GitHub, open the repo's `docs` folder → **Add file → Upload files** → drop in `timeline.enc` (replace the old one) → commit. (GitHub's web uploader accepts files up to about 25 MB.)
3. Share `https://<your-username>.github.io/<repo-name>/?view` plus the username and password.

Viewers see the timeline exactly as you do (expand, filter by process, group by process, Share view, light/dark) but cannot change anything. After changing the timeline, create and upload a new `timeline.enc`; the link stays the same.

**How safe is it?** GitHub Pages is static hosting, so it cannot check a login. Instead the file is encrypted with AES-256-GCM using a key derived from username + password (PBKDF2-SHA256, 600,000 rounds); without them it is unreadable, and the password is never stored anywhere. But the file is public, so anyone can download it and guess passwords offline with no limit. **The password is the whole protection:** a short one (like 4 letters) can be cracked in hours on one computer or minutes with a rented GPU; 12+ characters (e.g. four random words) cannot. The publish dialog warns about short passwords. For content that must never leak, use a host with real access control instead.

## Host on GitHub Pages

1. Push this repo to GitHub (public repo for the free plan).
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder **`/docs`**, Save.
3. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

The repo contains no project data, so a public repo is fine. Your milestones live only in the browser you use.

**Browser-storage tips**
- Use the same browser and device each time; don't use a private/incognito window.
- Don't "clear site data" for the site. The app asks the browser to keep its data, but it can't force it.
- Use **Download backup** (footer) before the demo and whenever you've added a lot. **Restore backup** adds back anything missing and never deletes or overwrites existing entries.
- **Clear all data** (footer) wipes this browser's milestones and files so you can start fresh. It asks you to type `CLEAR` first.

## Run locally with Node

```bash
npm start
```

Open http://localhost:3000. (Use `PORT=8080 npm start` to change the port, `HOST=0.0.0.0` to allow other devices on your network.)

## How it works

- **Add milestone** — pick a date (calendar picker), optionally attach images/PDFs (click or drag & drop), then fill in:
  - **Milestone name** (required)
  - **Responsible team** (required)
  - **Notes** (optional)
- After saving, the app asks **"Do you have more milestones to add?"** — add another or go to the timeline.
- **Processes & colours** — define processes (e.g. Design, Procurement, Construction), each with a name and a colour, via the **Processes & colours** button. Assign a milestone to a process on the form (optional). Its date badge, dot and card edge then use that colour.
- **Edit** — every milestone has an **Edit** button (change anything, remove or add files). The **Process** dropdown inside an expanded milestone assigns a process instantly, handy for tagging older entries.
- **Timeline** — every milestone date is a node on the timeline. Click a date to expand the three fields and any media (click an image/PDF to view it full-size). Sort oldest/newest first, expand/collapse all, filter by process using the colour chips, switch to **Group by process** to see one timeline per process, or delete a milestone. Milestones with no process show in grey once any process exists. Click the project name in the header to rename it.

## Local server data

Nothing is wiped between uses or restarts. Everything lives in `data/`:

| Path | Contents |
| --- | --- |
| `data/milestones.json` | all milestones + project name |
| `data/uploads/` | uploaded images and PDFs |

`data/` contents are git-ignored so demo data never gets pushed. Back it up by copying that folder. Use `DATA_DIR=/some/path npm start` to keep data elsewhere. To start fresh, stop the server and delete `data/milestones.json` and `data/uploads/*`.

## Developing

After editing anything in `docs/*.js` or `docs/styles.css`, run `npm run stamp`. It writes a content hash into the `<script>`/`<link>` URLs in `docs/index.html` so browsers can never mix a new page with cached old scripts after a deploy (GitHub Pages lets browsers cache files for ~10 minutes). `npm test` fails if the stamps are out of date.

## Tests

```bash
npm test
```

Checks the cache-busting stamps, the encryption module (round trip, wrong credentials, tampering), then an API smoke test (validation, processes, editing, uploads, file-type checking, path traversal, persistence across restart, delete). Uses a temporary data folder, so it never touches your real data.

## Notes

- Uploads: PNG, JPG, GIF, WebP and PDF, max 50 MB each. The type is verified from the file contents, not just the extension.
- The front end is in `docs/` (served by both the Node server and GitHub Pages); `docs/store.js` holds the two storage backends.
- The Node server binds to `127.0.0.1` by default and has no login — intended for local use.
