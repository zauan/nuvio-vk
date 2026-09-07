/**
 * Nuvio provider: Dailymotion
 * File: providers/dailymotion.js
 *
 * Hermes-safe: Promise chains only (no async/await).
 */

var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

var PLAYBACK_HEADERS = {
  Referer: "https://www.dailymotion.com/",
  Origin: "https://www.dailymotion.com",
  "User-Agent": USER_AGENT,
  priority: "u=1, i",
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
  "329884:tv:1:1": ["xarl2pi", "xarlbya", "xarl8oa", "xarlcca"],
  "329884:tv:1:2": ["xatiixa", "xatoa4a", "xb29ztq", "xatofku"],
  "329884:tv:1:3": ["xavja42", "xavk1qe", "xb3dblm"],
  "329884:tv:1:4": ["xaxi3hi", "xaxij32", "xb18vky", "xb0uzt6"],
  "329884:tv:1:5": ["xazd6le", "xaze0iu", "xb0oueq"],
};

var PREFERRED_CHANNELS = ["moremusic"];
var MAX_VIDEOS = 20;
var channelCatalogCache = {};

function getStreams(tmdbId, mediaType, season, episode) {
  console.log(
    "[Dailymotion] Fetching " + mediaType + " " + tmdbId +
      (season ? " S" + season + "E" + episode : "")
  );

  return getTmdbInfo(tmdbId, mediaType, season, episode)
    .then(function (info) {
      var mappedIds = VIDEO_MAP[mapKey(tmdbId, mediaType, season, episode)] || [];
      var queries = buildSearchQueries(info, mediaType, season, episode);

      var mapped = Promise.all(mappedIds.map(getVideoMetadata)).then(function (videos) {
        return videos.filter(Boolean);
      });
      var fromChannels = listPreferredChannelMatches(info, mediaType, season, episode);
      var fromGlobal = searchAllQueries(queries).then(function (videos) {
        return filterVideos(videos, info, mediaType, season, episode);
      });

      return Promise.all([mapped, fromChannels, fromGlobal]).then(function (parts) {
        var combined = uniqueVideos(parts[0].concat(parts[1]).concat(parts[2])).slice(
          0,
          MAX_VIDEOS
        );
        console.log(
          "[Dailymotion] Matched " +
            combined.length +
            " videos (" +
            parts[0].length +
            " mapped, " +
            parts[1].length +
            " channel, " +
            parts[2].length +
            " search)"
        );
        return combined;
      });
    })
    .then(function (videos) {
      return Promise.all(videos.map(streamsFromVideo)).then(function (groups) {
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
      queries.push(title + " episodul " + episode);
      queries.push(title + " episode " + episode);
      queries.push(title + " s" + pad(season) + "e" + pad(episode));
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

  return uniqueStrings(queries);
}

function searchAllQueries(queries) {
  var seen = {};
  var results = [];

  function next(index) {
    if (index >= queries.length || results.length >= 40) {
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

  var videos = [];
  var page = 1;

  function next() {
    var url =
      "https://api.dailymotion.com/user/" +
      encodeURIComponent(channel) +
      "/videos?fields=id,title,duration,url&limit=100&page=" +
      page +
      "&sort=recent";

    console.log("[Dailymotion] Listing channel " + channel + " page " + page);

    return fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        (data.list || []).forEach(function (video) {
          video.channel = channel;
          videos.push(video);
        });
        if (data.has_more && page < 5) {
          page += 1;
          return next();
        }
        channelCatalogCache[channel] = { at: now, videos: videos };
        return videos;
      })
      .catch(function (error) {
        console.error(
          "[Dailymotion] Channel list failed: " + (error && error.message)
        );
        return videos;
      });
  }

  return next();
}

function searchDailymotion(query) {
  var url =
    "https://api.dailymotion.com/videos?search=" +
    encodeURIComponent(query) +
    "&fields=id,title,duration,url" +
    "&limit=30&sort=relevance";

  console.log("[Dailymotion] Search: " + query);

  return fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      return data.list || [];
    })
    .catch(function (error) {
      console.error("[Dailymotion] Search failed: " + (error && error.message));
      return [];
    });
}

function getVideoMetadata(videoId) {
  return fetch("https://www.dailymotion.com/player/metadata/video/" + videoId + "?app=com.dailymotion.neon", {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Referer: "https://www.dailymotion.com/",
    },
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      if (!data || data.error || !data.qualities) {
        var reason = data && data.error && (data.error.title || data.error.code);
        console.error("[Dailymotion] metadata failed for " + videoId + (reason ? ": " + reason : ""));
        return null;
      }
      return {
        id: videoId,
        title: data.title || videoId,
        duration: data.duration || 0,
        qualities: data.qualities,
        channel: data.owner && data.owner.username ? data.owner.username : "",
      };
    })
    .catch(function () {
      return null;
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
    return Promise.resolve(extractStreams(video));
  }
  return getVideoMetadata(video.id).then(function (full) {
    if (!full) return [];
    if (video.channel && !full.channel) full.channel = video.channel;
    return extractStreams(full);
  });
}

function extractStreams(video) {
  var streams = [];
  var qualities = video.qualities || {};
  var title = video.title || "Dailymotion";
  var channel = video.channel || "";
  var sourceName = channel ? "DM · " + channel : "Dailymotion";
  var seen = {};

  Object.keys(qualities).forEach(function (label) {
    var entries = qualities[label] || [];
    entries.forEach(function (entry) {
      var url = httpUrl(entry && entry.url);
      if (!url || seen[url]) return;
      seen[url] = true;

      var type = entry.type === "application/x-mpegURL" || url.indexOf(".m3u8") !== -1 ? "hls" : "mp4";
      var quality = label === "auto" ? "Auto" : /p$/.test(label) ? label : label + "p";
      streams.push({
        name: sourceName,
        title: title + " [" + quality + "]",
        url: url,
        quality: quality,
        type: type,
        headers: PLAYBACK_HEADERS,
      });
    });
  });

  return streams;
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
      return token.length > 2 && ["the", "and", "для"].indexOf(token) === -1;
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

module.exports = {
  getStreams: getStreams,
};
