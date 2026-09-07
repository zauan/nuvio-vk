/**
 * Nuvio provider: VK Video
 * File: providers/vkvideo.js
 *
 * Hermes-safe: Promise chains only (no async/await).
 */

var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
var VK_CLIENT_ID = "52461373";
var VK_API_VERSION = "5.282";
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

var PLAYBACK_HEADERS = {
  Referer: "https://vkvideo.ru/",
  Origin: "https://vkvideo.ru",
  "User-Agent": USER_AGENT,
};

var cachedToken = null;
var tokenExpiresAt = 0;

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(
    "[VK Video] Fetching " + mediaType + " " + tmdbId +
      (season ? " S" + season + "E" + episode : "")
  );

  return getTmdbInfo(tmdbId, mediaType)
    .then(function (info) {
      return getAnonymousToken().then(function (token) {
        return { info: info, token: token };
      });
    })
    .then(function (ctx) {
      var queries = buildSearchQueries(ctx.info, mediaType, season, episode);
      return searchAllQueries(ctx.token, queries).then(function (videos) {
        return {
          info: ctx.info,
          token: ctx.token,
          videos: videos,
        };
      });
    })
    .then(function (ctx) {
      var matches = filterVideos(ctx.videos, ctx.info, mediaType, season, episode);
      console.log("[VK Video] Matched " + matches.length + " videos");
      return resolveMissingFiles(ctx.token, matches.slice(0, 3));
    })
    .then(function (videos) {
      var streams = [];
      videos.forEach(function (video) {
        streams = streams.concat(streamsFromVideo(video));
      });
      console.log("[VK Video] Returning " + streams.length + " streams");
      return streams;
    })
    .catch(function (error) {
      console.error("[VK Video] Error: " + (error && error.message ? error.message : error));
      return [];
    });
}

function getTmdbInfo(tmdbId, mediaType) {
  var endpoint = mediaType === "tv" ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" +
    endpoint +
    "/" +
    tmdbId +
    "?api_key=" +
    TMDB_API_KEY +
    "&language=ru-RU";

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

      console.log('[VK Video] TMDB: "' + (title || originalTitle) + '" (' + year + ")");
      return {
        title: title || originalTitle,
        originalTitle: originalTitle || title,
        year: year,
      };
    });
}

function getAnonymousToken() {
  var now = Date.now() / 1000;
  if (cachedToken && now + 60 < tokenExpiresAt) {
    return Promise.resolve(cachedToken);
  }

  return fetch("https://login.vk.com/?act=get_anonym_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json,*/*",
      Origin: "https://vkvideo.ru",
      Referer: "https://vkvideo.ru/",
      "User-Agent": USER_AGENT,
    },
    body: "client_id=" + VK_CLIENT_ID,
  })
    .then(function (response) {
      if (!response.ok) {
        throw new Error("VK token HTTP " + response.status);
      }
      return response.json();
    })
    .then(function (root) {
      var data = root && root.data ? root.data : {};
      var token = data.access_token;
      if (!token) {
        throw new Error("VK did not return an anonymous token");
      }
      cachedToken = token;
      tokenExpiresAt = data.expired_at || data.expires || now + 36000;
      return token;
    });
}

function buildSearchQueries(info, mediaType, season, episode) {
  var titles = uniqueStrings([info.title, info.originalTitle]);
  var queries = [];

  titles.forEach(function (title) {
    if (mediaType === "tv" && season && episode) {
      queries.push(title + " " + season + " сезон " + episode + " серия");
      queries.push(title + " s" + pad(season) + "e" + pad(episode));
    } else if (info.year) {
      queries.push(title + " " + info.year);
    } else {
      queries.push(title);
    }
  });

  return uniqueStrings(queries);
}

function searchAllQueries(token, queries) {
  var seen = {};
  var results = [];

  function next(index) {
    if (index >= queries.length || results.length >= 20) {
      return Promise.resolve(results);
    }
    return searchVk(token, queries[index]).then(function (videos) {
      videos.forEach(function (video) {
        var id = videoKey(video);
        if (id && !seen[id]) {
          seen[id] = true;
          results.push(video);
        }
      });
      return next(index + 1);
    });
  }

  return next(0);
}

