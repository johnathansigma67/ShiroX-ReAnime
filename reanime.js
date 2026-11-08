
/*
 ReAnime for ShiroX - Experimental v0.4.2

 Changes:
 - Prioritize HD-1 over HD-2
 - Test captured HLS playlists before returning them
 - Try alternative servers if a playlist fails
 - Report HTTP and playlist errors
 - Preserve search, details, and episodes
*/

var ReAnimeNew = (function () {
  'use strict';

  var BASE = 'https://reanime.to';

  function fail(message) {
    throw new Error('ReAnime v0.4.2: ' + message);
  }

  function arr(value) {
    return Array.isArray(value) ? value : [];
  }

  function first(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] != null) {
        return obj[keys[i]];
      }
    }
    return null;
  }

  function validSlug(value) {
    return /^[a-z0-9][a-z0-9_-]*$/i.test(
      String(value || '')
    );
  }

  function parseSlug(input) {
    var value = String(input || '');
    var match = value.match(
      /\/(?:anime|watch)\/([a-z0-9_-]+)/i
    );

    if (match) return match[1];
    if (validSlug(value)) return value;

    fail('Invalid anime identifier');
  }

  function parseRef(input) {
    var parts = String(input || '').split('|');

    return {
      slug: parseSlug(parts[0]),
      aid: /^\d+$/.test(parts[1] || '')
        ? parts[1] : '',
      ep: /^\d+$/.test(parts[2] || '')
        ? Number(parts[2]) : null
    };
  }

  function originOf(url) {
    try {
      return new URL(String(url)).origin;
    } catch (_) {
      return String(url).split('/').slice(0, 3).join('/');
    }
  }

  function imageOf(item) {
    var cover = item.cover_image ||
      item.coverImage ||
      item.poster ||
      item.image ||
      {};

    if (typeof cover === 'string') return cover;

    return first(cover, [
      'extra_large',
      'large',
      'medium',
      'url'
    ]) || '';
  }

  function textTitle(item) {
    var title = first(item, [
      'title',
      'name',
      'english_title'
    ]) || '';

    if (typeof title === 'string') return title;

    return first(title, [
      'english',
      'romaji',
      'native'
    ]) || '';
  }

  async function request(url, headers) {
    if (typeof fetchv2 === 'function') {
      return await fetchv2(
        url,
        headers,
        'GET',
        null
      );
    }

    if (typeof fetch === 'function') {
      return await fetch(url, {
        method: 'GET',
        headers: headers
      });
    }

    fail('No supported HTTP transport');
  }

  async function load(path) {
    var headers = {
      Accept: 'application/json, text/plain, */*',
      Referer: BASE + '/',
      Origin: BASE
    };

    var res;

    try {
      res = await request(BASE + path, headers);
    } catch (error) {
      fail(
        'Network: ' +
        String(error.message || error).slice(0, 120)
      );
    }

    if (!res) fail('Empty HTTP response');

    var body = await res.text();

    if (
      typeof res.status === 'number' &&
      (res.status < 200 || res.status >= 300)
    ) {
      fail('HTTP ' + res.status + ' ' + path);
    }

    try {
      return JSON.parse(body);
    } catch (_) {
      fail('Invalid JSON from ' + path);
    }
  }

  function unwrap(data) {
    if (Array.isArray(data)) return data;

    if (data && typeof data === 'object') {
      var child = first(data, [
        'results',
        'data',
        'anime',
        'animes',
        'items',
        'episodes'
      ]);

      if (Array.isArray(child)) return child;

      if (child && typeof child === 'object') {
        return unwrap(child);
      }
    }

    return [];
  }

  async function tryPaths(paths) {
    var errors = [];

    for (var i = 0; i < paths.length; i++) {
      try {
        return await load(paths[i]);
      } catch (error) {
        errors.push(
          String(error.message || error).slice(0, 150)
        );
      }
    }

    fail('All API routes failed: ' + errors.join('; '));
  }

  async function animeInfo(slug) {
    var data = await tryPaths([
      '/api/v1/anime/' + encodeURIComponent(slug)
    ]);

    return data.anime ||
      (data.data && data.data.anime) ||
      data.data ||
      data;
  }

  async function anilistId(ref) {
    if (ref.aid) return ref.aid;

    var info = await animeInfo(ref.slug);

    var id = first(info, [
      'anilist_id',
      'anilistId',
      'mal_id',
      'malId',
      'id'
    ]);

    if (id == null || !/^\d+$/.test(String(id))) {
      fail('Missing anime numeric ID');
    }

    return String(id);
  }

  async function search(query) {
    var term = String(query || '').trim();

    if (!term) return JSON.stringify([]);

    var data = await tryPaths([
      '/api/v1/search?q=' +
        encodeURIComponent(term) + '&limit=20',
      '/api/search?q=' +
        encodeURIComponent(term) + '&limit=20'
    ]);

    var results = unwrap(data).map(function (item) {
      var slug = first(item, [
        'anime_id',
        'slug',
        'id'
      ]);

      if (
        typeof slug === 'number' ||
        !validSlug(slug)
      ) {
        return null;
      }

      var aid = first(item, [
        'anilist_id',
        'anilistId'
      ]);

      var href = String(slug);

      if (aid != null && /^\d+$/.test(String(aid))) {
        href += '|' + aid;
      }

      return {
        title: String(textTitle(item)),
        image: String(imageOf(item)),
        href: href
      };
    }).filter(function (item) {
      return item && item.title;
    });

    return JSON.stringify(results);
  }

  async function details(href) {
    var ref = parseRef(href);
    var anime = await animeInfo(ref.slug);

    var year = first(anime, [
      'season_year',
      'year'
    ]);

    return JSON.stringify([{
      description: String(
        first(anime, [
          'description',
          'synopsis',
          'summary'
        ]) || 'No description available'
      ),
      aliases: '',
      airdate: year ? String(year) : 'N/A'
    }]);
  }

  async function episodes(href) {
    var ref = parseRef(href);
    var aid = await anilistId(ref);

    var data = await tryPaths([
      '/api/v1/anime/' +
        encodeURIComponent(ref.slug) +
        '/episodes?limit=2000',
      '/api/episodes/' +
        encodeURIComponent(ref.slug)
    ]);

    var rows = unwrap(data);

    if (!rows.length && Array.isArray(data)) {
      rows = data;
    }

    return JSON.stringify(
      rows.map(function (item, index) {
        var number = Number(
          first(item, [
            'episode_number',
            'episodeNumber',
            'number',
            'episode',
            'ep'
          ]) || index + 1
        );

        if (!isFinite(number) || number < 1) {
          return null;
        }

        return {
          number: number,
          href: ref.slug + '|' + aid + '|' + number
        };
      }).filter(Boolean)
    );
  }

  // Prefer HD-1 for compatibility testing.
  function serverRank(item) {
    var name = String(
      item.serverName || ''
    ).toUpperCase();

    if (name === 'HD-1') return 0;
    if (name === 'HD-2') return 1;

    return 2;
  }

  function playableUrl(url) {
    return /^https:\/\/[^\s]+\.(m3u8|mp4)([?#]|$)/i
      .test(String(url || ''));
  }

  function looseMediaUrl(url) {
    return /^https:\/\//i.test(String(url || '')) &&
      /m3u8/i.test(String(url));
  }

  function mediaHeaders(embedUrl) {
    var origin = originOf(embedUrl);

    return {
      Referer: origin + '/',
      Origin: origin
    };
  }

  // Return diagnostics without printing private media URLs.
  async function checkPlaylist(url, headers) {
    var result = {
      valid: false,
      status: null,
      reason: ''
    };

    try {
      var response = await request(
        url,
        Object.assign(
          { Accept: '*/*' },
          headers
        )
      );

      if (!response) {
        result.reason = 'Empty playlist response';
        return result;
      }

      result.status = response.status;

      if (
        typeof response.status === 'number' &&
        (response.status < 200 || response.status >= 300)
      ) {
        result.reason = 'Playlist HTTP ' + response.status;
        return result;
      }

      var body = await response.text();

      if (typeof body !== 'string') {
        result.reason = 'Playlist response is not text';
        return result;
      }

      // Remove optional UTF-8 BOM and whitespace.
      body = body.replace(/^\uFEFF/, '').trim();

      if (!body.startsWith('#EXTM3U')) {
        result.reason =
          'Playlist does not start with #EXTM3U';
        return result;
      }

      if (
        !body.includes('#EXT-X-STREAM-INF') &&
        !body.includes('#EXTINF')
      ) {
        result.reason =
          'Playlist has no recognized media entries';
        return result;
      }

      result.valid = true;
      result.reason = 'Standard HLS playlist found';

      return result;

    } catch (error) {
      result.reason =
        'Playlist check failed: ' +
        String(error.message || error).slice(0, 100);

      return result;
    }
  }

  function outputStream(url, title, headers) {
    return JSON.stringify({
      streams: [{
        title: title,
        streamUrl: url,
        headers: headers
      }],
      subtitle: '',
      allSubtitles: []
    });
  }

  async function stream(href) {
    var ref = parseRef(href);

    if (!ref.ep || ref.ep < 1) {
      fail('Invalid episode');
    }

    var aid = await anilistId(ref);

    var data = await tryPaths([
      '/api/flix/' + aid + '/' +
        ref.ep + '?mal=' + aid
    ]);

    var links = arr(
      data.servers ||
      data.episode_links ||
      (data.data && data.data.servers) ||
      (data.data && data.data.episode_links)
    );

    var choices = links.filter(function (item) {
      return /^(sub|s-sub)$/i.test(
        String(item.dataType || item.type || 'sub')
      );
    });

    choices.sort(function (a, b) {
      return serverRank(a) - serverRank(b);
    });

    if (!choices.length) {
      fail('No subtitle servers returned');
    }

    if (typeof networkFetch !== 'function') {
      fail('networkFetch unavailable');
    }

    var notes = [];

    for (var i = 0; i < choices.length; i++) {
      var server = choices[i];

      var embed = String(
        server.dataLink ||
        server.url ||
        ''
      );

      var label = String(
        server.serverName || ('Server ' + (i + 1))
      );

      if (!/^https:\/\//i.test(embed)) {
        notes.push(label + ': invalid server URL');
        continue;
      }

      var headers = mediaHeaders(embed);

      // A direct MP4 doesn't need an HLS playlist check.
      if (/\.mp4(?:[?#]|$)/i.test(embed)) {
        return outputStream(
          embed,
          'SUB ' + label,
          headers
        );
      }

      var urls = [];

      if (playableUrl(embed) || looseMediaUrl(embed)) {
        urls.push(embed);
      } else {
        try {
          var capture = await networkFetch(embed, {
            timeoutSeconds: 20,
            headers: {
              Referer: BASE + '/'
            },
            returnHTML: true,
            returnCookies: false,
            waitForSelectors: ['video'],
            clickSelectors: [
              '.art-icon-play[aria-label="Play"]',
              'button[aria-label="Play"]'
            ],
            maxWaitTime: 5
          });

          urls = arr(capture && capture.requests)
            .map(function (item) {
              return typeof item === 'string'
                ? item
                : item && item.url;
            })
            .filter(Boolean);

          if (capture && capture.cutoffUrl) {
            urls.push(capture.cutoffUrl);
          }

        } catch (error) {
          notes.push(
            label + ': capture failed: ' +
            String(error.message || error).slice(0, 90)
          );
          continue;
        }
      }

      var candidates = urls.filter(function (url) {
        return playableUrl(url) || looseMediaUrl(url);
      });

      if (!candidates.length) {
        notes.push(
          label + ': no captured media URL'
        );
        continue;
      }

      // Prefer direct MP4 if available.
      var mp4 = candidates.filter(function (url) {
        return /\.mp4(?:[?#]|$)/i.test(url);
      })[0];

      if (mp4) {
        return outputStream(
          mp4,
          'SUB ' + label,
          headers
        );
      }

      // Validate each HLS candidate before playback.
      for (var j = 0; j < candidates.length; j++) {
        var media = candidates[j];

        var check = await checkPlaylist(
          media,
          headers
        );

        if (check.valid) {
          return outputStream(
            media,
            'SUB ' + label + ' (HLS)',
            headers
          );
        }

        notes.push(
          label + ': ' + check.reason
        );
      }
    }

    fail(
      'No validated playback stream. ' +
      notes.slice(0, 6).join(' | ')
    );
  }

  return {
    search: search,
    details: details,
    episodes: episodes,
    stream: stream
  };

})();

async function searchResults(query) {
  return await ReAnimeNew.search(query);
}

async function extractDetails(href) {
  return await ReAnimeNew.details(href);
}

async function extractEpisodes(href) {
  return await ReAnimeNew.episodes(href);
}

async function extractStreamUrl(href) {
  return await ReAnimeNew.stream(href);
}
