/**
 * Nuvio provider: Dailymotion
 * File: providers/dailymotion.js
 *
 * QuickJS / Hermes-safe: Promise chains only (no async/await).
 * No Node APIs (no require/child_process).
 *
 * Playback: cdndirector.dailymotion.com is often Cloudflare-blocked for
 * native players. We resolve the master playlist to vod*.cf.dmcdn.net URLs
 * and re-host that small master on HTTPS (catbox) so Nuvio gets a normal
 * https://...m3u8 URL.
 */

var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var PLAYBACK_HEADERS = {
  Referer: "https://www.dailymotion.com/",
  Origin: "https://www.dailymotion.com",
  "User-Agent": USER_AGENT,
  priority: "u=1, i",
  Accept: "*/*",
};

var MONTHS_RO = [
  "ianuarie",
  "februarie",
  "martie",
  "aprilie",
  "mai",
  "iunie",
  "iulie",
  "august",
  "septembrie",
  "octombrie",
  "noiembrie",
  "decembrie",
];

var MONTHS_EN = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// Manual TMDB → Dailymotion mappings. Keys are "tmdbId:mediaType:season:episode".
// Prefer moremusic (https://www.dailymotion.com/user/moremusic/videos) for Romanian TV.
var VIDEO_MAP = {
  // Insula Iubirii - Reuniuni
  "329884:tv:1:1": ["xarl2pi", "xarlbya"],
  "329884:tv:1:2": ["xatiixa", "xatoa4a"],
  "329884:tv:1:3": ["xavja42", "xavk1qe"],
  "329884:tv:1:4": ["xaxi3hi", "xaxij32"],
  "329884:tv:1:5": ["xazd6le", "xaze0iu"],
  // Insula Iubirii (main show) S10
  "62767:tv:10:1": ["xb40hte", "xb40jxy"],
  "62767:tv:10:2": ["xb4faau", "xb4bkqi", "xb4axsq"],
};

var PREFERRED_CHANNELS = ["moremusic"];
var MAX_VIDEOS = 6;
var PLAYLIST_TIMEOUT_MS = 8000;
var channelCatalogCache = {};
var sessionWarmup = null;

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(
    "[Dailymotion] Fetching " + mediaType + " " + tmdbId +
      (season ? " S" + season + "E" + episode : "")
  );

  return warmSession()
    .then(function () {
      return getTmdbInfo(tmdbId, mediaType, season, episode);
    })
    .then(function (info) {
      var mappedIds = VIDEO_MAP[mapKey(tmdbId, mediaType, season, episode)] || [];

      // Mapped episodes: skip search (fast, reliable — same approach as VK).
      if (mappedIds.length) {
        return Promise.all(mappedIds.map(getVideoMetadata)).then(function (videos) {
          var mapped = videos.filter(Boolean);
          console.log("[Dailymotion] Using " + mapped.length + " mapped video(s)");
          return mapped;
        });
      }

      var queries = buildSearchQueries(info, mediaType, season, episode);
      var fromChannels = listPreferredChannelMatches(info, mediaType, season, episode);
      var fromChannelSearch = searchPreferredChannels(queries).then(function (videos) {
        return filterVideos(videos, info, mediaType, season, episode);
      });
      var fromGlobal = searchAllQueries(queries).then(function (videos) {
        return filterVideos(videos, info, mediaType, season, episode);
      });

      return Promise.all([fromChannels, fromChannelSearch, fromGlobal]).then(function (parts) {
        var combined = sortVideos(
          uniqueVideos(parts[0].concat(parts[1]).concat(parts[2]))
        ).slice(0, MAX_VIDEOS);
        console.log("[Dailymotion] Matched " + combined.length + " videos");
        return combined;
      });
    })
    .then(function (videos) {
      return mapLimited(videos, 2, streamsFromVideo).then(function (groups) {
        var streams = [];
        groups.forEach(function (group) {
          streams = streams.concat(group);
        });
        console.log("[Dailymotion] Returning " + streams.length + " streams");
        return streams;
      });
    })
    .catch(function (error) {
      console.error("[Dailymotion] Error: " + (error && error.message ? error.message : error));
      return [];
    });
}