function searchVk(token, query) {
  var url =
    "https://api.vkvideo.ru/method/catalog.getVideoSearchWeb2" +
    "?v=" +
    VK_API_VERSION +
    "&client_id=" +
    VK_CLIENT_ID +
    "&count=30" +
    "&content_type=video" +
    "&q=" +
    encodeURIComponent(query) +
    "&access_token=" +
    encodeURIComponent(token);

  console.log("[VK Video] Search: " + query);

  return fetch(url, {
    headers: vkApiHeaders(),
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (root) {
      if (root && root.error) {
        throw new Error(root.error.error_msg || "VK search failed");
      }
      var catalog = root && root.response && root.response.catalog_videos;
      if (!catalog || !catalog.length) {
        return [];
      }
      return catalog
        .map(function (item) {
          return item && item.video ? item.video : null;
        })
        .filter(Boolean);
    })
    .catch(function (error) {
      console.error("[VK Video] Search failed: " + (error && error.message));
      return [];
    });
}

function resolveMissingFiles(token, videos) {
  var jobs = videos.map(function (video) {
    if (hasPlayableFile(video.files)) {
      return Promise.resolve(video);
    }
    return getVideoById(token, videoKey(video)).then(function (full) {
      if (full && hasPlayableFile(full.files)) {
        return full;
      }
      return video;
    });
  });

  return Promise.all(jobs);
}

function getVideoById(token, videoId) {
  if (!videoId) {
    return Promise.resolve(null);
  }

  return fetch("https://api.vk.com/method/video.get?v=" + VK_API_VERSION + "&client_id=" + VK_CLIENT_ID, {
    method: "POST",
    headers: vkApiHeaders({
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }),
    body: "access_token=" + encodeURIComponent(token) + "&videos=" + encodeURIComponent(videoId),
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (root) {
      if (root && root.error) {
        console.error("[VK Video] video.get: " + root.error.error_msg);
        return null;
      }
      var items = root && root.response && root.response.items;
      return items && items[0] ? items[0] : null;
    })
    .catch(function () {
      return null;
    });
}

function filterVideos(videos, info, mediaType, season, episode) {
  var minDuration = mediaType === "tv" ? 480 : 2400;

  var filtered = videos.filter(function (video) {
    var title = String(video.title || "");
    var normalized = normalize(title);
    var duration = Number(video.duration) || 0;

    if (isJunkTitle(normalized)) {
      return false;
    }
    if (duration && duration < minDuration) {
      return false;
    }
    if (!titleMatches(title, info)) {
      return false;
    }
    if (mediaType === "tv" && season && episode && !episodeMatches(normalized, season, episode)) {
      return false;
    }
    if (mediaType !== "tv" && info.year && !yearMatches(normalized, title, info.year)) {
      return false;
    }
    return true;
  });

  if (filtered.length) {
    return filtered;
  }

  return videos.filter(function (video) {
    var title = String(video.title || "");
    var normalized = normalize(title);
    var duration = Number(video.duration) || 0;
    return !isJunkTitle(normalized) && duration >= minDuration && titleMatches(title, info);
  });
}

function streamsFromVideo(video) {
  var files = video.files || {};
  var streams = [];
  var title = video.title || "VK Video";
  var qualities = ["2160", "1440", "1080", "720", "480", "360"];

  qualities.forEach(function (quality) {
    var url = httpUrl(files["mp4_" + quality]);
    if (url) {
      streams.push(makeStream(title, quality + "p", url, "mp4"));
    }
  });

  var hls = httpUrl(files.hls) || httpUrl(files.hls_fmp4) || httpUrl(files.hls_streams);
  if (hls) {
    streams.push(makeStream(title, "Auto", hls, "hls"));
  }

  return streams;
}

function makeStream(videoTitle, quality, url, type) {
  return {
    name: "VK Video",
    title: videoTitle + " [" + quality + "]",
    url: url,
    quality: quality,
    type: type,
    headers: PLAYBACK_HEADERS,
  };
}

function vkApiHeaders(extra) {
  var headers = {
    Accept: "application/json,*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    Origin: "https://vkvideo.ru",
    Referer: "https://vkvideo.ru/",
    "User-Agent": USER_AGENT,
  };
  if (extra) {
    Object.keys(extra).forEach(function (key) {
      headers[key] = extra[key];
    });
  }
  return headers;
}

function hasPlayableFile(files) {
  if (!files) return false;
  if (httpUrl(files.hls) || httpUrl(files.hls_fmp4)) return true;
  var keys = Object.keys(files);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf("mp4_") === 0 && httpUrl(files[keys[i]])) {
      return true;
    }
  }
  return false;
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
    if (hits === tokens.length || hits >= Math.min(tokens.length, 2)) {
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
    " " + s + " сезон " + e + " серия ",
    " " + s + " сезон " + paddedE + " серия ",
    " сезон " + s + " серия " + e + " ",
    " сезон " + paddedS + " серия " + paddedE + " ",
    " серия " + e + " ",
    " серия " + paddedE + " ",
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (paddedTitle.indexOf(patterns[i]) !== -1) {
      return true;
    }
  }
  return false;
}

function yearMatches(normalizedTitle, rawTitle, year) {
  var y = Number(year);
  if (!y) return true;
  return (
    rawTitle.indexOf(String(y)) !== -1 ||
    rawTitle.indexOf(String(y - 1)) !== -1 ||
    rawTitle.indexOf(String(y + 1)) !== -1 ||
    normalizedTitle.indexOf(String(y)) !== -1
  );
}

function significantTokens(title) {
  return normalize(title)
    .split(" ")
    .filter(function (token) {
      return token.length > 2 && ["the", "and", "для"].indexOf(token) === -1;
    });
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
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

function videoKey(video) {
  if (!video || video.owner_id == null || video.id == null) return "";
  return String(video.owner_id) + "_" + String(video.id);
}

function httpUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (value.indexOf("http://") === 0 || value.indexOf("https://") === 0) return value;
  if (value.indexOf("//") === 0) return "https:" + value;
  return null;
}

module.exports = {
  getStreams: getStreams,
};
