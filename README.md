# Editorial Pitch Pack

Internal tool for Listen Up. Add a record's ISRC and it pulls editorial playlist support across
Spotify, Apple Music and Deezer from Spot On Track, lays it out by release week (Friday to Thursday),
lets you log Amazon / YouTube Music / Beatport / SoundCloud placements by hand, and builds a short,
headline-led pitch block per DSP editor.

DSP order used everywhere: Spotify, Apple Music, Deezer, Amazon Music, YouTube Music, Beatport, SoundCloud.

## Set up (about 10 minutes)

1. **New repo.** On GitHub create a public repo called `editorialpitching` (public is needed for free GitHub Pages).
2. **Upload the files** keeping this structure exactly:
   ```
   index.html
   core.js
   README.md
   data/         (tracked.json, history.json, registry.json, manual.json, pitches.json)
   scripts/      (sync.py)
   .github/workflows/sync.yml
   ```
   The browser uploader tends to drop hidden folders. If `.github/workflows/sync.yml` is missing after the upload,
   use **Add file > Create new file**, type `.github/workflows/sync.yml` as the name (typing the slashes makes the folders),
   and paste in the contents of `sync.yml.copy`. Then delete `sync.yml.copy`.
3. **Pages.** Settings > Pages > deploy from branch `main`, folder `/ (root)`.
4. **Secret.** Settings > Secrets and variables > Actions > New repository secret, name `SOT_API_KEY`, value is your Spot On Track API key.
   The key only ever lives here. It is never in the page.
5. **Actions permission.** Settings > Actions > General > Workflow permissions > Read and write.
6. **Token for the page.** Create a fine-grained personal access token limited to this one repo with
   Contents: read and write, and Actions: read and write. Open the page, Settings, paste it once. It is stored in your browser only.
7. **Add your first record** on the Add record tab. It triggers a sync for that ISRC straight away.

## How it works

* **Weeks.** Week 1 starts on the release date (a Friday) and runs to Thursday. Week 2 starts the next Friday.
  Every placement has an added date (and removed date), so any past week is rebuilt on the spot. Nothing has to wait
  for snapshots to build up, and a record added late still gets its full history.
* **Refresh.** Runs daily at 06:15 UTC and on demand from Check live now. Spot On Track bills per unique ISRC per
  month, so refreshing more often does not cost more entities.
* **Spotify editorial.** A playlist is editorial if its id starts `37i9dQZF1` (Spotify's own), if Spot On Track names
  Spotify as the owner, or if you tagged it. Everything else on Spotify is treated as independent and not shown.
* **Apple Music and Deezer editorial.** The Spot On Track docs do not list an owner field for these. If your live
  responses include one that names the DSP itself, they classify automatically. Otherwise they appear under
  **Needs tagging** once, you pick Editorial / Independent / Ignore, and that is remembered for every record.
  The Actions log prints the playlist object keys on the first record so you can see which case you are in.
* **Hand-logged DSPs.** Amazon, YouTube Music, Beatport and SoundCloud are entered by hand per record. They appear in the
  weekly table, the pitch block and the follow-up list like the automatic ones.
* **Pitch block.** Three bullets at most: editorial support (the recipient's DSP first), one headline stat, and your hook line.
  The headline is the strongest genuinely positive number for the chosen week (new editorial adds, then a chart climb, then
  week-on-week streams or Shazams). If nothing is positive it claims nothing. The full numbers are always on the card.
* **Follow-ups.** Click Mark pitched on a record to log the date. The Follow-ups tab then shows what editorial support was added
  since you last pitched each DSP.

## Limits worth knowing

* Streams and Shazams only exist for Spotify and Shazam. Apple and Deezer show placements, regions and charts.
* Apple placements are per country, so they are shown with their regions.
* Spotify stream dates are shifted back 2 days to match Spotify for Artists.
* Playlists under 100 followers (Spotify and Deezer, non-editorial) are skipped. Change with the `MIN_FOLLOWERS` env var in the workflow.
* The repo is public, so the data files are public too. Do not put anything confidential in hook lines.