function warmSession() {
  if (sessionWarmup) return sessionWarmup;

  sessionWarmup = fetch("https://www.dailymotion.com/", {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  })
    .then(function (response) {
      return mergeCookies("", readSetCookies(response));
    })
    .catch(function () {
      return "";
    });

  return sessionWarmup;
}

function getTmdbInfo(tmdbId, mediaType, season, episode) {
  var endpoint = mediaType === "tv" ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" +
    endpoint +
    "/" +
    tmdbId +
    "?api_key=" +
    TMDB_API_KEY;

  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  })
    .then(function (response) {
      if (!response.ok) {
        throw new Error("TMDB HTTP " + response.status);
      }
      return response.json();
    })
    .then(function (data) {
      var title = mediaType === "tv" ? data.name : data.title;
      var originalTitle = mediaType === "tv" ? data.original_name : data.original_title;
      var date = mediaType === "tv" ? data.first_air_date : data.release_date;
      var year = date ? String(date).substring(0, 4) : "";

      if (!title && !originalTitle) {
        throw new Error("Could not resolve title from TMDB");
      }

      var info = {
        title: title || originalTitle,
        originalTitle: originalTitle || title,
        year: year,
        airDate: "",
      };

      console.log('[Dailymotion] TMDB: "' + info.title + '" (' + year + ")");

      if (mediaType !== "tv" || !season || !episode) {
        return info;
      }

      return fetch(
        "https://api.themoviedb.org/3/tv/" +
          tmdbId +
          "/season/" +
          season +
          "?api_key=" +
          TMDB_API_KEY,
        { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
      )
        .then(function (response) {
          return response.ok ? response.json() : { episodes: [] };
        })
        .then(function (seasonData) {
          var episodes = seasonData.episodes || [];
          for (var i = 0; i < episodes.length; i++) {
            if (Number(episodes[i].episode_number) === Number(episode)) {
              info.airDate = episodes[i].air_date || "";
              break;
            }
          }
          return info;
        })
        .catch(function () {
          return info;
        });
    });
}

function buildSearchQueries(info, mediaType, season, episode) {
  var titles = uniqueStrings([info.originalTitle, info.title]);
  var queries = [];

  titles.forEach(function (title) {
    if (mediaType === "tv" && season && episode) {
      queries.push(title + " sezonul " + season + " ep " + episode);
      queries.push(title + " sezonul " + season + " episodul " + episode);
      queries.push(title + " s" + pad(season) + "e" + pad(episode));
      queries.push(title + " episodul " + episode);
      if (info.airDate) {
        var dateQuery = dateSearchText(info.airDate);
        if (dateQuery) queries.push(title + " " + dateQuery);
      }
    } else if (info.year) {
      queries.push(title + " " + info.year);
    } else {
      queries.push(title);
    }
  });

  return uniqueStrings(queries).slice(0, 6);
}

function searchAllQueries(queries) {
  var seen = {};
  var results = [];

  function next(index) {
    if (index >= queries.length || results.length >= 30) {
      return Promise.resolve(results);
    }
    return searchDailymotion(queries[index]).then(function (videos) {
      videos.forEach(function (video) {
        if (!video.id || seen[video.id]) return;
        seen[video.id] = true;
        results.push(video);
      });
      return next(index + 1);
    });
  }

  return next(0);
}

function searchPreferredChannels(queries) {
  if (!PREFERRED_CHANNELS.length || !queries.length) {
    return Promise.resolve([]);
  }

  var limited = queries.slice(0, 3);
  var jobs = [];
  PREFERRED_CHANNELS.forEach(function (channel) {
    limited.forEach(function (query) {
      jobs.push(searchChannelVideos(channel, query));
    });
  });

  return Promise.all(jobs).then(function (groups) {
    var videos = [];
    groups.forEach(function (group) {
      videos = videos.concat(group);
    });
    return uniqueVideos(videos);
  });
}

function listPreferredChannelMatches(info, mediaType, season, episode) {
  if (!PREFERRED_CHANNELS.length) {
    return Promise.resolve([]);
  }

  return Promise.all(PREFERRED_CHANNELS.map(listChannelVideos)).then(function (groups) {
    var videos = [];
    groups.forEach(function (group) {
      videos = videos.concat(group);
    });
    return filterVideos(videos, info, mediaType, season, episode);
  });
}

