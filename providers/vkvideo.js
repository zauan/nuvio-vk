/**
 * Nuvio Provider: VK Video
 * File Path: providers/vkvideo.js
 */

const VK_API_VERSION = "5.131";

function getStreams(tmdbId, mediaType, season, episode, title, year) {
  const searchQuery = `${title || tmdbId} ${year || ""}`.trim();
  const searchUrl = `https://api.vk.com/method/video.search?q=${encodeURIComponent(
    searchQuery,
  )}&auto_complete=1&sort=2&count=10&v=${VK_API_VERSION}`;

  return fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  })
    .then((response) => response.json())
    .then((data) => {
      if (!data.response || !data.response.items) {
        return [];
      }

      const streamPromises = data.response.items.map((item) => {
        if (!item.player) return Promise.resolve([]);
        return extractVkStreamUrls(item.player).then((directUrls) => {
          return directUrls.map((streamInfo) => ({
            name: "VK Video",
            title: `${item.title} [${streamInfo.quality}]`,
            url: streamInfo.url,
            quality: streamInfo.quality,
            type: streamInfo.isHls ? "hls" : "direct",
            headers: {
              Referer: "https://vk.com/",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          }));
        });
      });

      return Promise.all(streamPromises).then((results) => results.flat());
    })
    .catch((error) => {
      console.error("[VK Video Error]:", error.message);
      return [];
    });
}

function extractVkStreamUrls(playerUrl) {
  return fetch(playerUrl)
    .then((res) => res.text())
    .then((html) => {
      const streams = [];
      const configMatch =
        html.match(/var\s+config\s*=\s*({.*?});/s) ||
        html.match(/al_video\.php.*?({.*?})/s);

      if (configMatch) {
        try {
          const config = JSON.parse(configMatch[1]);
          const params = config.params || [{}];
          const videoData = params[0] || {};

          if (videoData.hls) {
            streams.push({
              quality: "Auto (HLS)",
              url: videoData.hls,
              isHls: true,
            });
          }

          const qualities = ["1080", "720", "480", "360", "240"];
          qualities.forEach((q) => {
            if (videoData[`url${q}`]) {
              streams.push({
                quality: `${q}p`,
                url: videoData[`url${q}`],
                isHls: false,
              });
            }
          });
        } catch (e) {
          console.error("[VK Parse Error]:", e);
        }
      }
      return streams;
    })
    .catch(() => []);
}

module.exports = {
  getStreams,
};
