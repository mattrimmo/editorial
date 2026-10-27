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
  // Honest selection: shows the strongest genuinely positive number, or nothing. The card always shows the full picture.
  function pickHeadline(ctx, n) {
    var rel = ctx.release;
    if (rel == null) return null;
    var s = weekStart(rel, n), e = weekEnd(rel, n);
    var fresh = newEditorialIn(ctx.placements, s, e);
    if (fresh.length) {
      return { kind: 'editorial_adds', text: fresh.length + ' new editorial add' + (fresh.length > 1 ? 's' : '') + ' in week ' + n + ': ' + nameList(fresh, 2) };
    }
    var chart = bestChartMove(ctx.charts);
    if (chart) return { kind: 'chart', text: chart.text };
    if (n >= 2) {
      var cur = seriesSum(ctx.streams, s, e), prev = seriesSum(ctx.streams, weekStart(rel, n - 1), weekEnd(rel, n - 1));
      var pct = cur && prev ? pctChange(cur.sum, prev.sum) : null;
      if (pct != null && pct >= 10) return { kind: 'streams', text: 'Spotify streams up ' + pct + '% on the week (' + fmtNum(cur.sum) + ' in week ' + n + ')' };
      var zc = seriesSum(ctx.shazams, s, e), zp = seriesSum(ctx.shazams, weekStart(rel, n - 1), weekEnd(rel, n - 1));
      var zpct = zc && zp ? pctChange(zc.sum, zp.sum) : null;
      if (zpct != null && zpct >= 10) return { kind: 'shazam', text: 'Shazams up ' + zpct + '% on the week (' + fmtNum(zc.sum) + ' in week ' + n + ')' };
    } else {
      var launch = seriesSum(ctx.streams, s, e);
      if (launch && launch.sum > 0) return { kind: 'launch_streams', text: fmtNum(launch.sum) + ' Spotify streams in launch week so far' };
    }
    return null;
  }

  // ---------------------------------------------------------------- pitch block
  function supportBullet(placements, targetDsp) {
    var ed = editorialOnly(placements).filter(activeNow);
    if (!ed.length) return { text: null, names: [] };
    var order = DSPS.map(function (d) { return d.key; });
    if (targetDsp && order.indexOf(targetDsp) > 0) { order.splice(order.indexOf(targetDsp), 1); order.unshift(targetDsp); }
    var parts = [], used = 0, hidden = 0, firstNames = [];
    order.forEach(function (key) {
      var mine = ed.filter(function (p) { return p.dsp === key; });
      if (!mine.length) return;
      mine.sort(function (a, b) {
        return (b.followers || 0) - (a.followers || 0) || activeRegions(b).length - activeRegions(a).length || String(a.name).localeCompare(String(b.name));
      });
      var room = 4 - used;
      var take = room > 0 ? mine.slice(0, Math.min(2, room)) : [];
      hidden += mine.length - take.length;
      if (!take.length) return;
      used += take.length;
      var bits = take.map(function (p) {
        var rg = activeRegions(p).slice(0, 3);
        return (p.name || '(unnamed)') + (rg.length ? ' ' + rg.join('/') : '');
      });
      take.forEach(function (p) { firstNames.push(p.name || ''); });
      parts.push(DSP_LABEL[key] + ' (' + bits.join(', ') + ')');
    });
    var text = 'Editorial support: ' + parts.join(' | ') + (hidden > 0 ? ' (+' + hidden + ' more)' : '');
    return { text: text, names: firstNames };
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
    var support = supportBullet(ctx.placements, dspKey);
    var headline = pickHeadline(ctx, n);
    var bullets = [];
    if (support.text) bullets.push(support.text);
    if (headline) bullets.push(headline.text);
    if (ctx.hook) bullets.push(ctx.hook);

    var link = linkFor(ctx, dspKey) || '[link]';
    var intro = opts.followUp
      ? 'Following up on ' + (ctx.track || 'the record') + ' (' + relTxt + '). Quick update since I last sent it:'
      : 'Sending over ' + title + ' (' + relTxt + '). Quick headlines:';
    var body = 'Hi ' + (opts.name || '[Name]') + ',\n\n' + intro + '\n\n' +
      (bullets.length ? bullets.map(function (b) { return '- ' + b; }).join('\n') + '\n\n' : '') +
      'Would love to see it considered for ' + (opts.playlist || '[playlist]') + '. Link: ' + link + '\n\n[Sign-off]';

    var tag = support.names.length ? 'on ' + support.names.slice(0, 2).join(' + ') : 'out ' + fmtShort(ctx.release != null ? ctx.release : Date.now());
    var subject = (ctx.artist || 'Artist') + ' "' + (ctx.track || 'Track') + '" | ' + tag;
    return { subject: subject, body: body, headline: headline, label: label, bullets: bullets, missingLink: link === '[link]' };
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
    pickHeadline: pickHeadline, supportBullet: supportBullet, buildPitch: buildPitch, followUps: followUps,
    buildContext: buildContext, nameList: nameList
  };
}));