function listChannelVideos(channel) {
  var cached = channelCatalogCache[channel];
  var now = Date.now();
  if (cached && now - cached.at < 10 * 60 * 1000) {
    return Promise.resolve(cached.videos);
  }

  var url =
    "https://api.dailymotion.com/user/" +
    encodeURIComponent(channel) +
    "/videos?fields=id,title,duration,url&limit=100&page=1&sort=recent";

  console.log("[Dailymotion] Listing channel " + channel);

  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      var videos = (data.list || []).map(function (video) {
        video.channel = channel;
        return video;
      });
      channelCatalogCache[channel] = { at: now, videos: videos };
      return videos;
    })
    .catch(function (error) {
      console.error("[Dailymotion] Channel list failed: " + (error && error.message));
      return [];
    });
}

function searchChannelVideos(channel, query) {
  var url =
    "https://api.dailymotion.com/user/" +
    encodeURIComponent(channel) +
    "/videos?search=" +
    encodeURIComponent(query) +
    "&fields=id,title,duration,url&limit=20&sort=relevance";

  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      return (data.list || []).map(function (video) {
        video.channel = channel;
        return video;
      });
    })
    .catch(function () {
      return [];
    });
}

function searchDailymotion(query) {
  var url =
    "https://api.dailymotion.com/videos?search=" +
    encodeURIComponent(query) +
    "&fields=id,title,duration,url,owner.username" +
    "&limit=20&sort=relevance";

  console.log("[Dailymotion] Search: " + query);

  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      return (data.list || []).map(function (video) {
        if (video["owner.username"] && !video.channel) {
          video.channel = video["owner.username"];
        }
        return video;
      });
    })
    .catch(function (error) {
      console.error("[Dailymotion] Search failed: " + (error && error.message));
      return [];
    });
}

function getVideoMetadata(videoId) {
  return warmSession().then(function (baseCookie) {
    return fetchWithTimeout(
      "https://www.dailymotion.com/player/metadata/video/" +
        videoId +
        "?app=com.dailymotion.neon",
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          Referer: "https://www.dailymotion.com/",
          Cookie: mergeCookies(baseCookie, "family_filter=off; ff=off"),
        },
      },
      PLAYLIST_TIMEOUT_MS
    )
      .then(function (response) {
        var cookie = mergeCookies(baseCookie, readSetCookies(response));
        return response.json().then(function (data) {
          return { data: data, cookie: cookie };
        });
      })
      .then(function (result) {
        var data = result.data;
        if (!data || data.error || !data.qualities) {
          var reason = data && data.error && (data.error.title || data.error.code);
          console.error(
            "[Dailymotion] metadata failed for " + videoId + (reason ? ": " + reason : "")
          );
          return null;
        }
        return {
          id: videoId,
          title: data.title || videoId,
          duration: data.duration || 0,
          qualities: data.qualities,
          channel: data.owner && data.owner.username ? data.owner.username : "",
          cookie: mergeCookies(result.cookie, "family_filter=off; ff=off"),
        };
      })
      .catch(function () {
        return null;
      });
  });
}

function filterVideos(videos, info, mediaType, season, episode) {
  var minDuration = mediaType === "tv" ? 480 : 2400;

  return videos.filter(function (video) {
    var title = String(video.title || "");
    var normalized = normalize(title);
    var duration = Number(video.duration) || 0;

    if (isJunkTitle(normalized)) return false;
    if (duration && duration < minDuration) return false;
    if (!titleMatches(title, info)) return false;

    if (mediaType === "tv" && season && episode) {
      var hasEpisode = episodeMatches(normalized, season, episode);
      var hasDate = info.airDate && dateMatches(normalized, info.airDate);
      if (!hasEpisode && !hasDate) return false;
      if (Number(season) > 1 && !seasonMatches(normalized, season) && !hasDate) {
        return false;
      }
    }

    if (mediaType !== "tv" && info.year && !yearMatches(title, info.year)) {
      return false;
    }

    return true;
  });
}

function streamsFromVideo(video) {
  if (video.qualities) {
    return resolveStreams(video);
  }
  return getVideoMetadata(video.id).then(function (full) {
    if (!full) return [];
    if (video.channel && !full.channel) full.channel = video.channel;
    return resolveStreams(full);
  });
}

