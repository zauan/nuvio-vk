/**
 * Nuvio Content Source Plugin: VK Video
 * ID: com.nuvio.vkvideo
 */

const VK_API_VERSION = '5.131';

export default {
  id: 'com.nuvio.vkvideo',
  name: 'VK Video',
  version: '1.0.0',
  description: 'Stream content directly from VK Video',
  icon: 'https://vk.com/favicon.ico',
  types: ['movie', 'series', 'anime'],

  /**
   * Search VK Video for matching content
   * @param {Object} query - The search query object containing title, year, season, episode
   */
  async getStreams(query) {
    const streams = [];
    const searchQuery = `${query.title} ${query.year || ''}`.trim();

    try {
      // 1. Search VK Video via open search endpoint or public scraper endpoint
      const searchUrl = `https://api.vk.com/method/video.search?q=${encodeURIComponent(
        searchQuery
      )}&auto_complete=1&sort=2&count=10&v=${VK_API_VERSION}`;

      // Note: For production use, you can pass an access token via headers or config
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      const data = await response.json();

      if (!data.response || !data.response.items) {
        return streams;
      }

      // 2. Iterate through found video items and convert to Nuvio stream format
      for (const item of data.response.items) {
        // Handle direct video player URLs or embedded HLS manifests
        if (item.player) {
          const directUrls = await this.extractVkStreamUrls(item.player);

          for (const streamInfo of directUrls) {
            streams.push({
              name: 'VK Video',
              title: `${item.title} [${streamInfo.quality}]`,
              url: streamInfo.url,
              quality: streamInfo.quality,
              type: streamInfo.isHls ? 'hls' : 'direct',
              headers: {
                'Referer': 'https://vk.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
          }
        }
      }
    } catch (error) {
      console.error('[VK Video Plugin Error]:', error);
    }

    return streams;
  },

  /**
   * Extract video source files/M3U8 from VK's iframe player
   * @param {string} playerUrl - The embed URL returned by VK API
   */
  async extractVkStreamUrls(playerUrl) {
    const streams = [];

    try {
      const res = await fetch(playerUrl);
      const html = await res.text();

      // Extract MP4 and HLS sources injected into the page JS state (var config = {...})
      const configMatch = html.match(/var\s+config\s*=\s*({.*?});/s) || html.match(/al_video\.php.*?({.*?})/s);

      if (configMatch) {
        const config = JSON.parse(configMatch[1]);
        const params = config.params || [{}];
        const videoData = params[0] || {};

        // 1. Check for HLS stream (m3u8)
        if (videoData.hls) {
          streams.push({
            quality: 'Auto (HLS)',
            url: videoData.hls,
            isHls: true
          });
        }

        // 2. Check for direct MP4 resolution links (url1080, url720, url480, etc.)
        const qualities = ['1080', '720', '480', '360', '240'];
        for (const q of qualities) {
          if (videoData[`url${q}`]) {
            streams.push({
              quality: `${q}p`,
              url: videoData[`url${q}`],
              isHls: false
            });
          }
        }
      }
    } catch (err) {
      console.error('[VK Video Extractor Error]:', err);
    }

    return streams;
  }
};
