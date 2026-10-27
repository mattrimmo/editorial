/* Editorial Pitch Pack - core logic (no DOM, no network). Used by index.html and by the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Editor priority order, used everywhere (cards, pitch block, follow-up list).
  var DSPS = [
    { key: 'spotify', label: 'Spotify', auto: true },
    { key: 'apple', label: 'Apple Music', auto: true },
    { key: 'deezer', label: 'Deezer', auto: true },
    { key: 'amazon', label: 'Amazon Music', auto: false },
    { key: 'youtube', label: 'YouTube Music', auto: false },
    { key: 'beatport', label: 'Beatport', auto: false },
    { key: 'soundcloud', label: 'SoundCloud', auto: false }
  ];
  var DSP_LABEL = {};
  DSPS.forEach(function (d) { DSP_LABEL[d.key] = d.label; });

  // ---------------------------------------------------------------- dates
  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function fmtLong(ms) { var d = new Date(ms); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function fmtShort(ms) { var d = new Date(ms); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '-';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function todayUTC(now) {
    var d = now || new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // ---------------------------------------------------------------- release weeks
  // Week 1 starts on release day (a Friday) and runs Friday to Thursday. Week 2 starts the next Friday.
  function weekStart(release, n) { return release + (n - 1) * 7 * DAY; }
  function weekEnd(release, n) { return weekStart(release, n) + 6 * DAY; }
  function weekOf(release, d) { return Math.floor((d - release) / (7 * DAY)) + 1; }
  function completedWeeks(release, today) { return Math.max(0, Math.floor((today - release) / (7 * DAY))); }
  // The week a pitch should talk about: the last full week, or launch week so far if week 1 is still running.
  function defaultReportWeek(release, today) { return Math.max(1, completedWeeks(release, today)); }

  // ---------------------------------------------------------------- placements
  function spanActiveAt(sp, d) {
    var a = parseDate(sp.added_at);
    var r = parseDate(sp.removed_at);
    if (a != null && a > d) return false;
    return r == null || r > d;
  }
  function activeAt(p, d) { return (p.spans || []).some(function (sp) { return spanActiveAt(sp, d); }); }
  function activeNow(p) { return (p.spans || []).some(function (sp) { return !sp.removed_at; }); }
  function addedIn(p, s, e) {
    return (p.spans || []).some(function (sp) { var a = parseDate(sp.added_at); return a != null && a >= s && a <= e; });
  }
  function removedIn(p, s, e) {
    return (p.spans || []).some(function (sp) { var r = parseDate(sp.removed_at); return r != null && r >= s && r <= e; });
  }
  function activeRegions(p) {
    var seen = {}, out = [];
    (p.spans || []).forEach(function (sp) {
      if (!sp.removed_at && sp.cc && !seen[sp.cc]) { seen[sp.cc] = 1; out.push(sp.cc); }
    });
    return out;
  }

  // History placements + registry tags + manual entries -> one list. Kind: editorial | independent | null (untagged)
  function effectivePlacements(histRec, manualEntries, registry) {
    var out = [];
    ((histRec && histRec.placements) || []).forEach(function (p) {
      var reg = registry && registry[p.dsp + ':' + p.id];
      var kind = reg && reg.kind ? reg.kind : p.kind;
      if (kind === 'ignore') return;
      var c = {}; for (var k in p) c[k] = p[k];
      c.kind = kind || null;
      out.push(c);
    });
    (manualEntries || []).forEach(function (m, i) {
      out.push({
        dsp: m.dsp, id: 'manual-' + i, name: m.playlist, artwork: null, followers: null, kind: 'editorial',
        manual: true, manualIndex: i,
        spans: [{ cc: m.region || '', added_at: m.added_at || null, removed_at: m.removed_at || null, position: null }]
      });
    });
    return out;
  }
  function editorialOnly(pls) { return pls.filter(function (p) { return p.kind === 'editorial'; }); }
  function needsTagging(pls) { return pls.filter(function (p) { return !p.kind; }); }

  // ---------------------------------------------------------------- weekly table
  function weeklyTable(placements, release, today, maxWeeks) {
    var ed = editorialOnly(placements);
    var last = Math.max(1, weekOf(release, today));
    var first = Math.max(1, last - (maxWeeks || 12) + 1);
    var rows = [];
    for (var n = first; n <= last; n++) {
      var s = weekStart(release, n), e = weekEnd(release, n);
      var endEff = Math.min(e, today);
      var row = { n: n, start: s, end: e, partial: e > today, perDsp: {}, totalActive: 0, totalAdded: 0, totalRemoved: 0 };
      DSPS.forEach(function (d) {
        var mine = ed.filter(function (p) { return p.dsp === d.key; });
        var cell = {
          active: mine.filter(function (p) { return activeAt(p, endEff); }).length,
          added: mine.filter(function (p) { return addedIn(p, s, endEff); }).length,
          removed: mine.filter(function (p) { return removedIn(p, s, endEff); }).length
        };
        row.perDsp[d.key] = cell;
        row.totalActive += cell.active; row.totalAdded += cell.added; row.totalRemoved += cell.removed;
      });
      rows.push(row);
    }
    return rows;
  }

  // ---------------------------------------------------------------- series
  function seriesSum(series, s, e) {
    var sum = 0, days = 0;
    (series || []).forEach(function (r) {
      var d = parseDate(r.date);
      if (d != null && d >= s && d <= e && r.daily != null) { sum += r.daily; days++; }
    });
    return days ? { sum: sum, days: days } : null;
  }
  function pctChange(cur, prev) {
    if (cur == null || prev == null || prev <= 0) return null;
    return Math.round((cur / prev - 1) * 100);
  }

  // ---------------------------------------------------------------- charts
  function chartLabel(dsp, c) {
    var cc = c.country_code === 'GLOBAL' ? 'Global' : (c.country_code || '');
    if (dsp === 'spotify') return 'Spotify ' + (c.type === 'viral' ? 'Viral ' : '') + cc + (c.frequency === 'weekly' ? ' weekly' : '');
    if (dsp === 'apple') return 'Apple Music ' + (c.genre && c.genre !== 'All genres' ? c.genre + ' ' : '') + cc;
    if (dsp === 'deezer') return 'Deezer ' + cc;
    return 'Shazam ' + (c.genre ? c.genre + ' ' : '') + (c.city ? c.city : cc);
  }
  function chartMoves(charts) {
    var moves = [];
    Object.keys(charts || {}).forEach(function (dsp) {
      (charts[dsp] || []).forEach(function (c) {
        if (c.position == null) return;
        var prev = c.previous_position;
        moves.push({
          dsp: dsp, label: chartLabel(dsp, c), position: c.position, prev: prev == null ? null : prev,
          delta: prev == null ? null : prev - c.position, isNew: prev == null
        });
      });
    });
    return moves;
  }
  function bestChartMove(charts) {
    var moves = chartMoves(charts);
    var climbs = moves.filter(function (m) { return !m.isNew && m.delta >= 5; })
      .sort(function (a, b) { return b.delta - a.delta || a.position - b.position; });
    if (climbs.length) {
      var c = climbs[0];
      return { text: c.label + ' chart: #' + c.position + ' (up from #' + c.prev + ')', move: c };
    }
    var fresh = moves.filter(function (m) { return m.isNew && m.position <= 50; })
      .sort(function (a, b) { return a.position - b.position; });
    if (fresh.length) {
      var f = fresh[0];
      return { text: 'New entry on the ' + f.label + ' chart at #' + f.position, move: f };
    }
    return null;
  }

  // ---------------------------------------------------------------- headline stat (one per pitch)
  function newEditorialIn(placements, s, e) {
    return editorialOnly(placements).filter(function (p) { return addedIn(p, s, e); });
  }
  function nameList(pls, max) {
    var names = pls.map(function (p) { return p.name || '(unnamed)'; });
    var shown = names.slice(0, max || 2);
    var more = names.length - shown.length;
    return shown.join(', ') + (more > 0 ? ' +' + more + ' more' : '');
  }
  // ---------------------------------------------------------------- campaign headlines
  // The email is for a curator whose own lists we do not know, so it carries campaign-wide numbers only.
  // Framing is the strongest TRUE one: week-on-week growth when it is up 10% or more, otherwise the running total.
  // Nothing is claimed that the data does not show, and declines are never presented as growth.
  function streamsBullet(ctx, n) {
    var rel = ctx.release;
    if (rel == null) return null;
    var t = ctx.today != null ? ctx.today : Date.now();
    var s = weekStart(rel, n), e = Math.min(weekEnd(rel, n), t);
    var total = seriesSum(ctx.streams, rel, e);
    if (!total || total.sum <= 0) return null;
    var cur = seriesSum(ctx.streams, s, e);
    var prev = n >= 2 ? seriesSum(ctx.streams, weekStart(rel, n - 1), weekEnd(rel, n - 1)) : null;
    var pct = cur && prev && weekEnd(rel, n) <= t ? pctChange(cur.sum, prev.sum) : null;
    if (pct != null && pct >= 10 && n >= 2) {
      return { kind: 'streams_growth', framing: 'Streams shown as week on week growth (+' + pct + '%)',
        text: 'Spotify streams: ' + fmtNum(total.sum) + ' since release, up ' + pct + '% week on week (' + fmtNum(cur.sum) + ' in week ' + n + ')' };
    }
    return { kind: 'streams_total', framing: 'Streams shown as the running total (week on week was not up 10% or more)',
      text: 'Spotify streams: ' + fmtNum(total.sum) + ' since release' };
  }
  function momentumBullet(ctx, n) {
    var parts = [], framing = [];
    var chart = bestChartMove(ctx.charts);
    if (chart) { parts.push(chart.text); framing.push('Chart move: ' + chart.text); }
    var rel = ctx.release, t = ctx.today != null ? ctx.today : Date.now();
    if (rel != null && n >= 2 && weekEnd(rel, n) <= t) {
      var zc = seriesSum(ctx.shazams, weekStart(rel, n), weekEnd(rel, n)), zp = seriesSum(ctx.shazams, weekStart(rel, n - 1), weekEnd(rel, n - 1));
      var zpct = zc && zp ? pctChange(zc.sum, zp.sum) : null;
      if (zpct != null && zpct >= 20 && zc.sum >= 100) { parts.push('Shazams up ' + zpct + '% week on week (' + fmtNum(zc.sum) + ' in week ' + n + ')'); framing.push('Shazams up ' + zpct + '%'); }
    }
    if (!parts.length) return null;
    return { kind: 'momentum', framing: framing.join('. '), text: 'Movement: ' + parts.join('. ') };
  }

  // ---------------------------------------------------------------- pitch block
  // Campaign-wide support, every platform together. Biggest lists first (by followers where the data has them).
  function fmtCompact(n) {
    if (n == null || isNaN(n)) return '';
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
  }
  function bigFirst(pls) {
    var order = DSPS.map(function (d) { return d.key; });
    return pls.slice().sort(function (a, b) {
      return (b.followers || 0) - (a.followers || 0) || order.indexOf(a.dsp) - order.indexOf(b.dsp) || String(a.name).localeCompare(String(b.name));
    });
  }
  // Top lists with every platform represented first (hand-logged Amazon, YouTube etc have no follower counts and would never rank otherwise).
  function pickBig(pls, max) {
    var sorted = bigFirst(pls), seen = {}, chosen = [];
    sorted.forEach(function (p) { if (!seen[p.dsp]) { seen[p.dsp] = 1; chosen.push(p); } });
    chosen = chosen.slice(0, max);
    sorted.forEach(function (p) { if (chosen.length < max && chosen.indexOf(p) < 0) chosen.push(p); });
    return bigFirst(chosen);
  }
  function nameWithDsp(p) {
    return (p.name || '(unnamed)') + ' (' + DSP_LABEL[p.dsp] + ')';
  }
  function supportBullets(placements, n, release, maxNames) {
    var ed = editorialOnly(placements).filter(activeNow);
    var out = { count: ed.length, biggest: null, fresh: null };
    if (!ed.length) return out;
    out.biggest = 'Editorial support: ' + pickBig(ed, maxNames || 4).map(nameWithDsp).join(', ');
    if (release != null && n) {
      var fresh = newEditorialIn(placements, weekStart(release, n), weekEnd(release, n));
      if (fresh.length) out.fresh = 'Added in week ' + n + ': ' + pickBig(fresh, 3).map(nameWithDsp).join(', ') + (fresh.length > 3 ? ' +' + (fresh.length - 3) + ' more' : '');
    }
    return out;
  }

  function linkFor(ctx, dsp) {
    var l = ctx.links || {};
    var v = l[dsp];
    if (Array.isArray(v)) v = v[0];
    return v || null;
  }

  function buildPitch(ctx, dspKey, opts) {
    opts = opts || {};
    var n = opts.weekN || 1;
    var label = DSP_LABEL[dspKey] || dspKey;
    var title = (ctx.artist || 'Artist') + ' - ' + (ctx.track || 'Track');
    var relTxt = ctx.release != null ? fmtLong(ctx.release) : 'release date TBC';
    var streams = streamsBullet(ctx, n);
    var support = supportBullets(ctx.placements, n, ctx.release);
    var momentum = momentumBullet(ctx, n);
    var data = [];
    if (streams) data.push(streams);
    if (momentum) data.push(momentum);
    if (support.biggest) data.push({ kind: 'biggest', text: support.biggest, framing: 'Strongest lists named first (ranked by followers, every platform represented)' });
    if (support.fresh) data.push({ kind: 'fresh', text: support.fresh, framing: 'This week\'s biggest adds named' });
    var bullets = data.map(function (d) { return d.text; });
    if (ctx.hook) bullets.push(ctx.hook);

    var link = linkFor(ctx, dspKey) || '[link]';
    var intro = opts.followUp
      ? 'Following up on ' + (ctx.track || 'the record') + ' (' + relTxt + '). Quick update since I last sent it:'
      : 'Sending over ' + title + ' (' + relTxt + '). Quick headlines:';
    var body = 'Hi ' + (opts.name || '[Name]') + ',\n\n' + intro + '\n\n' +
      (bullets.length ? bullets.map(function (b) { return '- ' + b; }).join('\n') + '\n\n' : '') +
      'Would love to see it considered for ' + (opts.playlist || 'your playlists') + '. Link: ' + link + '\n\n[Sign-off]';

    var tag = support.count ? 'on ' + support.count + ' editorial playlist' + (support.count > 1 ? 's' : '') : 'out ' + fmtShort(ctx.release != null ? ctx.release : Date.now());
    var subject = (ctx.artist || 'Artist') + ' "' + (ctx.track || 'Track') + '" | ' + tag;
    return { subject: subject, body: body, label: label, bullets: bullets, framing: data.map(function (d) { return d.framing; }), missingLink: link === '[link]' };
  }

  // ---------------------------------------------------------------- daily monitoring: trajectory and what changed
  // Trajectory compares the latest 7 days of data with the 7 days before, ending on the newest day Spot On Track has.
  // Accelerating is +10% or more, declining is -10% or worse, anything between is plateauing.
  function latestDate(series) {
    var m = null;
    (series || []).forEach(function (r) { var d = parseDate(r.date); if (d != null && r.daily != null && (m == null || d > m)) m = d; });
    return m;
  }
  function trendOf(series, minVolume) {
    var L = latestDate(series);
    if (L == null) return { state: 'nodata', pct: null, last7: null, prev7: null, latest: null };
    var cur = seriesSum(series, L - 6 * DAY, L), prev = seriesSum(series, L - 13 * DAY, L - 7 * DAY);
    var out = { state: 'early', pct: null, last7: cur ? cur.sum : null, prev7: prev ? prev.sum : null, latest: L, days: cur ? cur.days : 0 };
    if (!cur || !prev || cur.days < 5 || prev.days < 5) return out;
    if (minVolume && (cur.sum < minVolume || prev.sum < minVolume)) return out;   // too small to read a percentage into
    out.pct = pctChange(cur.sum / cur.days, prev.sum / prev.days);
    if (out.pct == null) return out;
    out.state = out.pct >= 10 ? 'accelerating' : (out.pct <= -10 ? 'declining' : 'plateauing');
    return out;
  }
  function placementEvents(ctx) {
    var ev = [];
    editorialOnly(ctx.placements).forEach(function (p) {
      var adds = (p.spans || []).map(function (sp) { return parseDate(sp.added_at); }).filter(function (d) { return d != null; });
      var rems = (p.spans || []).map(function (sp) { return parseDate(sp.removed_at); }).filter(function (d) { return d != null; });
      if (adds.length) ev.push({ type: 'added', date: Math.min.apply(null, adds), name: p.name || '(unnamed)', dsp: p.dsp });
      if (!activeNow(p) && rems.length) ev.push({ type: 'removed', date: Math.max.apply(null, rems), name: p.name || '(unnamed)', dsp: p.dsp });
    });
    return ev.sort(function (a, b) { return b.date - a.date; });
  }
  function monitor(ctx) {
    var t = ctx.today != null ? ctx.today : Date.now();
    var tr = trendOf(ctx.streams, 300), sh = trendOf(ctx.shazams, 100);
    var ev = placementEvents(ctx), since = t - 6 * DAY;
    var recent = ev.filter(function (e) { return e.date >= since && e.date <= t; });
    var adds7 = recent.filter(function (e) { return e.type === 'added'; }), rem7 = recent.filter(function (e) { return e.type === 'removed'; });
    var live = editorialOnly(ctx.placements).filter(activeNow).length;
    var moves = chartMoves(ctx.charts).sort(function (a, b) { return a.position - b.position; });
    var days = (ctx.streams || []).map(function (r) { return { date: parseDate(r.date), value: r.daily }; }).filter(function (r) { return r.date != null && r.value != null; }).sort(function (a, b) { return a.date - b.date; });
    var sentences = [];
    if (tr.state === 'accelerating') sentences.push('Spotify streams are up ' + tr.pct + '% on the previous 7 days.');
    else if (tr.state === 'declining') sentences.push('Spotify streams are down ' + (-tr.pct) + '% on the previous 7 days.');
    else if (tr.state === 'plateauing') sentences.push('Spotify streams are steady against the previous 7 days (' + (tr.pct >= 0 ? '+' : '') + tr.pct + '%).');
    else if (tr.state === 'early') sentences.push('Too early to call a trend. Not enough days of data yet.');
    if (tr.state === 'declining' && ctx.release != null && tr.latest != null && tr.latest - ctx.release <= 35 * DAY) sentences.push('Streams usually fall after launch, so look at whether editorial adds lift the line again.');
    if (adds7.length) sentences.push(adds7.length + ' editorial add' + (adds7.length > 1 ? 's' : '') + ' in the last 7 days: ' + adds7.slice(0, 3).map(function (e) { return e.name + ' (' + DSP_LABEL[e.dsp] + ')'; }).join(', ') + (adds7.length > 3 ? ' +' + (adds7.length - 3) + ' more' : '') + '.');
    if (rem7.length) sentences.push(rem7.length + ' removed in the last 7 days: ' + rem7.slice(0, 3).map(function (e) { return e.name + ' (' + DSP_LABEL[e.dsp] + ')'; }).join(', ') + '.');
    return {
      trend: tr, shazam: sh, live: live, adds7: adds7, rem7: rem7, events: ev,
      chart: moves.length ? chartText(moves[0]) : null,
      spark: days.slice(-28).map(function (d) { return d.value; }),
      days: days, latest: tr.latest, sentences: sentences,
      worth: adds7.length > 0 || (tr.state === 'accelerating' && tr.pct >= 15)
    };
  }
  // Everything that changed across all records in the last N days, newest first.
  function changeFeed(ctxs, today, nDays) {
    var out = [];
    ctxs.forEach(function (ctx) {
      placementEvents(ctx).forEach(function (e) {
        if (e.date >= today - (nDays - 1) * DAY && e.date <= today) out.push(Object.assign({ isrc: ctx.isrc, artist: ctx.artist, track: ctx.track }, e));
      });
    });
    return out.sort(function (a, b) { return b.date - a.date || String(a.name).localeCompare(String(b.name)); });
  }

  // ---------------------------------------------------------------- numbers to lead with
  // Streams normally fall after launch week, so "this week vs last week" is usually down and makes a poor headline.
  // This lists the strongest TRUE numbers instead, best first: lift since an editorial add, a milestone passed,
  // genuine growth, recent adds, holding up, then the running totals (which only ever go up).
  var MILESTONES = [10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000];
  function leadStats(ctx) {
    var rel = ctx.release, out = [];
    var L = latestDate(ctx.streams);
    if (rel == null || L == null) return out;
    var t = ctx.today != null ? ctx.today : Date.now();
    var total = seriesSum(ctx.streams, rel, L);
    var tr = trendOf(ctx.streams, 300);

    // 1. lift since an editorial add: daily average in the 7 days after against the 7 days before
    var best = null;
    placementEvents(ctx).filter(function (e) { return e.type === 'added' && e.date <= L - 2 * DAY && e.date >= rel; }).forEach(function (e) {
      var pre = seriesSum(ctx.streams, e.date - 7 * DAY, e.date - DAY), post = seriesSum(ctx.streams, e.date, Math.min(e.date + 6 * DAY, L));
      if (!pre || !post || pre.days < 5 || post.days < 3 || pre.sum < 300) return;
      var pct = pctChange(post.sum / post.days, pre.sum / pre.days);
      if (pct != null && pct >= 15 && (!best || pct > best.pct)) best = { pct: pct, e: e, pre: pre.sum / pre.days, post: post.sum / post.days };
    });
    if (best) out.push({ kind: 'lift', text: 'Spotify streams up ' + best.pct + '% since ' + best.e.name + ' (' + DSP_LABEL[best.e.dsp] + ') added it on ' + fmtShort(best.e.date) + ', daily average ' + fmtNum(best.pre) + ' to ' + fmtNum(best.post) });

    // 2. a milestone passed in the last 14 days
    var cum = 0, passed = null;
    (ctx.streams || []).map(function (r) { return { d: parseDate(r.date), v: r.daily }; })
      .filter(function (r) { return r.d != null && r.v != null && r.d >= rel && r.d <= L; })
      .sort(function (a, b) { return a.d - b.d; })
      .forEach(function (r) {
        var before = cum; cum += r.v;
        MILESTONES.forEach(function (m) { if (before < m && cum >= m && r.d >= L - 13 * DAY) passed = { m: m, d: r.d }; });
      });
    if (passed) out.push({ kind: 'milestone', text: 'Passed ' + fmtNum(passed.m) + ' Spotify streams on ' + fmtShort(passed.d) });

    // 3. real growth on the previous 7 days
    if (tr.state === 'accelerating' && tr.last7 >= 500) out.push({ kind: 'growth', text: 'Spotify streams up ' + tr.pct + '% on the previous 7 days' });

    // 4. recent editorial adds
    var adds14 = placementEvents(ctx).filter(function (e) { return e.type === 'added' && e.date >= t - 13 * DAY && e.date <= t; });
    if (adds14.length) out.push({ kind: 'adds', text: adds14.length + ' new editorial playlist add' + (adds14.length > 1 ? 's' : '') + ' in the last 14 days: ' + adds14.slice(0, 3).map(function (e) { return e.name + ' (' + DSP_LABEL[e.dsp] + ')'; }).join(', ') });

    // 5. holding up, which is a good story for a record several weeks old
    var ageWeeks = Math.floor((L - rel) / (7 * DAY));
    if ((tr.state === 'plateauing' || tr.state === 'accelerating') && ageWeeks >= 2 && tr.last7 >= 700) out.push({ kind: 'holding', text: 'Still averaging ' + fmtNum(tr.last7 / 7) + ' Spotify streams a day, ' + ageWeeks + ' weeks after release' });

    // 6. Shazams
    var sz = seriesSum(ctx.shazams, rel, L);
    if (sz && sz.sum >= 500) out.push({ kind: 'shazam', text: fmtNum(sz.sum) + ' Shazams since release' });

    // 7. running total, always true
    if (total && total.sum > 0) out.push({ kind: 'total', text: fmtNum(total.sum) + ' Spotify streams since release' });
    return out;
  }

  // ---------------------------------------------------------------- every pickable bullet
  // Everything true and positive a curator would want to hear, grouped, so the user can pick and copy.
  // Never includes declines or follower numbers.
  function allBullets(ctx) {
    var rel = ctx.release, groups = [];
    var L = latestDate(ctx.streams);
    var t = ctx.today != null ? ctx.today : Date.now();
    function add(title, items) { if (items.length) groups.push({ title: title, items: items }); }
    var tr = trendOf(ctx.streams, 300);
    var ed = editorialOnly(ctx.placements);
    var live = ed.filter(activeNow);

    // the story
    if (ctx.hook) add('The story', [ctx.hook]);

    // streams
    var st = [];
    if (rel != null && L != null) {
      var total = seriesSum(ctx.streams, rel, L);
      if (total && total.sum > 0) st.push(fmtNum(total.sum) + ' Spotify streams since release');
      var last7 = seriesSum(ctx.streams, L - 6 * DAY, L);
      if (last7 && last7.days >= 5 && last7.sum >= 300) st.push(fmtNum(last7.sum) + ' Spotify streams in the last 7 days (' + fmtNum(last7.sum / last7.days) + ' a day)');
      if (tr.state === 'accelerating' && tr.last7 >= 500) st.push('Spotify streams up ' + tr.pct + '% on the previous 7 days');
      var best = null;
      (ctx.streams || []).forEach(function (r) { var d = parseDate(r.date); if (d != null && d >= rel && r.daily != null && (!best || r.daily > best.v)) best = { d: d, v: r.daily }; });
      if (best && best.v >= 500) st.push('Biggest day so far: ' + fmtNum(best.v) + ' Spotify streams on ' + fmtShort(best.d));
      var ls = leadStats(ctx);
      ls.forEach(function (x) { if (x.kind === 'milestone' || x.kind === 'holding') st.push(x.text); });
      // lift since each editorial add
      placementEvents(ctx).filter(function (e) { return e.type === 'added' && e.date <= L - 2 * DAY && e.date >= rel; }).forEach(function (e) {
        var pre = seriesSum(ctx.streams, e.date - 7 * DAY, e.date - DAY), post = seriesSum(ctx.streams, e.date, Math.min(e.date + 6 * DAY, L));
        if (!pre || !post || pre.days < 5 || post.days < 3 || pre.sum < 300) return;
        var pct = pctChange(post.sum / post.days, pre.sum / pre.days);
        if (pct != null && pct >= 15) st.push('Spotify streams up ' + pct + '% after ' + e.name + ' (' + DSP_LABEL[e.dsp] + ') added it on ' + fmtShort(e.date));
      });
    }
    add('Streams', st);

    // editorial support, overall then per platform
    var sup = [];
    if (live.length) {
      var dspsLive = DSPS.filter(function (d) { return live.some(function (p) { return p.dsp === d.key; }); });
      sup.push('On ' + live.length + ' editorial playlist' + (live.length > 1 ? 's' : '') + ' across ' + dspsLive.map(function (d) { return d.label; }).join(', '));
      DSPS.forEach(function (d) {
        var pls = bigFirst(live.filter(function (p) { return p.dsp === d.key; }));
        if (pls.length) sup.push(d.label + ': ' + nameList(pls, 6));
      });
    }
    add('Editorial support', sup);

    // new adds in the last 7 days
    var fresh = placementEvents(ctx).filter(function (e) { return e.type === 'added' && e.date >= t - 6 * DAY && e.date <= t; });
    add('New this week', fresh.map(function (e) { return 'Added to ' + e.name + ' (' + DSP_LABEL[e.dsp] + ') on ' + fmtShort(e.date); }));

    // charts
    var ch = chartMoves(ctx.charts).sort(function (a, b) { return a.position - b.position; });
    add('Charts', ch.map(function (m) { return (m.isNew || m.delta > 0) ? chartText(m) : m.label + ' #' + m.position; }));

    // shazam
    var sz = [];
    if (rel != null && L != null) {
      var zt = seriesSum(ctx.shazams, rel, L);
      if (zt && zt.sum >= 300) sz.push(fmtNum(zt.sum) + ' Shazams since release');
      var z7 = seriesSum(ctx.shazams, L - 6 * DAY, L), zp = seriesSum(ctx.shazams, L - 13 * DAY, L - 7 * DAY);
      if (z7 && z7.days >= 5 && z7.sum >= 100) sz.push(fmtNum(z7.sum) + ' Shazams in the last 7 days');
      var zpct = z7 && zp && z7.days >= 5 && zp.days >= 5 ? pctChange(z7.sum, zp.sum) : null;
      if (zpct != null && zpct >= 20 && z7.sum >= 100) sz.push('Shazams up ' + zpct + '% on the previous 7 days');
    }
    add('Shazam', sz);
    return groups;
  }

  // ---------------------------------------------------------------- campaign highlights (for Matt to read, not to paste)
  function chartText(m) {
    var move = m.isNew ? 'new entry' : (m.delta > 0 ? 'up ' + m.delta : (m.delta < 0 ? 'down ' + (-m.delta) : 'steady'));
    return m.label + ' #' + m.position + ' (' + move + ')';
  }
  // n is a release week number, or 'latest' for the newest 7 days of data against the 7 before (what the Records page trend uses).
  function highlights(ctx, n) {
    var rel = ctx.release, t = ctx.today != null ? ctx.today : Date.now();
    var rolling = n === 'latest';
    var out = { week: n, rolling: rolling, hasRelease: rel != null, streams: null, top: null, others: [], dsps: [], label: rolling ? 'the latest 7 days' : 'week ' + n };
    if (rel == null) return out;
    var Ld = latestDate(ctx.streams); if (Ld == null) Ld = t;
    var s, e, ps, pe, hasPrev, ws, we, complete;
    if (rolling) { s = Ld - 6 * DAY; e = Ld; ps = Ld - 13 * DAY; pe = Ld - 7 * DAY; hasPrev = true; ws = t - 6 * DAY; we = t; complete = true; }
    else { s = weekStart(rel, n); var eFull = weekEnd(rel, n); e = Math.min(eFull, t); ps = weekStart(rel, n - 1); pe = weekEnd(rel, n - 1); hasPrev = n >= 2; ws = s; we = e; complete = eFull <= t; }
    out.window = { from: s, to: e };

    // streams
    var total = seriesSum(ctx.streams, rel, e), cur = seriesSum(ctx.streams, s, e);
    var prev = hasPrev ? seriesSum(ctx.streams, ps, pe) : null;
    var avg = cur ? cur.sum / cur.days : null, avgPrev = prev ? prev.sum / prev.days : null;
    var pct = avg != null && avgPrev != null && cur.days >= 3 ? pctChange(avg, avgPrev) : null;
    var best = null;
    (ctx.streams || []).forEach(function (r) {
      var d = parseDate(r.date);
      if (d != null && d >= rel && d <= e && r.daily != null && (!best || r.daily > best.value)) best = { date: d, value: r.daily };
    });
    var zc = seriesSum(ctx.shazams, s, e), zp = hasPrev ? seriesSum(ctx.shazams, ps, pe) : null;
    var zpct = zc && zp && zc.days >= 3 ? pctChange(zc.sum / zc.days, zp.sum / zp.days) : null;
    var days = [];
    (ctx.streams || []).forEach(function (r) { var d = parseDate(r.date); if (d != null && d >= rel && d <= e && r.daily != null) days.push({ date: d, value: r.daily, inWeek: d >= s }); });
    out.streams = {
      total: total ? total.sum : null, week: cur ? cur.sum : null, weekDays: cur ? cur.days : 0, partial: !complete,
      pct: pct, prevWeek: prev ? prev.sum : null, best: best, bestInWeek: !!(best && best.date >= s),
      shazams: zc ? zc.sum : null, shazamPct: zpct, daily: days.slice(-28), latest: Ld
    };

    // platform cards
    var ed = editorialOnly(ctx.placements);
    var moves = chartMoves(ctx.charts);
    var cards = DSPS.map(function (d) { return { key: d.key, label: d.label }; }).concat([{ key: 'shazam', label: 'Shazam' }]);
    cards.forEach(function (d) {
      var live = bigFirst(ed.filter(function (p) { return p.dsp === d.key && activeNow(p); }));
      var added = bigFirst(newEditorialIn(ctx.placements, ws, we).filter(function (p) { return p.dsp === d.key; }));
      var mv = moves.filter(function (m) { return m.dsp === d.key; }).sort(function (a, b) { return a.position - b.position; });
      if (!live.length && !added.length && !mv.length) return;
      out.dsps.push({
        key: d.key, label: d.label, liveCount: live.length, liveNames: live.map(function (p) { return p.name || '(unnamed)'; }),
        addedCount: added.length, addedNames: added.map(function (p) { return p.name || '(unnamed)'; }),
        chart: mv.length ? chartText(mv[0]) : null, chartMore: Math.max(0, mv.length - 1)
      });
    });

    // the top thing that happened this week, ranked: editorial adds, chart move, stream growth, best day, Shazams
    var cand = [];
    bigFirst(newEditorialIn(ctx.placements, ws, we)).forEach(function (p) {
      var rg = activeRegions(p).slice(0, 3).join(', ');
      cand.push({ kind: 'editorial', text: 'Added to ' + (p.name || '(unnamed)') + ' on ' + DSP_LABEL[p.dsp] + (rg ? ' (' + rg + ')' : '') });
    });
    if (rolling || n >= ctx.defaultWeek) {
      var chart = bestChartMove(ctx.charts);
      if (chart) cand.push({ kind: 'chart', text: chart.text });
    }
    // percentages only when the base is big enough to mean something
    if (pct != null && pct >= 10 && cur.sum >= 500 && prev && prev.sum >= 300) cand.push({ kind: 'streams', text: 'Spotify streams up ' + pct + '% on ' + (rolling ? 'the previous 7 days' : 'last week') + ' (daily average ' + fmtNum(avg) + ')' });
    if (best && best.date >= s && (rolling || n >= 2) && best.value > 0) cand.push({ kind: 'bestday', text: 'Best day yet: ' + fmtNum(best.value) + ' Spotify streams on ' + fmtShort(best.date) });
    if (zpct != null && zpct >= 20 && zc.sum >= 100) cand.push({ kind: 'shazam', text: 'Shazams up ' + zpct + '% on ' + (rolling ? 'the previous 7 days' : 'last week') + ' (' + fmtNum(zc.sum) + ')' });
    out.top = cand[0] || null;
    out.others = cand.slice(1);
    return out;
  }

  // ---------------------------------------------------------------- several records in one email
  // Each record gets a compact block (three bullets at most, hook kept) so a 3 or 4 record email stays short.
  function shortTitle(ctx) { return (ctx.artist || 'Artist') + ' - ' + (ctx.track || 'Track'); }
  function buildMultiPitch(ctxs, dspKey, opts) {
    opts = opts || {};
    var label = DSP_LABEL[dspKey] || dspKey;
    var missing = [], blocks = [], total = 0;
    ctxs.forEach(function (ctx) {
      var n = ctx.defaultWeek || 1;
      var streams = streamsBullet(ctx, n), support = supportBullets(ctx.placements, n, ctx.release, 3), momentum = momentumBullet(ctx, n);
      var data = [];
      if (streams) data.push(streams.text);
      if (support.biggest) data.push(support.biggest);
      if (support.fresh) data.push(support.fresh);
      if (momentum) data.push(momentum.text);
      data = data.slice(0, 3 - (ctx.hook ? 1 : 0));
      if (ctx.hook) data.push(ctx.hook);
      total += support.count || 0;
      var link = linkFor(ctx, dspKey);
      if (!link) missing.push(shortTitle(ctx));
      blocks.push(shortTitle(ctx) + (ctx.release != null ? ' (' + fmtLong(ctx.release) + ')' : '') + '\n' +
        data.map(function (b) { return '- ' + b; }).join('\n') + (data.length ? '\n' : '') + 'Link: ' + (link || '[link]'));
    });
    var k = ctxs.length;
    var intro = opts.followUp
      ? 'Following up with an update on ' + k + ' records since I last sent them:'
      : 'Sending over ' + k + ' records. Quick headlines on each:';
    var body = 'Hi ' + (opts.name || '[Name]') + ',\n\n' + intro + '\n\n' + blocks.join('\n\n') +
      '\n\nWould love to see them considered for ' + (opts.playlist || 'your playlists') + '.\n\n[Sign-off]';
    var lead = ctxs[0];
    var subject = lead ? (lead.artist || 'Artist') + ' "' + (lead.track || 'Track') + '"' + (k > 1 ? ' + ' + (k - 1) + ' more' : '') + (total ? ' | on ' + total + ' editorial playlists' : '') : '';
    return { subject: subject, body: body, label: label, missing: missing };
  }

  // ---------------------------------------------------------------- follow-up list
  // For each DSP: what editorial support has been added since you last pitched that DSP.
  function followUps(ctx, pitchesForIsrc) {
    var ed = editorialOnly(ctx.placements).filter(activeNow);
    return DSPS.map(function (d) {
      var last = pitchesForIsrc && pitchesForIsrc[d.key] ? pitchesForIsrc[d.key] : null;
      var fresh = ed.filter(function (p) {
        if (!last) return true;
        return (p.spans || []).some(function (sp) { return sp.added_at && sp.added_at > last; });
      });
      return { dsp: d.key, label: d.label, last: last, count: fresh.length, names: nameList(fresh, 3), never: !last };
    });
  }

  // ---------------------------------------------------------------- pasted link or ISRC
  // Turns whatever was pasted into either {type:'isrc'} or a tidy {type:'link'} that Spot On Track's search understands.
  function normalizeLink(input) {
    var raw = String(input || '').trim();
    if (!raw) return { error: 'Paste a Spotify track link or an ISRC.' };
    var compact = raw.replace(/[\s-]/g, '').toUpperCase();
    if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(compact)) return { type: 'isrc', value: compact };
    var m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(raw);
    if (m) return { type: 'link', value: 'https://open.spotify.com/track/' + m[1] };
    var u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { u = null; }
    var generic = 'Paste a Spotify, Apple Music, Deezer or Shazam track link, or an ISRC.';
    if (!u || !u.hostname || u.hostname.indexOf('.') < 0) return { error: generic };
    var host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'open.spotify.com') {
      m = /\/track\/([A-Za-z0-9]{22})/.exec(u.pathname);
      if (m) return { type: 'link', value: 'https://open.spotify.com/track/' + m[1] };
      return { error: 'That Spotify link is not a track. In Spotify use Share, then Copy Song Link.' };
    }
    if (host === 'music.apple.com') {
      var i = u.searchParams.get('i');
      return { type: 'link', value: 'https://music.apple.com' + u.pathname + (i ? '?i=' + i : '') };
    }
    if (host === 'deezer.com') {
      m = /\/track\/(\d+)/.exec(u.pathname);
      if (m) return { type: 'link', value: 'https://www.deezer.com/track/' + m[1] };
      return { error: 'That Deezer link is not a track link.' };
    }
    if (host === 'shazam.com') {
      m = /\/(?:track|song)\/(\d+)/.exec(u.pathname);
      if (m) return { type: 'link', value: 'https://www.shazam.com/song/' + m[1] };
      return { error: 'That Shazam link is not a track link.' };
    }
    return { error: generic };
  }

  // ---------------------------------------------------------------- build a record context
  function buildContext(entry, histRec, manualEntries, registry, today) {
    var meta = (histRec && histRec.meta) || {};
    var release = parseDate(entry.release_date) != null ? parseDate(entry.release_date) : parseDate(meta.release_date);
    var placements = effectivePlacements(histRec, manualEntries, registry);
    var links = {};
    var ml = meta.links || {};
    for (var k in ml) links[k] = ml[k];
    var el = entry.links || {};
    for (var k2 in el) if (el[k2]) links[k2] = el[k2];
    var ctx = {
      isrc: entry.isrc,
      artist: entry.artist || (meta.artists && meta.artists.join(', ')) || '',
      track: entry.track || meta.name || '',
      artwork: meta.artwork || null,
      label: entry.label || '',
      hook: entry.hook || '',
      release: release,
      links: links,
      placements: placements,
      charts: (histRec && histRec.charts) || {},
      streams: (histRec && histRec.streams) || [],
      shazams: (histRec && histRec.shazams) || [],
      errors: (histRec && histRec.errors) || [],
      syncedAt: (histRec && histRec.synced_at) || null,
      today: today
    };
    ctx.weeks = release != null ? weeklyTable(placements, release, today, 12) : [];
    ctx.defaultWeek = release != null ? defaultReportWeek(release, today) : 1;
    return ctx;
  }

  return {
    DAY: DAY, DSPS: DSPS, DSP_LABEL: DSP_LABEL,
    parseDate: parseDate, iso: iso, fmtLong: fmtLong, fmtShort: fmtShort, fmtNum: fmtNum, todayUTC: todayUTC,
    weekStart: weekStart, weekEnd: weekEnd, weekOf: weekOf, completedWeeks: completedWeeks, defaultReportWeek: defaultReportWeek,
    spanActiveAt: spanActiveAt, activeAt: activeAt, activeNow: activeNow, addedIn: addedIn, removedIn: removedIn, activeRegions: activeRegions,
    effectivePlacements: effectivePlacements, editorialOnly: editorialOnly, needsTagging: needsTagging,
    weeklyTable: weeklyTable, seriesSum: seriesSum, pctChange: pctChange,
    chartLabel: chartLabel, chartMoves: chartMoves, bestChartMove: bestChartMove,
    streamsBullet: streamsBullet, momentumBullet: momentumBullet, supportBullets: supportBullets, fmtCompact: fmtCompact, highlights: highlights, leadStats: leadStats, allBullets: allBullets, monitor: monitor, trendOf: trendOf, changeFeed: changeFeed, buildPitch: buildPitch, buildMultiPitch: buildMultiPitch, followUps: followUps,
    buildContext: buildContext, nameList: nameList, normalizeLink: normalizeLink
  };
}));