function resolveStreams(video) {
  var base = extractDirectorStream(video);
  if (!base) return Promise.resolve([]);

  return resolvePlayableHls(base, video.cookie || "").then(function (resolved) {
    return resolved && resolved.length ? resolved : [base];
  });
}

function extractDirectorStream(video) {
  var qualities = video.qualities || {};
  var title = video.title || "Dailymotion";
  var channel = video.channel || "";
  var sourceName = channel ? "DM · " + channel : "Dailymotion";
  var headers = copyHeaders(PLAYBACK_HEADERS);
  if (video.cookie) headers.Cookie = video.cookie;

  var auto = qualities.auto || [];
  for (var i = 0; i < auto.length; i++) {
    var url = httpUrl(auto[i] && auto[i].url);
    if (!url) continue;
    var v1st = queryParam(url, "dmV1st");
    if (v1st) {
      headers.Cookie = mergeCookies(headers.Cookie || "", "v1st=" + v1st);
    }
    return {
      name: sourceName,
      title: title + " [Auto]",
      url: url,
      quality: "Auto",
      type: "hls",
      headers: headers,
    };
  }

  // Fallback: first available quality URL
  var labels = Object.keys(qualities);
  for (var j = 0; j < labels.length; j++) {
    var entries = qualities[labels[j]] || [];
    for (var k = 0; k < entries.length; k++) {
      var fallbackUrl = httpUrl(entries[k] && entries[k].url);
      if (!fallbackUrl) continue;
      return {
        name: sourceName,
        title: title + " [" + labels[j] + "]",
        url: fallbackUrl,
        quality: labels[j],
        type: fallbackUrl.indexOf(".m3u8") !== -1 ? "hls" : "mp4",
        headers: headers,
      };
    }
  }

  return null;
}

function resolvePlayableHls(stream, cookie) {
  var headers = copyHeaders(stream.headers || PLAYBACK_HEADERS);
  if (cookie) headers.Cookie = mergeCookies(headers.Cookie || "", cookie);

  return fetchWithTimeout(stream.url, { headers: headers }, PLAYLIST_TIMEOUT_MS)
    .then(function (response) {
      if (!response.ok) {
        throw new Error("playlist HTTP " + response.status);
      }
      return response.text();
    })
    .then(function (body) {
      if (!body || body.indexOf("#EXTM3U") !== 0) {
        throw new Error("invalid playlist");
      }
      if (body.indexOf("dmcdn.net") === -1) {
        throw new Error("playlist missing vod urls");
      }

      var cleaned = body.replace(/#cell=[^\s]+/g, "").trim() + "\n";
      return hostPlaylist(cleaned).then(function (hostedUrl) {
        if (!hostedUrl) {
          throw new Error("playlist host failed");
        }
        console.log("[Dailymotion] Hosted playable HLS for " + (stream.title || ""));
        return [
          {
            name: stream.name,
            title: String(stream.title || "Dailymotion").replace(" [Auto]", " [HLS]"),
            url: hostedUrl,
            quality: "HLS",
            type: "hls",
            headers: headers,
          },
        ];
      });
    })
    .catch(function (error) {
      console.error(
        "[Dailymotion] HLS resolve failed: " +
          (error && error.message ? error.message : error)
      );
      // Last resort: director URL (may 403 on some devices).
      return [stream];
    });
}

function hostPlaylist(playlistText) {
  var boundary = "----NuvioDM" + String(Date.now()) + "X";
  var body =
    "--" +
    boundary +
    "\r\n" +
    'Content-Disposition: form-data; name="reqtype"\r\n\r\n' +
    "fileupload\r\n" +
    "--" +
    boundary +
    "\r\n" +
    'Content-Disposition: form-data; name="fileToUpload"; filename="playlist.m3u8"\r\n' +
    "Content-Type: application/vnd.apple.mpegurl\r\n\r\n" +
    playlistText +
    "\r\n--" +
    boundary +
    "--\r\n";

  return fetchWithTimeout(
    "https://catbox.moe/user/api.php",
    {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "User-Agent": USER_AGENT,
      },
      body: body,
    },
    PLAYLIST_TIMEOUT_MS
  )
    .then(function (response) {
      return response.text();
    })
    .then(function (text) {
      var url = String(text || "").trim();
      if (url.indexOf("https://") === 0 && url.indexOf(".m3u8") !== -1) {
        return url;
      }
      return "";
    })
    .catch(function () {
      return "";
    });
}

