/**
 * Nuvio Provider: VK Video
 * File: providers/vkvideo.js
 */

const VK_API_VERSION = "5.131";

function getStreams(tmdbId, mediaType, season, episode, title, year) {
  var searchQuery = encodeURIComponent((title || tmdbId) + " " + (year || ""));
  var searchUrl =
    "https://api.vk.com/method/video.search?q=" +
    searchQuery +
    "&auto_complete=1&sort=2&count=10&v=" +
    VK_API_VERSION;

  return fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (data) {
      if (!data.response || !data.response.items) {
        return [];
      }

      var streamPromises = data.response.items.map(function (item) {
        if (!item.player) return Promise.resolve([]);
        return extractVkStreamUrls(item.player).then(function (directUrls) {
          return directUrls.map(function (streamInfo) {
            return {
              name: "VK Video",
              title: item.title + " [" + streamInfo.quality + "]",
              url: streamInfo.url,
              quality: streamInfo.quality,
              type: streamInfo.isHls ? "hls" : "direct",
              headers: {
                Referer: "https://vk.com/",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              },
            };
          });
        });
      });

      return Promise.all(streamPromises).then(function (results) {
        return results.reduce(function (acc, val) {
          return acc.concat(val);
        }, []);
      });
    })
    .catch(function (err) {
      return [];
    });
}

function extractVkStreamUrls(playerUrl) {
  return fetch(playerUrl)
    .then(function (res) {
      return res.text();
    })
    .then(function (html) {
      var streams = [];
      var configMatch =
        html.match(/var\s+config\s*=\s*({.*?});/s) ||
        html.match(/al_video\.php.*?({.*?})/s);

      if (configMatch) {
        try {
          var config = JSON.parse(configMatch[1]);
          var params = config.params || [{}];
          var videoData = params[0] || {};

          if (videoData.hls) {
            streams.push({
              quality: "Auto (HLS)",
              url: videoData.hls,
              isHls: true,
            });
          }

          var qualities = ["1080", "720", "480", "360", "240"];
          qualities.forEach(function (q) {
            if (videoData["url" + q]) {
              streams.push({
                quality: q + "p",
                url: videoData["url" + q],
                isHls: false,
              });
            }
          });
        } catch (e) {}
      }
      return streams;
    })
    .catch(function () {
      return [];
    });
}

module.exports = {
  getStreams: getStreams,
};
