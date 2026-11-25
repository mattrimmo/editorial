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

* **Records page.** One table to scan every record (trend, streams, editorial, Shazams, radio, DJ supports, TikTok),
  then every record in full underneath. Click a row to jump to its record. Click a column heading to sort by it.
* **Period.** Switch between **Last 7 days** and **Release week** at the top. Release weeks run Friday to Thursday from
  release day. Everything is compared with the 7 days before, using daily averages so a part-finished week is fair.
* **Pitch notes.** Every true, positive point for the record, across every source: streams, editorial on every DSP,
  Beatport, 1001Tracklists and DSP charts, radio stations, DJ support, TikTok, Instagram, YouTube, SoundCloud and Shazam.
  Anything new in the chosen period is marked NEW and stays **bold** when pasted into an email. Untick what you don't want,
  then **Copy notes**. Tick several records in the table and use **Copy notes for all** to get them in one go, in the format
  `Artist 'Title' - LABEL`, stream links, period header, bullets. Declines are never listed.
* **Data.** Songstats, refreshed daily at 06:15 UTC (and from Refresh data). Spotify, Apple Music, Deezer and Amazon
  editorial come from playlist data. Radio stations, 1001Tracklists DJ supports and charts, Beatport charts and DJ charts,
  SoundCloud and the social numbers come from the same refresh (about 3 extra Songstats calls per record).
* **Editorial or not.** Spotify editorial is Spotify-owned (This Is and Artist Radio left out). Apple uses Songstats' editorial
  flag, Deezer the editor accounts, Amazon its own playlists. Anything unclear appears under **Sort playlists** once, and your
  choice is remembered for every record.
* **Edit.** Each record's Edit link has the hook line (shown at the top of its notes), extra links, label, name and release date
  fixes, hand-logged placements and the week-by-week editorial table.

## Limits worth knowing

* Songstats totals don't always move every day. When a total sits still and then jumps, the jump is spread over those days.
* A record in its first week has nothing to compare with, so it shows "first week" instead of a %.
* Apple, Amazon and Beatport have no stream counts. YouTube Music editorial isn't in Songstats, so log it by hand under Edit.
* The repo is public, so the data files are public too. Do not put anything confidential in hook lines.