function fetchWithTimeout(url, options, ms) {
  // QuickJS may not provide timers; plain fetch is fine then.
  if (typeof setTimeout !== "function") {
    return fetch(url, options || {});
  }

  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("timeout " + ms + "ms"));
    }, ms || PLAYLIST_TIMEOUT_MS);

    fetch(url, options || {})
      .then(function (response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      })
      .catch(function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function mapLimited(items, concurrency, worker) {
  var results = new Array(items.length);
  var index = 0;

  function next() {
    if (index >= items.length) {
      return Promise.resolve();
    }
    var current = index++;
    return Promise.resolve()
      .then(function () {
        return worker(items[current], current);
      })
      .then(function (value) {
        results[current] = value;
      })
      .catch(function () {
        results[current] = [];
      })
      .then(next);
  }

  var starters = [];
  var n = Math.min(concurrency || 2, items.length);
  for (var i = 0; i < n; i++) {
    starters.push(next());
  }

  if (!starters.length) {
    return Promise.resolve([]);
  }

  return Promise.all(starters).then(function () {
    return results;
  });
}

function sortVideos(videos) {
  var preferred = {};
  PREFERRED_CHANNELS.forEach(function (channel, index) {
    preferred[channel] = index;
  });

  return videos.slice().sort(function (a, b) {
    var aPref =
      preferred[a.channel] !== undefined ? preferred[a.channel] : PREFERRED_CHANNELS.length;
    var bPref =
      preferred[b.channel] !== undefined ? preferred[b.channel] : PREFERRED_CHANNELS.length;
    if (aPref !== bPref) return aPref - bPref;
    return (Number(b.duration) || 0) - (Number(a.duration) || 0);
  });
}

function mapKey(tmdbId, mediaType, season, episode) {
  return String(tmdbId) + ":" + mediaType + ":" + Number(season || 0) + ":" + Number(episode || 0);
}

function uniqueVideos(videos) {
  var seen = {};
  var result = [];
  videos.forEach(function (video) {
    if (!video || !video.id || seen[video.id]) return;
    seen[video.id] = true;
    result.push(video);
  });
  return result;
}

function isJunkTitle(normalized) {
  return (
    normalized.indexOf("trailer") !== -1 ||
    normalized.indexOf("трейлер") !== -1 ||
    normalized.indexOf("тизер") !== -1 ||
    normalized.indexOf("teaser") !== -1 ||
    normalized.indexOf("обзор") !== -1 ||
    normalized.indexOf("review") !== -1
  );
}

function titleMatches(rawTitle, info) {
  var videoTitle = normalize(rawTitle);
  var candidates = uniqueStrings([info.title, info.originalTitle]);

  for (var i = 0; i < candidates.length; i++) {
    var candidate = normalize(candidates[i]);
    if (!candidate) continue;
    if (videoTitle.indexOf(candidate) !== -1) {
      return true;
    }

    var tokens = significantTokens(candidates[i]);
    if (!tokens.length) continue;

    var hits = 0;
    tokens.forEach(function (token) {
      if (videoTitle.indexOf(token) !== -1) hits += 1;
    });
    if (hits === tokens.length || (tokens.length > 3 && hits >= tokens.length - 1)) {
      return true;
    }
  }

  return false;
}

function episodeMatches(normalizedTitle, season, episode) {
  var s = String(Number(season));
  var e = String(Number(episode));
  var paddedS = pad(season);
  var paddedE = pad(episode);
  var paddedTitle = " " + normalizedTitle + " ";
  var patterns = [
    " s" + paddedS + "e" + paddedE + " ",
    " " + s + "x" + paddedE + " ",
    " episodul " + e + " ",
    " episodul " + paddedE + " ",
    " episod " + e + " ",
    " episode " + e + " ",
    " epsiodul " + e + " ",
    " ep " + e + " ",
    " ep" + e + " ",
    " " + s + " sezon " + e + " серия ",
    " серия " + e + " ",
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (paddedTitle.indexOf(patterns[i]) !== -1) {
      return true;
    }
  }
  return false;
}

function seasonMatches(normalizedTitle, season) {
  var s = String(Number(season));
  var paddedTitle = " " + normalizedTitle + " ";
  return (
    paddedTitle.indexOf(" sezonul " + s + " ") !== -1 ||
    paddedTitle.indexOf(" season " + s + " ") !== -1 ||
    paddedTitle.indexOf(" s" + pad(season) + " ") !== -1 ||
    paddedTitle.indexOf(" s" + pad(season) + "e") !== -1
  );
}

function dateSearchText(airDate) {
  var parts = String(airDate).split("-");
  if (parts.length < 3) return "";
  var month = Number(parts[1]);
  var day = Number(parts[2]);
  if (!month || !day || !MONTHS_RO[month - 1]) return "";
  return day + " " + MONTHS_RO[month - 1];
}

function dateMatches(normalizedTitle, airDate) {
  var parts = String(airDate).split("-");
  if (parts.length < 3) return false;
  var year = parts[0];
  var month = Number(parts[1]);
  var day = Number(parts[2]);
  var paddedTitle = " " + normalizedTitle + " ";
  var patterns = [
    " " + day + " " + MONTHS_RO[month - 1] + " ",
    " " + pad(day) + " " + MONTHS_RO[month - 1] + " ",
    " " + day + " " + MONTHS_EN[month - 1] + " ",
    " " + pad(day) + " " + MONTHS_EN[month - 1] + " ",
    " " + day + " " + pad(month) + " " + year + " ",
    " " + pad(day) + " " + pad(month) + " " + year + " ",
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (paddedTitle.indexOf(patterns[i]) !== -1) {
      return true;
    }
  }
  return false;
}

function yearMatches(rawTitle, year) {
  var y = Number(year);
  if (!y) return true;
  return (
    rawTitle.indexOf(String(y)) !== -1 ||
    rawTitle.indexOf(String(y - 1)) !== -1 ||
    rawTitle.indexOf(String(y + 1)) !== -1
  );
}

function significantTokens(title) {
  return normalize(title)
    .split(" ")
    .filter(function (token) {
      return (
        token.length > 2 &&
        ["the", "and", "для", "temptation", "island"].indexOf(token) === -1
      );
    });
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ș/g, "s")
    .replace(/ț/g, "t")
    .replace(/ă/g, "a")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/[^a-z0-9а-я]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  var seen = {};
  var result = [];
  values.forEach(function (value) {
    if (!value || seen[value]) return;
    seen[value] = true;
    result.push(value);
  });
  return result;
}

