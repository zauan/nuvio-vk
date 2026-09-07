/**
 * VK Video Provider for Nuvio (CloudStream Engine Compatible)
 */

const VK_API_VERSION = "5.131";

async function searchAndGetStreams(title, year) {
  const searchQuery = `${title} ${year || ""}`.trim();
  const searchUrl = `https://api.vk.com/method/video.search?q=${encodeURIComponent(searchQuery)}&auto_complete=1&sort=2&count=10&v=${VK_API_VERSION}`;

  try {
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const data = await response.json();
    if (!data.response || !data.response.items) return [];

    const streams = [];

    for (const item of data.response.items) {
      if (item.player) {
        const directUrls = await extractVkStreamUrls(item.player);
        for (const streamInfo of directUrls) {
          streams.push({
            name: "VK Video",
            title: `${item.title} [${streamInfo.quality}]`,
            url: streamInfo.url,
            quality: streamInfo.quality,
            isHls: streamInfo.isHls,
            headers: {
              Referer: "https://vk.com/",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          });
        }
      }
    }

    return streams;
  } catch (err) {
    console.error("VK Video Provider Error:", err);
    return [];
  }
}

async function extractVkStreamUrls(playerUrl) {
  try {
    const res = await fetch(playerUrl);
    const html = await res.text();
    const configMatch = html.match(/var\s+config\s*=\s*({.*?});/s);
    const streams = [];

    if (configMatch) {
      const config = JSON.parse(configMatch[1]);
      const videoData = (config.params && config.params[0]) || {};

      if (videoData.hls) {
        streams.push({
          quality: "Auto (HLS)",
          url: videoData.hls,
          isHls: true,
        });
      }

      ["1080", "720", "480", "360"].forEach((q) => {
        if (videoData[`url${q}`]) {
          streams.push({
            quality: `${q}p`,
            url: videoData[`url${q}`],
            isHls: false,
          });
        }
      });
    }

    return streams;
  } catch (e) {
    return [];
  }
}

// Export for Nuvio Local Scraper Engine
if (typeof module !== "undefined") {
  module.exports = { searchAndGetStreams };
}
