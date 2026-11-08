/* Independent ReAnime ShiroX integration, experimental v0.4.1.
   Uses /api/v1/search, /api/v1/anime/<slug>/episodes and /api/flix/<anilist_id>/<ep>. No credentials or telemetry. */
var ReAnimeNew = (function () {
  'use strict';
  var BASE = 'https://reanime.to';
  function fail(s) { throw new Error('ReAnime New: ' + s); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function validSlug(x) { return /^[a-z0-9][a-z0-9_-]*$/i.test(String(x || '')); }
  function parseSlug(input) {
    var s = String(input || '');
    var m = s.match(/\/(?:anime|watch)\/([a-z0-9_-]+)/i);
    if (m) return m[1];
    if (validSlug(s)) return s;
    fail('Invalid anime identifier');
  }
  // href formats: "slug", "slug|anilistId", "slug|anilistId|episode"
  function parseRef(input) {
    var parts = String(input || '').split('|');
    return {
      slug: parseSlug(parts[0]),
      aid: /^\d+$/.test(parts[1] || '') ? parts[1] : '',
      ep: /^\d+$/.test(parts[2] || '') ? Number(parts[2]) : null
    };
  }
  function first(x, keys) { for (var i=0; i<keys.length; i++) if (x && x[keys[i]] != null) return x[keys[i]]; return null; }
  function imageOf(item) {
    var c = item.cover_image || item.coverImage || item.poster || item.image || {};
    return typeof c === 'string' ? c : first(c, ['extra_large','large','medium','url']) || '';
  }
  function textTitle(item) {
    var t = first(item, ['title','name','english_title']) || '';
    return typeof t === 'string' ? t : first(t, ['english','romaji','native']) || '';
  }
  function originOf(url) { return String(url).split('/').slice(0,3).join('/'); }
  async function load(path) {
    var url = BASE + path;
    var headers = {
      Accept: 'application/json, text/plain, */*',
      Referer: BASE + '/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    };
    var res;
    try {
      if (typeof fetchv2 === 'function') res = await fetchv2(url, headers, 'GET', null);
      else if (typeof fetch === 'function') res = await fetch(url, { headers: headers });
      else fail('This app version has no HTTP API');
    } catch (e) { fail('network error: ' + String(e && e.message || e).slice(0, 80)); }
    if (!res) fail('empty response');
    var body = '';
    try { body = await res.text(); } catch (_) {}
    var snippet = String(body).replace(/\s+/g, ' ').slice(0, 80);
    if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) {
      fail('HTTP ' + res.status + ' ' + snippet);
    }
    try { return JSON.parse(body); }
    catch (_) { fail('non-JSON: ' + snippet); }
  }
  function unwrap(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      var child = first(data,['results','data','anime','animes','items','episodes']);
      if (Array.isArray(child)) return child;
      if (child && typeof child === 'object') return unwrap(child);
    }
    return [];
  }
  async function tryPaths(paths) {
    var errors = [];
    for (var i = 0; i < paths.length; i++) {
      try { return await load(paths[i]); }
      catch (e) { errors.push(paths[i].split('?')[0] + ': ' + String(e.message || e).slice(0, 200)); }
    }
    fail('All API routes failed: ' + errors.join('; '));
  }
  async function animeInfo(slug) {
    var data = await tryPaths(['/api/v1/anime/' + encodeURIComponent(slug)]);
    return data.anime || data.data && data.data.anime || data.data || data;
  }
  async function anilistId(ref) {
    if (ref.aid) return ref.aid;
    var info = await animeInfo(ref.slug);
    var id = first(info, ['anilist_id','anilistId','mal_id','malId','id']);
    if (id == null || !/^\d+$/.test(String(id))) fail('Could not find the anime number for ' + ref.slug);
    return String(id);
  }
  async function search(q) {
    var term = String(q || '').trim();
    if (!term) return JSON.stringify([]);
    var data = await tryPaths(['/api/v1/search?q=' + encodeURIComponent(term) + '&limit=20', '/api/search?q=' + encodeURIComponent(term) + '&limit=20']);
    var results = unwrap(data).map(function(item) {
      var slug = first(item,['anime_id','slug','id']); if (typeof slug === 'number') slug = null;
      if (!validSlug(slug)) return null;
      var aid = first(item,['anilist_id','anilistId']);
      var href = String(slug) + (aid != null && /^\d+$/.test(String(aid)) ? '|' + aid : '');
      return {title:String(textTitle(item)), image:String(imageOf(item)), href:href};
    }).filter(function(x){return x && x.title;});
    if (!results.length) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[ReAnime New] Search response returned no recognized titles.');
    }
    return JSON.stringify(results);
  }
  async function details(href) {
    var ref = parseRef(href);
    var anime = await animeInfo(ref.slug);
    var year = first(anime, ['season_year','year']);
    return JSON.stringify([{
      description: String(first(anime,['description','synopsis','summary']) || 'No description available'),
      aliases: '',
      airdate: year ? String(year) : 'N/A'
    }]);
  }
  async function episodes(href) {
    var ref = parseRef(href);
    var aid = await anilistId(ref);
    var data = await tryPaths(['/api/v1/anime/' + encodeURIComponent(ref.slug) + '/episodes?limit=2000', '/api/episodes/' + encodeURIComponent(ref.slug)]);
    var rows = unwrap(data); if (rows.length === 0 && Array.isArray(data)) rows = data;
    return JSON.stringify(rows.map(function(item,i) {
      var number = Number(first(item,['episode_number','episodeNumber','number','episode','ep']) || i+1);
      return isFinite(number) && number>0 ? {number:number,href:ref.slug+'|'+aid+'|'+number} : null;
    }).filter(Boolean));
  }
  function playableUrl(s) {
    return /^https:\/\/[^\s]+\.(?:m3u8|mp4)(?:[?#]|$)/i.test(String(s || ''));
  }
  function looseMediaUrl(s) {
    return /^https:\/\//i.test(String(s || '')) && /m3u8/i.test(String(s));
  }
  function serverRank(item) {
    var n = String(item.serverName || '');
    return n === 'HD-2' ? 0 : n === 'HD-1' ? 1 : 2;
  }
  async function stream(href) {
    var ref = parseRef(href);
    if (!ref.ep || ref.ep < 1) fail('Invalid episode');
    var aid = await anilistId(ref);
    var data = await tryPaths(['/api/flix/' + aid + '/' + ref.ep + '?mal=' + aid]);
    var links = arr(data.servers || data.episode_links || data.data && data.data.servers || data.data && data.data.episode_links);
    var choices = links.filter(function(item) { return /^(?:sub|s-sub)$/i.test(String(item.dataType || item.type || 'sub')); });
    choices.sort(function(a,b){ return serverRank(a) - serverRank(b); });
    if (!choices.length) fail('No subtitle streams available');
    if (typeof networkFetch !== 'function') fail('ShiroX does not support networkFetch for embedded players');
    var notes = [];
    for (var i=0;i<Math.min(choices.length,3);i++) {
      var link = String(choices[i].dataLink || choices[i].url || '');
      var label = String(choices[i].serverName || ('server ' + (i+1)));
      if (!/^https:\/\//i.test(link)) { notes.push(label + ': bad link'); continue; }
      if (playableUrl(link)) return JSON.stringify({streams:[{title:'SUB',streamUrl:link,headers:{Referer:BASE+'/', Origin:BASE} }],subtitle:'',allSubtitles:[]});
      try {
        var cap = await networkFetch(link, {timeoutSeconds:14, headers:{Referer:BASE+'/'}, returnHTML:true, returnCookies:false, waitForSelectors:['video'], clickSelectors:['.art-icon-play[aria-label="Play"]','button[aria-label="Play"]'], maxWaitTime:4});
        var urls = arr(cap && cap.requests).map(function(r){return typeof r==='string'?r:r&&r.url;});
        if (cap && cap.cutoffUrl) urls.push(cap.cutoffUrl);
        var media = urls.filter(playableUrl)[0] || urls.filter(looseMediaUrl)[0];
        if (media) return JSON.stringify({streams:[{title:'SUB '+label,streamUrl:media,headers:{Referer:originOf(link)+'/', Origin:originOf(link)} }],subtitle:'',allSubtitles:[]});
        notes.push(label + ': ' + urls.length + ' requests, no media URL');
      } catch(err) {
        var msg = String(err.message||err).slice(0,100);
        notes.push(label + ': ' + msg);
        if(typeof console !== 'undefined' && console.warn) console.warn('[ReAnime New] player capture failed: ' + msg);
      }
    }
    fail('Could not capture an HLS/MP4 media URL from the embedded player (' + notes.join('; ') + ')');
  }
  return {search:search, details:details, episodes:episodes, stream:stream};
})();
async function searchResults(query) {return await ReAnimeNew.search(query);}
async function extractDetails(href) {return await ReAnimeNew.details(href);}
async function extractEpisodes(href) {return await ReAnimeNew.episodes(href);}
async function extractStreamUrl(href) {return await ReAnimeNew.stream(href);}