function pad(value) {
  var text = String(value);
  return text.length === 1 ? "0" + text : text;
}

function httpUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (value.indexOf("http://") === 0 || value.indexOf("https://") === 0) return value;
  if (value.indexOf("//") === 0) return "https:" + value;
  return null;
}

function queryParam(url, key) {
  var match = String(url).match(new RegExp("[?&]" + key + "=([^&]+)"));
  return match ? decodeURIComponent(match[1]) : "";
}

function copyHeaders(source) {
  var out = {};
  if (!source) return out;
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
    }
  }
  return out;
}

function readSetCookies(response) {
  if (!response || !response.headers) return "";
  var list = [];
  try {
    if (typeof response.headers.getSetCookie === "function") {
      list = response.headers.getSetCookie() || [];
    } else if (typeof response.headers.get === "function") {
      var single = response.headers.get("set-cookie");
      if (single) list = [single];
    }
  } catch (e) {
    return "";
  }
  return list
    .map(function (item) {
      return String(item).split(";")[0];
    })
    .filter(Boolean)
    .join("; ");
}

function mergeCookies() {
  var map = {};
  for (var i = 0; i < arguments.length; i++) {
    String(arguments[i] || "")
      .split(";")
      .forEach(function (part) {
        var trimmed = part.trim();
        if (!trimmed || trimmed.indexOf("=") === -1) return;
        var key = trimmed.split("=")[0];
        map[key] = trimmed;
      });
  }
  return Object.keys(map)
    .map(function (key) {
      return map[key];
    })
    .join("; ");
}

module.exports = {
  getStreams: getStreams,
};
