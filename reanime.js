
/* ReAnime ShiroX experimental v0.4.0. No accounts or telemetry.
 * Stream fallback for flix server discovery; NOT a verified FlixCloud decryptor.
 */
var ReAnimeNew = (function () {
  'use strict';
  var BASE = 'https://reanime.to';
  function fail(s) { throw new Error('ReAnime v0.4: ' + s); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function pick(x, keys) { for (var i=0;i<keys.length;i++) if (x && x[keys[i]] != null) return x[keys[i]]; return null; }
  function validSlug(s) { return /^[a-z0-9][a-z0-9_-]*$/i.test(String(s || '')); }
  function slugOf(s) {
    s = String(s || '');
    var m = s.match(/\/(?:anime|watch)\/([a-z0-9_-]+)/i);
    if (m) return m[1];
    if (validSlug(s)) return s;
    fail('Invalid anime slug');
  }
  function titleOf(o) { var t = pick(o,['title','name','english_title']) || ''; return typeof t==='string'?t:pick(t,['english','romaji','native'])||''; }
  function imageOf(o) { var c = pick(o,['cover_image','coverImage','poster','image']) || ''; return typeof c==='string'?c:pick(c,['extra_large','large','medium','url'])||''; }
  function unwrap(x) {
    if (Array.isArray(x)) return x;
    if (x && typeof x==='object') {
      var v = pick(x,['results','data','anime','animes','items','episodes']);
      if (v) return unwrap(v);
    }
    return [];
  }
  async function get(path) {
    var res, url = BASE + path;
    if (typeof fetchv2==='function') res = await fetchv2(url,{Accept:'application/json',Referer:BASE+'/'},'GET',null);
    else if (typeof fetch==='function') res = await fetch(url,{headers:{Accept:'application/json',Referer:BASE+'/'}});
    else fail('No HTTP transport');
    if (!res || !(res.ok || res.status>=200 && res.status<300)) throw new Error('HTTP '+(res && res.status || '?')+' '+path.split('?')[0]);
    var body = await res.text();
    try { return JSON.parse(body); } catch(e) { throw new Error('Non-JSON '+path.split('?')[0]); }
  }
  async function routes(paths,label) {
    var problems=[];
    for(var i=0;i<paths.length;i++) {
      try { return await get(paths[i]); }
      catch(e) { problems.push(paths[i].split('?')[0]+': '+String(e.message||e).slice(0,80)); }
    }
    fail(label+' failed: '+problems.join(' | '));
  }
  async function search(q) {
    q = String(q||'').trim(); if(!q) return '[]';
    var data=await routes(['/api/search?q='+encodeURIComponent(q)+'&limit=20','/api/v1/search?q='+encodeURIComponent(q)+'&limit=20'],'search');
    return JSON.stringify(unwrap(data).map(function(x){
      var s=pick(x,['anime_id','slug','id']);
      return validSlug(s)?{title:String(titleOf(x)),image:String(imageOf(x)),href:String(s)}:null;
    }).filter(function(x){return x && x.title;}));
  }
  async function details(href) {
    var slug=slugOf(href);
    var data=await routes(['/api/v1/anime/'+encodeURIComponent(slug),'/api/watch/'+encodeURIComponent(slug)+'/1'],'details');
    var anime=pick(data,['anime']) || data.data && data.data.anime || data;
    return JSON.stringify([{description:String(pick(anime,['description','synopsis','summary'])||'No description available'),aliases:'',airdate:'N/A'}]);
  }
  async function episodes(href) {
    var slug=slugOf(href), data=await routes(['/api/episodes/'+encodeURIComponent(slug),'/api/v1/anime/'+encodeURIComponent(slug)+'/episodes?limit=2000'],'episodes');
    return JSON.stringify(unwrap(data).map(function(x,i){
      var n=Number(pick(x,['episode_number','episodeNumber','number','episode','ep'])||i+1);
      return isFinite(n)&&n>0?{number:n,href:slug+'|'+n}:null;
    }).filter(Boolean));
  }
  function playable(u) {return /^https:\/\/[^\s]+\.(?:m3u8|mp4)(?:[?#]|$)/i.test(String(u||''));}
  function streamsOf(data) {
    var d=data && data.data || data || {};
    var subs=arr(d.sub || d.subbed || d.subs);
    var links=arr(pick(d,['episode_links','servers','sources','links']));
    if (!subs.length) subs=links.filter(function(x){ return !/dub/i.test(String(x.dataType||x.type||'')); });
    return subs;
  }
  function anilistId(data) {
    var d=data&&data.data||data||{};
    var anime=d.anime||{};
    var id=pick(d,['anilist_id','anilistId','anilistID']) || pick(anime,['anilist_id','anilistId','anilistID']);
    return /^\d+$/.test(String(id||'')) ? String(id) : null;
  }
  async function stream(href) {
    var p=String(href||'').split('|'), slug=slugOf(p[0]), ep=Number(p[1]);
    if(!Number.isInteger(ep)||ep<1) fail('Invalid episode number');
    var encoded=encodeURIComponent(slug), attempts=[], links=[], id=null;
    var candidates=[
      '/api/flix/'+encoded+'/'+ep,
      '/api/flix/'+encoded+'?episode='+ep,
      '/api/watch/'+encoded+'/'+ep,
      '/api/v1/watch/'+encoded+'/'+ep
    ];
    for(var i=0;i<candidates.length;i++) {
      try {
        var d=await get(candidates[i]);
        id=id||anilistId(d);
        links=streamsOf(d);
        if(links.length) break;
        attempts.push(candidates[i]+' returned no sub servers');
      }catch(e){attempts.push(String(e.message||e));}
    }
    // Some ReAnime builds use the numeric AniList identifier in /api/flix.
    if(!links.length) {
      try {
        var meta=await get('/api/v1/anime/'+encoded);
        id=id||anilistId(meta);
      }catch(e){attempts.push('AniList ID lookup: '+String(e.message||e));}
      if(id) {
        try { links=streamsOf(await get('/api/flix/'+id+'/'+ep)); }
        catch(e){attempts.push('numeric /api/flix: '+String(e.message||e));}
      }
    }
    if(!links.length) fail('No subtitle servers. '+attempts.slice(-4).join(' | '));
    links.sort(function(a,b){return Number(b.serverName==='HD-2')-Number(a.serverName==='HD-2');});
    var captureErrors=[];
    for(var j=0;j<Math.min(links.length,4);j++) {
      var link=String(pick(links[j],['dataLink','url','link','src'])||'');
      if(!/^https:\/\//i.test(link)) continue;
      if(playable(link)) return JSON.stringify({streams:[{title:'ReAnime SUB',streamUrl:link,headers:{Referer:BASE+'/'}}],subtitle:'',allSubtitles:[]});
      if(typeof networkFetch!=='function') fail('Found an embedded player, but this ShiroX build lacks networkFetch.');
      try {
        var cap=await networkFetch(link,{timeoutSeconds:20,headers:{Referer:BASE+'/'},returnHTML:true,returnCookies:false,waitForSelectors:['video'],clickSelectors:['.art-icon-play[aria-label="Play"]','button[aria-label="Play"]'],maxWaitTime:5});
        var urls=arr(cap&&cap.requests).map(function(r){return typeof r==='string'?r:r&&r.url;});
        if(cap&&cap.cutoffUrl) urls.push(cap.cutoffUrl);
        var media=urls.filter(playable)[0];
        if(media) return JSON.stringify({streams:[{title:'ReAnime SUB',streamUrl:media,headers:{Referer:link.split('/').slice(0,3).join('/')+'/'}}],subtitle:'',allSubtitles:[]});
        captureErrors.push('No .m3u8/.mp4 captured from '+link.split('/')[2]);
      }catch(e){captureErrors.push(String(e.message||e).slice(0,90));}
    }
    fail('Found embed server, but no playable URL. '+captureErrors.join(' | ')+'; FlixCloud may require a separate resolver.');
  }
  return {search:search,details:details,episodes:episodes,stream:stream};
})();
async function searchResults(query){return await ReAnimeNew.search(query);}
async function extractDetails(href){return await ReAnimeNew.details(href);}
async function extractEpisodes(href){return await ReAnimeNew.episodes(href);}
async function extractStreamUrl(href){return await ReAnimeNew.stream(href);}
