# zimaos-recipe-box

Recipe Box packaged for **ZimaOS / CasaOS**. Static PWA plus a small sync API on
one port, with data stored on your NAS.

- Store entry: `Apps/RecipeBox/docker-compose.yml`
- Runtime: `app/server.js` + the PWA bundle in `app/`
- Image: `ghcr.io/tboltsp951/zimaos-recipe-box` (built by `.github/workflows/publish.yml`)

## Build the image

```bash
docker build -t zimaos-recipe-box .
docker run -d -p 8190:8080 -v /DATA/AppData/recipebox:/data --name recipe-box zimaos-recipe-box
```

Open `http://<host>:8190`. Add an OpenRouter key in **Settings** for AI import
(websites, photos, PDFs, pasted text). Without a key, manual recipes, meal
planning, shopping lists and local backups all still work.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `/data` | recipes, sync payload, version history |
| `RECIPEBOX_TOKEN` | *(empty)* | require `Authorization: Bearer …` |

## Storage

Everything is written under `/DATA/AppData/$AppID/` when installed from the
store, so it survives container rebuilds. The app also keeps photos in the
browser's IndexedDB and rotating local backups (last 6) — those live in the
browser, not on the NAS, so use **Export** for a portable backup.

## Updating

1. Change the app, bump `x-casaos.version` in `Apps/RecipeBox/docker-compose.yml`.
2. Push to `main`; the publish workflow builds `latest` and a SHA tag.
3. Bump `x-casaos.update_at` / `release_notes`.
