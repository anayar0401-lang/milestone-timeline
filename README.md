# Milestone Timeline

A simple project-milestone tracker. Add milestones (date, media, name, responsible team, notes) and review the project history on an expandable timeline.

Zero dependencies — only Node.js 18+ is needed. No `npm install`, no internet required.

## Run

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
- **Timeline** — every milestone date is a node on the timeline. Click a date to expand the three fields and any media (click an image/PDF to view it full-size). Sort oldest/newest first, expand/collapse all, or delete a milestone. Click the project name in the header to rename it.

## Your data is kept

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

API smoke test (validation, uploads, file-type checking, path traversal, persistence across restart, delete). Uses a temporary data folder, so it never touches your real data.

## Notes

- Uploads: PNG, JPG, GIF, WebP and PDF, max 50 MB each. The type is verified from the file contents, not just the extension.
- Binds to `127.0.0.1` by default and has no login — intended for local use.
