# Milestone Timeline

A simple project-milestone tracker. Add milestones (date, media, name, responsible team, notes) and review the project history on an expandable timeline.

Two ways to run it — same app, same screens:

| | Where data is saved | Needs |
| --- | --- | --- |
| **GitHub Pages** (recommended for a demo) | This browser (IndexedDB) | Nothing — just open the link |
| **Local Node server** (`npm start`) | `data/` folder on disk | Node.js 18+ (no `npm install`) |

The app picks automatically: if a Node server is answering, it uses that; otherwise it saves in the browser.

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

## Tests

```bash
npm test
```

API smoke test (validation, processes, editing, uploads, file-type checking, path traversal, persistence across restart, delete). Uses a temporary data folder, so it never touches your real data.

## Notes

- Uploads: PNG, JPG, GIF, WebP and PDF, max 50 MB each. The type is verified from the file contents, not just the extension.
- The front end is in `docs/` (served by both the Node server and GitHub Pages); `docs/store.js` holds the two storage backends.
- The Node server binds to `127.0.0.1` by default and has no login — intended for local use.
