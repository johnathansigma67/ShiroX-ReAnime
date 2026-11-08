/* Independent ReAnime ShiroX integration, experimental v0.3.1. Search tries both documented API routes.
   Uses /api/search, /api/episodes, /api/watch. No credentials or telemetry. */
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
  function first(x, keys) { for (var i=0; i<keys.length; i++) if (x && x[keys[i]] != null) return x[keys[i]]; return null; }
  function imageOf(item) {
    var c = item.cover_image || item.coverImage || item.poster || item.image || {};
    return typeof c === 'string' ? c : first(c, ['extra_large','large','medium','url']) || '';
  }
  function textTitle(item) {
    var t = first(item, ['title','name','english_title']) || '';
    return typeof t === 'string' ? t : first(t, ['english','romaji','native']) || '';
  }
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
  async function search(q) {
    var term = String(q || '').trim();
    if (!term) return JSON.stringify([]);
    var data = await tryPaths(['/api/search?q=' + encodeURIComponent(term) + '&limit=20', '/api/v1/search?q=' + encodeURIComponent(term) + '&limit=20']);
    var results = unwrap(data).map(function(item) {
      var slug = first(item,['anime_id','slug','id']); if (typeof slug === 'number') slug = null;
      if (!validSlug(slug)) return null;
      return {title:String(textTitle(item)), image:String(imageOf(item)), href:String(slug)};
    }).filter(function(x){return x && x.title;});
    if (!results.length) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[ReAnime New] Search response returned no recognized titles.');
    }
    return JSON.stringify(results);
  }
  async function details(href) {
    var slug = parseSlug(href);
    var watch = await tryPaths(['/api/watch/' + encodeURIComponent(slug) + '/1', '/api/v1/anime/' + encodeURIComponent(slug)]);
    var anime = watch.anime || watch.data && watch.data.anime || watch;
    return JSON.stringify([{ description:String(first(anime,['description','synopsis','summary']) || 'No description available'), aliases:'', airdate:'N/A' }]);
  }
  async function episodes(href) {
    var slug = parseSlug(href);
    var data = await tryPaths(['/api/episodes/' + encodeURIComponent(slug), '/api/v1/anime/' + encodeURIComponent(slug) + '/episodes?limit=2000']);
    var rows = unwrap(data); if (rows.length === 0 && Array.isArray(data)) rows = data;
    return JSON.stringify(rows.map(function(item,i) {
      var number = Number(first(item,['episode_number','episodeNumber','number','episode','ep']) || i+1);
      return isFinite(number) && number>0 ? {number:number,href:slug+'|'+number} : null;
    }).filter(Boolean));
  }
  function playableUrl(s) {
    return /^https:\/\/[^\s]+\.(?:m3u8|mp4)(?:[?#]|$)/i.test(String(s || ''));
  }
  async function stream(href) {
    var parts = String(href).split('|'), slug = parseSlug(parts[0]);
    var ep = Number(parts[1]);
    if (!isFinite(ep) || ep < 1) fail('Invalid episode');
    var data = await tryPaths(['/api/watch/' + encodeURIComponent(slug) + '/' + ep, '/api/v1/watch/' + encodeURIComponent(slug) + '/' + ep]);
    var links = arr(data.episode_links || data.servers || data.data && data.data.episode_links || data.data && data.data.servers);
    var choices = links.filter(function(item) { return /^(?:sub|s-sub)$/i.test(String(item.dataType || item.type || 'sub')); });
    choices.sort(function(a,b){return (a.serverName==='HD-2'?-1:0)-(b.serverName==='HD-2'?-1:0);});
    if (!choices.length) fail('No subtitle streams available');
    if (typeof networkFetch !== 'function') fail('ShiroX does not support networkFetch for embedded players');
    for (var i=0;i<Math.min(choices.length,3);i++) {
      var link = String(choices[i].dataLink || choices[i].url || '');
      if (!/^https:\/\//i.test(link)) continue;
      if (playableUrl(link)) return JSON.stringify({streams:[{title:'SUB',streamUrl:link,headers:{Referer:BASE+'/'} }],subtitle:'',allSubtitles:[]});
      try {
        var cap = await networkFetch(link, {timeoutSeconds:14, headers:{Referer:BASE+'/'}, returnHTML:true, returnCookies:false, waitForSelectors:['video'], clickSelectors:['.art-icon-play[aria-label="Play"]','button[aria-label="Play"]'], maxWaitTime:4});
        var urls = arr(cap && cap.requests).map(function(r){return typeof r==='string'?r:r&&r.url;});
        if (cap && cap.cutoffUrl) urls.push(cap.cutoffUrl);
        var media = urls.filter(playableUrl)[0];
        if (media) return JSON.stringify({streams:[{title:'SUB '+String(choices[i].serverName||''),streamUrl:media,headers:{Referer:link.split('/').slice(0,3).join('/')+'/'} }],subtitle:'',allSubtitles:[]});
      } catch(err) { if(typeof console !== 'undefined' && console.warn) console.warn('[ReAnime New] player capture failed: '+String(err.message||err).slice(0,140)); }
    }
    fail('Could not capture an HLS/MP4 media URL from the embedded player');
  }
  return {search:search, details:details, episodes:episodes, stream:stream};
})();
async function searchResults(query) {return await ReAnimeNew.search(query);}
async function extractDetails(href) {return await ReAnimeNew.details(href);}
async function extractEpisodes(href) {return await ReAnimeNew.episodes(href);}
async function extractStreamUrl(href) {return await ReAnimeNew.stream(href);}
